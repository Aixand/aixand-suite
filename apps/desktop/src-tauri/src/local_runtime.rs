use std::path::PathBuf;
use tauri::Manager;

#[derive(serde::Serialize)]
pub struct Info {
    pub available: bool,
    pub address: String,
}

fn node(root: &std::path::Path) -> PathBuf {
    root.join(if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/bin/node"
    })
}

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if !cfg!(any(
        target_os = "linux",
        target_os = "windows",
        target_os = "macos"
    )) {
        return Err("The local runtime is unavailable on this operating system.".into());
    }
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| "Cannot locate the installed runtime.".to_string())?
        .join("runtime");
    if !root.join("manifest.json").is_file() || !node(&root).is_file() {
        return Err("This desktop package does not include a local runtime.".into());
    }
    Ok(root)
}

pub fn info(app: &tauri::AppHandle) -> Result<Info, String> {
    let port = std::env::var("AIXAND_LOCAL_PORT").unwrap_or_else(|_| "8753".into());
    let port: u16 = port
        .parse()
        .map_err(|_| "Invalid local workspace port.".to_string())?;
    if port < 1024 {
        return Err("The local workspace port must be at least 1024.".into());
    }
    Ok(Info {
        available: directory(app).is_ok(),
        address: format!("http://127.0.0.1:{port}/"),
    })
}

pub async fn start(app: &tauri::AppHandle) -> Result<String, String> {
    let setup = command(app, vec!["setup".into(), "info".into()]).await?;
    let address = info(app)?.address;
    let url = crate::connections::server_url(&address)?;
    let client = crate::connections::http_client(&url)?;
    if let Ok(Some(workspace)) = crate::connections::probe(&client, &url).await {
        if setup["workspaceId"].as_str() == Some(workspace.as_str()) {
            return Ok(address);
        }
        return Err("Another Aixand workspace uses this port. Connect through Server, or choose separate workspace ports.".into());
    }
    let value = command(app, vec!["start".into()]).await?;
    if value["running"] != true {
        return Err("Local services are not ready yet.".into());
    }
    value["address"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "The local runtime did not return its address.".into())
}

pub async fn setup(
    app: &tauri::AppHandle,
    action: String,
    options: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if action == "stop" {
        return command(app, vec!["stop".into()]).await;
    }
    if !["info", "check", "save", "install", "discover", "choose"].contains(&action.as_str()) {
        return Err("Unknown local setup action.".into());
    }
    command(app, vec!["setup".into(), action, options.to_string()]).await
}

pub async fn command(
    app: &tauri::AppHandle,
    args: Vec<String>,
) -> Result<serde_json::Value, String> {
    let root = directory(app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = std::process::Command::new(node(&root));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command
            .arg(root.join("runtime.mjs"))
            .args(args)
            .current_dir(&root)
            .output()
            .map_err(|_| "Could not start the installed runtime.".to_string())?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            return Err(error.chars().take(4096).collect());
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|_| "The local runtime returned an invalid status.".to_string())
    })
    .await
    .map_err(|_| "Local runtime startup was interrupted.".to_string())?
}

pub async fn update(
    app: &tauri::AppHandle,
    action: String,
    options: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let root = directory(app)?;
    let state = app
        .path()
        .app_config_dir()
        .map_err(|_| "Cannot locate update preferences.")?
        .join("updates");
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = std::process::Command::new(node(&root));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            child.creation_flags(0x08000000);
        }
        let output = child
            .arg(root.join("runtime.mjs"))
            .args(["updates", &action, &options.to_string()])
            .env("AIXAND_UPDATE_STATE_DIR", state)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(4096)
                .collect());
        }
        serde_json::from_slice(&output.stdout).map_err(|_| "Invalid update status.".into())
    })
    .await
    .map_err(|_| "Update operation interrupted.".to_owned())?
}
