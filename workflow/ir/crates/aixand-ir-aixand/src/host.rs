//! Process-wide CPython initialization for trusted embedded hosts.
#![allow(unsafe_code)]

use aixand_ir_runner::Failure;
use pyo3::{ffi, prelude::*};
use serde::{Deserialize, Serialize};
use std::{ffi::CStr, path::PathBuf, sync::Mutex};

/// Installation paths supplied by the host, never by portable IR. The Python
/// home must match the CPython library linked into the host binary.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PythonInterpreter {
    pub executable: PathBuf,
    /// Base/stdlib home matching the linked CPython library.
    pub home: PathBuf,
    /// Selected environment's sys.prefix; omitted for standalone Python.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<PathBuf>,
    /// Selected environment's sys._base_executable (distinct for venv launchers).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_executable: Option<PathBuf>,
}

static INITIALIZE: Mutex<()> = Mutex::new(());

fn error(message: impl Into<String>) -> Failure {
    Failure::new("python_interpreter", message)
}

impl PythonInterpreter {
    fn prefix(&self) -> &std::path::Path {
        self.prefix.as_deref().unwrap_or(&self.home)
    }

    fn base_executable(&self) -> &std::path::Path {
        self.base_executable.as_deref().unwrap_or(&self.executable)
    }

    fn validate(&self) -> Result<(), Failure> {
        if [
            self.executable.as_path(),
            self.home.as_path(),
            self.prefix(),
            self.base_executable(),
        ]
        .iter()
        .any(|path| !path.is_absolute())
        {
            return Err(error("Python interpreter settings must be absolute paths"));
        }
        let home = self.home.canonicalize().map_err(|e| error(e.to_string()))?;
        let prefix = self
            .prefix()
            .canonicalize()
            .map_err(|e| error(e.to_string()))?;
        let base = self
            .base_executable()
            .canonicalize()
            .map_err(|e| error(e.to_string()))?;
        let executable = self
            .executable
            .canonicalize()
            .map_err(|e| error(e.to_string()))?;
        let location = self
            .executable
            .parent()
            .ok_or_else(|| error("Missing executable directory"))?
            .canonicalize()
            .map_err(|e| error(e.to_string()))?;
        // Unix venv executables may symlink into the base home; Windows/copied
        // venv launchers live in the declared environment. Both are trusted host
        // identities, not paths inferred from the host or workflow inputs.
        if !home.is_dir()
            || !prefix.is_dir()
            || !executable.is_file()
            || !base.is_file()
            || !base.starts_with(&home)
            || !(executable.starts_with(&home) || executable.starts_with(&prefix))
            || !(location.starts_with(&prefix) || executable.starts_with(&prefix))
        {
            return Err(error(
                "Python executable must belong to its prefix and base executable to its home",
            ));
        }
        Ok(())
    }

    fn verify(&self) -> Result<(), Failure> {
        Python::attach(|py| -> PyResult<bool> {
            let sys = py.import("sys")?;
            let executable = self.executable.canonicalize()?;
            let home = self.home.canonicalize()?;
            let prefix = self.prefix().canonicalize()?;
            let base = self.base_executable().canonicalize()?;
            for (name, expected) in [
                ("executable", &executable),
                ("_base_executable", &base),
                ("prefix", &prefix),
                ("base_prefix", &home),
            ] {
                let actual: PathBuf = sys.getattr(name)?.extract()?;
                if actual.canonicalize()? != *expected {
                    return Ok(false);
                }
            }
            Ok(true)
        })
        .map_err(|e| error(e.to_string()))?
        .then_some(())
        .ok_or_else(|| error("Python is already initialized with a different executable or home"))
    }
}

/// Hosts must call this before starting any other Python users. The mutex
/// serializes SDK scopes; it cannot coordinate an unrelated embedder's C API.
pub(crate) fn initialize(settings: Option<&PythonInterpreter>) -> Result<(), Failure> {
    let _lock = INITIALIZE
        .lock()
        .map_err(|_| error("Python initialization lock poisoned"))?;
    let Some(settings) = settings else {
        // Preserve the existing PyO3 behavior for callers without host settings.
        Python::initialize();
        return Ok(());
    };
    settings.validate()?;
    // SAFETY: host entrypoints invoke this before other Python users, and SDK
    // callers are serialized above. CPython permits this query without the GIL.
    if unsafe { ffi::Py_IsInitialized() } == 0 {
        initialize_configured(settings)?;
    }
    // Do not hold our mutex while attaching to the GIL: an existing-connection
    // caller may already hold the GIL when it enters another SDK scope.
    drop(_lock);
    // Reuse is allowed only for the same interpreter. Never patch sys fields
    // per scope: subprocess creation can run concurrently in another scope.
    settings.verify()
}

struct Configuration(ffi::PyConfig);
impl Drop for Configuration {
    fn drop(&mut self) {
        // SAFETY: this owned configuration was initialized by CPython; Clear
        // releases its copied strings and does not require the interpreter GIL.
        unsafe { ffi::PyConfig_Clear(&mut self.0) };
    }
}

fn status(status: ffi::PyStatus) -> Result<(), Failure> {
    // SAFETY: PyStatus is returned by CPython. Its error string, when non-null,
    // remains valid until the configuration is cleared by our caller.
    unsafe {
        if ffi::PyStatus_Exception(status) == 0 {
            return Ok(());
        }
        let message = if status.err_msg.is_null() {
            format!(
                "CPython initialization exited with status {}",
                status.exitcode
            )
        } else {
            CStr::from_ptr(status.err_msg)
                .to_string_lossy()
                .into_owned()
        };
        Err(error(message))
    }
}

fn initialize_configured(settings: &PythonInterpreter) -> Result<(), Failure> {
    // SAFETY: PyConfig_InitIsolatedConfig initializes every field before use.
    // Config string setters copy the supplied terminated strings. This function
    // is called once under INITIALIZE, before the host has any Python users.
    // On success InitializeFromConfig holds the GIL; SaveThread releases it for
    // subsequent PyO3 attachments. We do not finalize a process-owned interpreter.
    unsafe {
        let mut raw = std::mem::MaybeUninit::<ffi::PyConfig>::uninit();
        ffi::PyConfig_InitIsolatedConfig(raw.as_mut_ptr());
        let mut config = Configuration(raw.assume_init());
        config.0.install_signal_handlers = 0;
        config.0.parse_argv = 0;
        // Isolated mode ignores PYTHONDONTWRITEBYTECODE. Software inventories
        // remain immutable even when the host has write access to its bundle.
        config.0.write_bytecode = 0;
        let raw = &raw mut config.0;
        set_path(raw, &raw mut (*raw).program_name, &settings.executable)?;
        set_path(raw, &raw mut (*raw).executable, &settings.executable)?;
        set_path(
            raw,
            &raw mut (*raw).base_executable,
            settings.base_executable(),
        )?;
        set_path(raw, &raw mut (*raw).home, &settings.home)?;
        status(ffi::Py_InitializeFromConfig(&config.0))?;
        drop(config);
        ffi::PyEval_SaveThread();
    }
    Ok(())
}

// Use native path encoding on each platform, including non-ASCII installations.
#[cfg(unix)]
unsafe fn set_path(
    config: *mut ffi::PyConfig,
    field: *mut *mut std::ffi::c_int,
    path: &std::path::Path,
) -> Result<(), Failure> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let value = CString::new(path.as_os_str().as_bytes()).map_err(|e| error(e.to_string()))?;
    // SAFETY: caller provides a live config and one of its string fields.
    status(unsafe { ffi::PyConfig_SetBytesString(config, field, value.as_ptr()) })
}

#[cfg(windows)]
unsafe fn set_path(
    config: *mut ffi::PyConfig,
    field: *mut *mut u16,
    path: &std::path::Path,
) -> Result<(), Failure> {
    use std::os::windows::ffi::OsStrExt;
    let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) {
        return Err(error("Python path contains NUL"));
    }
    value.push(0);
    // SAFETY: caller provides a live config/field; value is terminated UTF-16.
    status(unsafe { ffi::PyConfig_SetString(config, field, value.as_ptr()) })
}
