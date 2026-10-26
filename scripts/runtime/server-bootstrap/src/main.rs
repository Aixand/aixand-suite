//! Console-only bootstrap: verify and unpack the exact embedded runtime, then
//! run its shared installer adapter. No system Node/Python or desktop is needed.
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Cursor, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    process::{Command, ExitCode},
    time::{SystemTime, UNIX_EPOCH},
};
include!(concat!(env!("OUT_DIR"), "/payload.rs"));

const MAGIC: &[u8; 16] = b"AIXAND-SERVER-1\0";
const FOOTER: u64 = 56;

fn remove_owned(path: &Path) -> std::io::Result<()> {
    let info = fs::symlink_metadata(path)?;
    if info.file_type().is_symlink() {
        return fs::remove_file(path);
    }
    if info.is_dir() {
        for item in fs::read_dir(path)? {
            remove_owned(&item?.path())?;
        }
        fs::remove_dir(path)
    } else {
        #[cfg(windows)]
        if info.permissions().readonly() {
            let mut permissions = info.permissions();
            permissions.set_readonly(false);
            fs::set_permissions(path, permissions)?;
        }
        fs::remove_file(path)
    }
}

struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        if let Err(error) = remove_owned(&self.0) {
            eprintln!(
                "Installer temporary files retained at {}: {error}",
                self.0.display()
            );
        }
    }
}

fn temporary() -> Result<Temporary, Box<dyn std::error::Error>> {
    let instant = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let path = std::env::temp_dir().join(format!(
        "aixand-server-setup-{}-{instant}",
        std::process::id()
    ));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&path)?;
    Ok(Temporary(path))
}

fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() == 1 && arguments[0] == "--version" {
        println!("0.1.0-beta");
        return Ok(0);
    }
    if arguments.len() == 1 && arguments[0] == "--help" {
        println!(
            "Aixand Server Setup: install | update | repair | reset | uninstall [--directory PATH] [--configure-later] [--yes] [--accept-license SHA256]"
        );
        return Ok(0);
    }
    let executable = std::env::current_exe()?;
    println!("Verifying Aixand Server installer…");
    let payload: Box<dyn Read> = if !EMBEDDED_PAYLOAD.is_empty() {
        if EMBEDDED_PAYLOAD.len() as u64 > 8 * 1024 * 1024 * 1024 {
            return Err("Installer payload exceeds size limit".into());
        }
        if Sha256::digest(EMBEDDED_PAYLOAD).as_slice() != EMBEDDED_SHA256 {
            return Err("Installer payload checksum failed".into());
        }
        Box::new(Cursor::new(EMBEDDED_PAYLOAD))
    } else {
        // Unsigned development stubs also accept a checked appended fixture. Public
        // packages embed bytes in their native image so code signing covers them.
        let mut input = File::open(&executable)?;
        let total = input.metadata()?.len();
        if total < FOOTER {
            return Err("Installer payload is missing".into());
        }
        input.seek(SeekFrom::End(-(FOOTER as i64)))?;
        let mut footer = [0u8; FOOTER as usize];
        input.read_exact(&mut footer)?;
        if &footer[..16] != MAGIC {
            return Err("Installer payload footer is invalid".into());
        }
        let length = u64::from_le_bytes(footer[16..24].try_into()?);
        if length == 0 || length > 8 * 1024 * 1024 * 1024 || length > total - FOOTER {
            return Err("Invalid installer payload length".into());
        }
        let offset = total - FOOTER - length;
        input.seek(SeekFrom::Start(offset))?;
        let mut hasher = Sha256::new();
        let mut remaining = length;
        let mut buffer = [0u8; 1024 * 1024];
        while remaining > 0 {
            let count = input.read(&mut buffer[..remaining.min(1024 * 1024) as usize])?;
            if count == 0 {
                return Err("Installer payload was truncated".into());
            }
            hasher.update(&buffer[..count]);
            remaining -= count as u64;
        }
        if hasher.finalize().as_slice() != &footer[24..] {
            return Err("Installer payload checksum failed".into());
        }
        input.seek(SeekFrom::Start(offset))?;
        Box::new(input.take(length))
    };
    let stage = temporary()?;
    println!("Preparing the terminal installer…");
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(payload));
    let mut bytes = 0u64;
    for (index, entry) in archive.entries()?.enumerate() {
        if index > 150_000 {
            return Err("Too many installer files".into());
        }
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        if path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
            || !path.starts_with("runtime")
        {
            return Err("Installer path escapes its runtime".into());
        }
        if !(entry.header().entry_type().is_file() || entry.header().entry_type().is_dir()) {
            return Err("Installer payload contains a link or special file".into());
        }
        bytes += entry.header().size()?;
        if bytes > 32 * 1024 * 1024 * 1024 {
            return Err("Installer payload exceeds extraction limit".into());
        }
        if !entry.unpack_in(&stage.0)? {
            return Err("Installer entry could not be unpacked safely".into());
        }
    }
    let runtime = stage.0.join("runtime");
    let node = runtime.join(if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/bin/node"
    });
    #[cfg(unix)]
    {
        let restored = Command::new(&node)
            .arg(runtime.join("restore-links.mjs"))
            .arg(&runtime)
            .status()?;
        if !restored.success() {
            return Err("Runtime links could not be restored".into());
        }
    }
    let status = Command::new(node)
        .arg(runtime.join("server-installer.mjs"))
        .args(arguments)
        .env("AIXAND_SERVER_INSTALLER", executable)
        .status()?;
    Ok(status.code().unwrap_or(1))
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code as u8),
        Err(error) => {
            eprintln!("Aixand Server setup: {error}");
            ExitCode::FAILURE
        }
    }
}
