//! Real command entry points with argument-safe dispatch, independent of Tauri.
use std::process::{Command, exit};

fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let executable = std::env::current_exe()?;
    let directory = executable.parent().ok_or("Missing command directory")?;
    let name = executable
        .file_stem()
        .ok_or("Missing command name")?
        .to_string_lossy();
    let name = if cfg!(windows) {
        name.to_ascii_lowercase()
    } else {
        name.into_owned()
    };
    let individual = directory.join(format!("{name}.aixand-command.json"));
    let descriptor = if individual.is_file() {
        individual
    } else {
        directory.join("commands.json")
    };
    let source: serde_json::Value = serde_json::from_slice(&std::fs::read(descriptor)?)?;
    let root = source["root"]
        .as_str()
        .map(|value| directory.join(value))
        .unwrap_or_else(|| directory.join(".."));
    let entry = &source["commands"][name.as_str()];
    let program = entry["program"]
        .as_str()
        .ok_or("Command is not installed")?;
    let mut command = Command::new(root.join(program));
    for value in entry["args"]
        .as_array()
        .ok_or("Missing command arguments")?
    {
        let value = value.as_str().ok_or("Invalid command argument")?;
        if let Some(path) = value.strip_prefix("@root/") {
            command.arg(root.join(path));
        } else {
            command.arg(value);
        }
    }
    command.args(std::env::args_os().skip(1));
    if cfg!(windows) {
        command
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8");
    }
    if let Some(home) = entry["pythonHome"].as_str() {
        command.env("PYTHONHOME", root.join(home));
    }
    // Embedded Python's native DLL and its extension dependencies are bundled.
    let mut paths = vec![
        root.join("python"),
        root.join("bin"),
        root.join("node"),
        root.join("git/cmd"),
    ];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    command.env("PATH", std::env::join_paths(paths)?);
    let status = command.status()?;
    Ok(status.code().unwrap_or(1))
}

fn main() {
    match run() {
        Ok(code) => exit(code),
        Err(error) => {
            eprintln!("{error}");
            exit(1);
        }
    }
}
