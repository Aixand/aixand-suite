use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::Manager;
use url::Url;

struct Gateway {
    backend: String,
    profile: String,
    address: Url,
    child: Child,
}
impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct State(Mutex<Option<Gateway>>);

pub fn close(app: &tauri::AppHandle) -> Result<(), String> {
    *app.state::<State>()
        .0
        .lock()
        .map_err(|_| "Desktop connection state is unavailable.")? = None;
    Ok(())
}

pub async fn address(
    app: &tauri::AppHandle,
    backend: &Url,
    profile: &str,
) -> Result<Option<(Url, bool)>, String> {
    let runtime = app
        .path()
        .resource_dir()
        .map_err(|_| "Cannot locate Desktop resources.")?
        .join("runtime");
    // Historical connected-client-only packages keep their original web-hosted
    // path. Full Desktop packages carry their UI and use this gateway.
    if !runtime.join("desktop-client.mjs").is_file() {
        return Ok(None);
    }
    let application = app.clone();
    let backend = backend.to_string();
    let profile = profile.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = application.state::<State>();
        let mut held = state.0.lock().map_err(|_| "Desktop connection state is unavailable.")?;
        if let Some(current) = held.as_mut() {
            if current.backend == backend && current.profile == profile && current.child.try_wait().map_err(|_| "Cannot inspect Desktop interface.")?.is_none() {
                return Ok(Some((current.address.clone(), false)));
            }
        }
        *held = None;
        let state_file = application.path().app_config_dir().map_err(|_| "Cannot locate Desktop settings.")?
            .join("clients").join(format!("{profile}.json"));
        let options = serde_json::json!({ "backend": backend, "profile": profile, "stateFile": state_file });
        let mut command = Command::new(runtime.join(if cfg!(windows) { "node/node.exe" } else { "node/bin/node" }));
        command.arg("--use-system-ca").arg(runtime.join("desktop-client.mjs")).arg(options.to_string())
            .env_remove("NODE_OPTIONS").env_remove("NODE_TLS_REJECT_UNAUTHORIZED").env_remove("NODE_USE_ENV_PROXY")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn().map_err(|_| "Could not start the Desktop interface.")?;
        let mut response = String::new();
        let result = (|| {
            let output = child.stdout.take().ok_or("Desktop interface returned no status.")?;
            use std::io::Read;
            BufReader::new(output).take(4096).read_line(&mut response).map_err(|_| "Cannot read Desktop interface status.")?;
            let value: serde_json::Value = serde_json::from_str(&response).map_err(|_| "Desktop interface could not start. Check its saved port is available or repair Desktop.")?;
            let address = crate::connections::server_url(value["address"].as_str().ok_or("Missing Desktop interface address.")?.split('?').next().unwrap_or(""))?;
            let entry = Url::parse(value["address"].as_str().unwrap()).map_err(|_| "Invalid Desktop interface address.")?;
            if address.host_str() != Some("127.0.0.1") || address.scheme() != "http" { return Err("Desktop interface must use loopback.".into()); }
            Ok(entry)
        })();
        match result {
            Ok(address) => {
                *held = Some(Gateway { backend, profile, address: address.clone(), child });
                Ok(Some((address, true)))
            }
            Err(error) => { let _ = child.kill(); let _ = child.wait(); Err(error) }
        }
    }).await.map_err(|_| "Desktop interface startup was interrupted.".to_owned())?
}
