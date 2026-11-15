use tauri::Manager;
#[derive(Default)]
pub struct State(pub tokio::sync::Mutex<()>);
fn target() -> Result<String, String> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "arm64",
        _ => return Err("Unsupported Client architecture.".into()),
    };
    let os = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        _ => return Err("Unsupported Client platform.".into()),
    };
    if os == "linux" {
        // Select the package manager that owns this executable, rather than guessing
        // from the distribution or accepting a package format from the renderer.
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        for (tool, args, kind) in [
            ("/usr/bin/dpkg-query", vec!["--search"], "deb"),
            ("/usr/bin/rpm", vec!["--query", "--file"], "rpm"),
        ] {
            if std::process::Command::new(tool)
                .args(args)
                .arg(&executable)
                .output()
                .is_ok_and(|o| o.status.success())
            {
                return Ok(format!("{os}-{arch}-{kind}"));
            }
        }
        return Err("Client updates require an installed native package. Use your original installer for this portable build.".into());
    }
    Ok(format!("{os}-{arch}"))
}

pub async fn action(
    app: &tauri::AppHandle,
    action: &str,
    options: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let state = app.state::<State>();
    let _guard = state
        .0
        .try_lock()
        .map_err(|_| "A Client update operation is already running.")?;
    let trust = serde_json::from_str(include_str!(concat!(
        env!("OUT_DIR"),
        "/client-update-config.json"
    )))
    .map_err(|e| e.to_string())?;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("native-updates");
    let installed = aixand_native_updater::engine::Installed {
        version: env!("AIXAND_CLIENT_VERSION"),
        sequence: env!("AIXAND_CLIENT_SEQUENCE").parse().unwrap(),
    };
    aixand_native_updater::engine::action(&directory, &trust, target(), &installed, action, options)
        .await
}
