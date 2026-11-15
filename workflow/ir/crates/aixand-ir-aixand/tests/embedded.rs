//! Each case initializes Python in a separate OS process, like an embedded host.
use aixand_ir_aixand::Config;
use pyo3::{prelude::*, types::PyModule};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

fn same_path(actual: &Value, expected: &Value) {
    assert_eq!(
        Path::new(actual.as_str().unwrap()).canonicalize().unwrap(),
        Path::new(expected.as_str().unwrap())
            .canonicalize()
            .unwrap()
    );
}

#[test]
fn embedded_host_child() {
    let Ok(mode) = std::env::var("AIXAND_EMBEDDED_CHILD") else {
        return;
    };
    let executable = std::env::var("AIXAND_EMBEDDED_TEST_PYTHON").unwrap();
    let home = std::env::var("AIXAND_EMBEDDED_TEST_HOME").unwrap();
    let configured: Value = std::env::var("AIXAND_EMBEDDED_TEST_CONFIG")
        .map(|s| serde_json::from_str(&s).unwrap())
        .unwrap_or_else(|_| json!({"python_interpreter":{"executable":executable,"home":home}}));
    let identity = &configured["python_interpreter"];
    let config: Config = serde_json::from_value(configured.clone()).unwrap();
    if mode == "legacy" {
        Config::default().initialize_python().unwrap();
    } else if mode == "invalid" {
        for invalid in [
            json!({"executable":"relative","home":home}),
            json!({"executable":std::env::current_exe().unwrap(),"home":home}),
            json!({"executable":executable,"home":"/missing-python-home"}),
            json!({"executable":executable,"home":home,"prefix":"relative"}),
            json!({"executable":executable,"home":home,"base_executable":std::env::current_exe().unwrap()}),
        ] {
            let config: Config =
                serde_json::from_value(json!({"python_interpreter":invalid})).unwrap();
            assert_eq!(
                config.initialize_python().unwrap_err().code,
                "python_interpreter"
            );
        }
        return;
    } else {
        config.initialize_python().unwrap();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let config = config.clone();
                std::thread::spawn(move || config.initialize_python().unwrap())
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        for key in ["home", "prefix"] {
            let mut conflict = configured.clone();
            conflict["python_interpreter"][key] = json!(PathBuf::from(&home).parent().unwrap());
            let conflict: Config = serde_json::from_value(conflict).unwrap();
            assert_eq!(
                conflict.initialize_python().unwrap_err().code,
                "python_interpreter"
            );
        }
        if let Ok(other) = std::env::var("AIXAND_EMBEDDED_TEST_CONFLICT") {
            let conflict: Config = serde_json::from_str(&other).unwrap();
            assert_eq!(
                conflict.initialize_python().unwrap_err().code,
                "python_interpreter"
            );
        }
        // Omitted settings and conflicting scopes cannot rewrite this interpreter.
        Config::default().initialize_python().unwrap();
        config.initialize_python().unwrap();
    }
    let result: Value = Python::attach(|py| {
        let module = PyModule::from_code(
            py,
            &std::ffi::CString::new(include_str!("embedded_child.py")).unwrap(),
            c"embedded_child.py",
            c"embedded_child",
        )
        .unwrap();
        let serialized: String = py
            .import("json")
            .unwrap()
            .call_method1("dumps", (module.getattr("result").unwrap(),))
            .unwrap()
            .extract()
            .unwrap();
        serde_json::from_str(&serialized).unwrap()
    });
    println!("EMBEDDED_RESULT={result}");
    if mode == "legacy" {
        assert_eq!(
            config.initialize_python().unwrap_err().code,
            "python_interpreter"
        );
        assert_ne!(result["exit"], 0);
        assert_ne!(
            PathBuf::from(result["identity"]["executable"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            PathBuf::from(&executable).canonicalize().unwrap()
        );
    } else {
        assert_eq!(result["exit"], 0, "{result}");
        assert_eq!(result["identity"]["write_bytecode"], false);
        let prefix = identity.get("prefix").unwrap_or(&identity["home"]);
        let base = identity
            .get("base_executable")
            .unwrap_or(&identity["executable"]);
        for (key, expected) in [
            ("executable", &identity["executable"]),
            ("program_name", &identity["executable"]),
            ("base_executable", base),
            ("prefix", prefix),
            ("base_prefix", &identity["home"]),
        ] {
            same_path(&result["identity"][key], expected);
        }
        let child: Value = serde_json::from_str(result["stdout"].as_str().unwrap()).unwrap();
        assert_eq!(child["module"]["module_launched"], true);
        for (key, expected) in [
            ("executable", &identity["executable"]),
            ("base_executable", base),
            ("prefix", prefix),
            ("base_prefix", &identity["home"]),
        ] {
            same_path(&child[key], expected);
        }
        if std::env::var("AIXAND_EMBEDDED_TEST_SDK").as_deref() == Ok("1") {
            assert_eq!(result["identity"]["sdk_imported"], true);
            assert_eq!(child["sdk_imported"], true);
        }
        if let Ok(fixture) = std::env::var("AIXAND_EMBEDDED_TEST_FIXTURE") {
            assert_eq!(result["identity"]["environment_fixture"], fixture);
            assert_eq!(child["environment_fixture"], fixture);
        }
    }
}

fn child(mode: &str, settings: Option<&Value>, other: Option<&Value>) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.env(
        "AIXAND_EMBEDDED_HOST_BINARY",
        std::env::current_exe().unwrap(),
    );
    #[cfg(unix)]
    command.env("PATH", "/usr/bin:/bin");
    if let Some(settings) = settings {
        command
            .env("AIXAND_EMBEDDED_TEST_CONFIG", settings.to_string())
            .env(
                "AIXAND_EMBEDDED_TEST_PYTHON",
                settings["python_interpreter"]["executable"]
                    .as_str()
                    .unwrap(),
            )
            .env(
                "AIXAND_EMBEDDED_TEST_HOME",
                settings["python_interpreter"]["home"].as_str().unwrap(),
            )
            .env(
                "AIXAND_EMBEDDED_TEST_FIXTURE",
                settings["python_interpreter"]["prefix"].as_str().unwrap(),
            );
    }
    if let Some(other) = other {
        command.env("AIXAND_EMBEDDED_TEST_CONFLICT", other.to_string());
    }
    let output = command
        .args(["--exact", "embedded_host_child", "--nocapture"])
        .env("AIXAND_EMBEDDED_CHILD", mode)
        .output()
        .unwrap();
    println!("{mode}: {}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn venv(base: &str, path: &Path, copies: bool) -> Value {
    let output = Command::new(base)
        .args([
            "-I",
            "-B",
            "-m",
            "venv",
            "--without-pip",
            "--system-site-packages",
            if copies { "--copies" } else { "--symlinks" },
        ])
        .arg(path)
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("VIRTUAL_ENV")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let executable = path.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python3"
    });
    let output = Command::new(&executable).args(["-I", "-B", "-c",
        "import json,sys,site;print(json.dumps(dict(python_interpreter=dict(executable=sys.executable,home=sys.base_prefix,prefix=sys.prefix,base_executable=sys._base_executable),python_paths=site.getsitepackages())))"])
        .env_remove("PYTHONHOME").env_remove("PYTHONPATH").env_remove("VIRTUAL_ENV").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let settings: Value = serde_json::from_slice(&output.stdout).unwrap();
    let prefix = Path::new(settings["python_interpreter"]["prefix"].as_str().unwrap())
        .canonicalize()
        .unwrap();
    let site = settings["python_paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| PathBuf::from(p.as_str().unwrap()))
        .find(|p| p.canonicalize().is_ok_and(|p| p.starts_with(&prefix)))
        .unwrap();
    std::fs::write(
        site.join("embedded_environment_fixture.py"),
        format!(
            "identity = {}\n",
            serde_json::to_string(prefix.to_str().unwrap()).unwrap()
        ),
    )
    .unwrap();
    println!("VENV_SETTINGS={settings}");
    settings
}

#[test]
#[ignore = "requires private AIXAND_EMBEDDED_TEST_PYTHON/HOME/WORK; optional SDK=1"]
fn configured_host_launches_real_python_module() {
    let base =
        std::env::var("AIXAND_EMBEDDED_TEST_PYTHON").expect("private bundled Python required");
    let work = PathBuf::from(
        std::env::var("AIXAND_EMBEDDED_TEST_WORK").expect("fresh private work directory required"),
    );
    std::fs::create_dir_all(&work).unwrap();
    for mode in ["legacy", "invalid", "configured"] {
        child(mode, None, None);
    }
    let first = venv(&base, &work.join("symlink-a"), false);
    let second = venv(&base, &work.join("symlink-b"), false);
    #[cfg(unix)]
    same_path(
        &first["python_interpreter"]["executable"],
        &second["python_interpreter"]["executable"],
    );
    child("configured", Some(&first), Some(&second));
    let copied = venv(&base, &work.join("copied"), true);
    #[cfg(unix)]
    assert_ne!(
        Path::new(copied["python_interpreter"]["executable"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        Path::new(
            copied["python_interpreter"]["base_executable"]
                .as_str()
                .unwrap()
        )
        .canonicalize()
        .unwrap()
    );
    child("configured", Some(&copied), Some(&first));
}
