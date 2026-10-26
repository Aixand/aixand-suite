#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod connections;
mod launcher;
mod local_runtime;
mod desktop_client;

use connections::{Settings, http_client, probe, probe_frontend, server_url};
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

#[derive(Default)]
struct ConnectionState {
    generation: Arc<AtomicU64>,
    connecting: tokio::sync::Mutex<()>,
}

struct CleanupState {
    uninstall: bool,
    busy: AtomicBool,
    desktop_removed: AtomicBool,
}

#[tauri::command]
fn cleanup_context(
    window: WebviewWindow,
    state: tauri::State<'_, CleanupState>,
) -> Result<serde_json::Value, String> {
    launcher_only(&window)?;
    Ok(serde_json::json!({ "uninstall": state.uninstall,
        "desktopSelected": state.uninstall && std::env::args().any(|arg| arg == "--cleanup-desktop-selected") }))
}

#[tauri::command]
fn cleanup_finish(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, CleanupState>,
    proceed: bool,
) -> Result<(), String> {
    launcher_only(&window)?;
    if !state.uninstall || state.busy.load(Ordering::SeqCst) {
        return Err("The uninstaller is not ready to continue.".into());
    }
    app.exit(if !proceed {
        1223
    } else if state.desktop_removed.load(Ordering::SeqCst) {
        10
    } else {
        0
    });
    Ok(())
}

#[tauri::command]
async fn cleanup_components(
    app: tauri::AppHandle,
    window: WebviewWindow,
    action: String,
    options: serde_json::Value,
    connection: tauri::State<'_, ConnectionState>,
    state: tauri::State<'_, CleanupState>,
) -> Result<serde_json::Value, String> {
    launcher_only(&window)?;
    if action == "plan" {
        let mut plan = local_runtime::command(&app, vec!["cleanup".into(), "plan".into()]).await?;
        plan["items"].as_array_mut().ok_or("Invalid cleanup checklist.")?.insert(0, serde_json::json!({
            "id": "desktop", "group": "Aixand", "label": "Desktop connections and browser data",
            "available": true, "shared": false,
            "description": "Forget saved servers and clear desktop cookies, saved sign-ins, drafts and browser preferences.",
            "paths": [app.path().app_config_dir().map_err(|e| e.to_string())?]
        }));
        return Ok(plan);
    }
    if action == "restore-provider" && options["confirmed"] == true {
        let _connecting = connection.connecting.try_lock().map_err(|_| "Wait for the current connection to finish.")?;
        if state.busy.swap(true, Ordering::SeqCst) { return Err("Cleanup is already running.".into()); }
        let result = local_runtime::command(&app, vec!["cleanup".into(), action, options.to_string()]).await;
        state.busy.store(false, Ordering::SeqCst);
        return result;
    }
    if !["apply", "stop-processes", "repair-permissions"].contains(&action.as_str()) || options["confirmed"] != true {
        return Err("Review and confirm the component checklist.".into());
    }
    let selected = options["selected"]
        .as_array()
        .ok_or("No cleanup components selected.")?;
    if selected.is_empty()
        || selected.iter().any(|id| !id.is_string())
        || selected
            .iter()
            .enumerate()
            .any(|(index, id)| selected[..index].contains(id))
    {
        return Err("No cleanup components selected.".into());
    }
    let desktop = selected.iter().any(|value| value == "desktop");
    let runtime_selected: Vec<_> = selected
        .iter()
        .filter(|value| *value != "desktop")
        .cloned()
        .collect();
    // Validate before closing windows or stopping work, including desktop-only resets.
    let plan = local_runtime::command(&app, vec!["cleanup".into(), "plan".into()]).await?;
    if plan["revision"] != options["revision"] {
        return Err("Installed components changed. Refresh the checklist.".into());
    }
    if runtime_selected.iter().any(|id| {
        !plan["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == *id && item["available"] == true)
    }) {
        return Err("An unknown or unavailable cleanup component was selected.".into());
    }
    let _connecting = connection
        .connecting
        .try_lock()
        .map_err(|_| "Wait for the current connection to finish.")?;
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err("Cleanup is already running.".into());
    }
    let result = async {
        connection.generation.fetch_add(1, Ordering::SeqCst);
        let mut report = if runtime_selected.is_empty() {
            if action != "apply" {
                return Err("No blocking runtime applications were selected.".into());
            }
            local_runtime::command(&app, vec!["stop".into()]).await?;
            serde_json::json!({ "completed": [], "failed": null })
        } else {
            let mut runtime_options = options.clone();
            runtime_options["selected"] = serde_json::json!(runtime_selected);
            local_runtime::command(
                &app,
                vec![
                    "cleanup".into(),
                    action.clone(),
                    runtime_options.to_string(),
                ],
            )
            .await?
        };
        // Checking or stopping blockers must never clear cookies, settings, or
        // workspace windows. Do that only after successful component removal.
        if action != "apply" || report["blocked"] == true || !report["failed"].is_null() {
            return Ok(report);
        }
        for (label, workspace) in app.webview_windows() {
            if label != "main" {
                if desktop {
                    workspace
                        .clear_all_browsing_data()
                        .map_err(|e| e.to_string())?;
                }
                workspace.close().map_err(|e| e.to_string())?;
            }
        }
        desktop_client::close(&app)?;
        if desktop {
            window
                .clear_all_browsing_data()
                .map_err(|e| e.to_string())?;
            for path in [
                settings_path(&app)?,
                settings_path(&app)?.with_extension("json.tmp"),
            ] {
                if let Err(error) = fs::remove_file(path) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        return Err(error.to_string());
                    }
                }
            }
            let clients = app.path().app_config_dir().map_err(|e| e.to_string())?.join("clients");
            if let Err(error) = fs::remove_dir_all(clients) {
                if error.kind() != std::io::ErrorKind::NotFound { return Err(error.to_string()); }
            }
            report["completed"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!("desktop"));
            state.desktop_removed.store(true, Ordering::SeqCst);
        }
        Ok(report)
    }
    .await;
    state.busy.store(false, Ordering::SeqCst);
    result
}

fn launcher_only(window: &WebviewWindow) -> Result<(), String> {
    let url = window
        .url()
        .map_err(|_| "Cannot identify the connection window.".to_string())?;
    // `tauri dev` serves launcher/ on its own local HTTP server and injects
    // that address into devUrl. Packaged builds must never trust devUrl.
    let development_url = if tauri::is_dev() {
        window.config().build.dev_url.as_ref()
    } else {
        None
    };
    launcher::authorize(window.label(), &url, development_url)
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("connections.json"))
        .map_err(|_| "Cannot locate desktop connection settings.".into())
}

fn read_settings(app: &tauri::AppHandle) -> Result<Settings, String> {
    let path = settings_path(app)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Settings::default());
        }
        Err(_) => return Err("Cannot read desktop connection settings.".into()),
    };
    if bytes.len() > 64 * 1024 {
        return Err("Desktop connection settings are too large.".into());
    }
    serde_json::from_slice::<Settings>(&bytes)
        .map_err(|_| {
            "Saved connections could not be read. You can save a new connection to replace them."
                .to_string()
        })?
        .validate()
}

#[tauri::command]
fn connection_settings(app: tauri::AppHandle, window: WebviewWindow) -> Result<Settings, String> {
    launcher_only(&window)?;
    read_settings(&app)
}

#[tauri::command]
fn save_connection_settings(
    app: tauri::AppHandle,
    window: WebviewWindow,
    settings: Settings,
) -> Result<Settings, String> {
    launcher_only(&window)?;
    write_settings(&app, settings)
}

fn write_settings(app: &tauri::AppHandle, settings: Settings) -> Result<Settings, String> {
    let settings = settings.validate()?;
    let path = settings_path(app)?;
    fs::create_dir_all(path.parent().unwrap())
        .map_err(|_| "Cannot create desktop settings directory.".to_string())?;
    let bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|_| "Cannot encode saved connections.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .and_then(|_| fs::rename(&temporary, &path))
        .map_err(|_| "Cannot save desktop connection settings.".to_string())?;
    Ok(settings)
}

#[tauri::command]
async fn local_runtime_info(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<local_runtime::Info, String> {
    launcher_only(&window)?;
    local_runtime::info(&app)
}

#[tauri::command]
async fn local_runtime_setup(
    app: tauri::AppHandle,
    window: WebviewWindow,
    action: String,
    options: serde_json::Value,
) -> Result<serde_json::Value, String> {
    launcher_only(&window)?;
    local_runtime::setup(&app, action, options).await
}

#[tauri::command]
async fn select_local_workspace(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Settings, String> {
    launcher_only(&window)?;
    let info = local_runtime::info(&app)?;
    if !info.available {
        return Err("This desktop package does not include a local runtime.".into());
    }
    let mut settings = read_settings(&app)?;
    if let Some(profile) = settings.profiles.iter_mut().find(|profile| profile.local) {
        settings.selected_id = profile.id.clone();
    } else {
        if settings.profiles.len() >= 20 {
            return Err("Remove a saved connection before adding the local workspace.".into());
        }
        let id = format!("local-{}", std::process::id());
        settings.profiles.push(connections::Profile {
            id: id.clone(),
            name: "Local workspace".into(),
            address: info.address,
            local: true,
        });
        settings.selected_id = id;
    }
    write_settings(&app, settings)
}

#[derive(Clone, serde::Serialize)]
struct WorkspaceStatus {
    kind: &'static str,
    message: String,
}

fn report(app: &tauri::AppHandle, kind: &'static str, message: impl Into<String>, reveal: bool) {
    let _ = app.emit_to(
        "main",
        "workspace-status",
        WorkspaceStatus {
            kind,
            message: message.into(),
        },
    );
    if reveal && let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
    }
}

#[tauri::command]
async fn connect_workspace(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, ConnectionState>,
    reload: bool,
) -> Result<(), String> {
    launcher_only(&window)?;
    let _connecting = state
        .connecting
        .try_lock()
        .map_err(|_| "A connection is already being checked.".to_string())?;
    let settings = read_settings(&app)?;
    let profile = settings.selected()?;
    let address = if profile.local {
        report(&app, "connecting", "Starting local services…", false);
        server_url(&local_runtime::start(&app).await?)?
    } else {
        server_url(&profile.address)?
    };
    let client = http_client(&address)?;
    probe(&client, &address).await?;
    let (interface, fresh_interface) = match desktop_client::address(&app, &address, &profile.id).await? {
        Some(interface) => interface,
        None => { probe_frontend(&client, &address).await?; (address.clone(), false) }
    };
    if let Some(workspace) = app.get_webview_window("workspace") {
        if reload || fresh_interface
            || workspace
                .url()
                .ok()
                .is_none_or(|current| current.origin() != interface.origin())
        {
            workspace
                .navigate(interface.clone())
                .map_err(|_| "Could not open the workspace.".to_string())?;
        }
        workspace
            .set_title(&format!("Aixand — {}", profile.name))
            .map_err(|_| "Could not update the workspace window.".to_string())?;
        let _ = workspace.show();
        let _ = workspace.set_focus();
    } else {
        let browser_handle = app.clone();
        let workspace =
            WebviewWindowBuilder::new(&app, "workspace", WebviewUrl::External(interface.clone()))
                .title(format!("Aixand — {}", profile.name))
                .inner_size(1280.0, 900.0)
                .min_inner_size(640.0, 480.0)
                .disable_drag_drop_handler()
                .on_new_window(move |url, _| {
                    let handle = browser_handle.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Err(message) = browser::open(&url) {
                            report(&handle, "error", message, true);
                        }
                    });
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()
                .map_err(|_| "Could not create the workspace window.".to_string())?;
        let handle = app.clone();
        workspace.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                let _ = desktop_client::close(&handle);
                handle
                    .state::<ConnectionState>()
                    .generation
                    .fetch_add(1, Ordering::SeqCst);
                report(
                    &handle,
                    "closed",
                    "Workspace closed. Your server and its running work are still available.",
                    true,
                );
            }
        });
    }
    let generation = state.generation.clone();
    let current = generation.fetch_add(1, Ordering::SeqCst) + 1;
    report(
        &app,
        "connected",
        format!(
            "Connected to {}. Your workspace is open in its own window.",
            profile.name
        ),
        false,
    );
    tauri::async_runtime::spawn(async move {
        let mut unavailable = false;
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if generation.load(Ordering::SeqCst) != current {
                break;
            }
            let result = probe(&client, &address).await;
            if generation.load(Ordering::SeqCst) != current {
                break;
            }
            match result {
                Err(message) if !unavailable => {
                    unavailable = true;
                    report(&app, "disconnected", message, true);
                }
                Ok(_) if unavailable => {
                    unavailable = false;
                    report(
                        &app,
                        "restored",
                        "The server is reachable again. Return to your workspace, or choose Reconnect if it needs reloading.",
                        false,
                    );
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(desktop_client::State::default())
        .manage(ConnectionState::default())
        .manage(CleanupState {
            uninstall: std::env::args().any(|arg| arg == "--cleanup-uninstall"),
            busy: AtomicBool::new(false),
            desktop_removed: AtomicBool::new(false),
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let WindowEvent::CloseRequested { api, .. } = event
            {
                let state = window.state::<CleanupState>();
                if state.busy.load(Ordering::SeqCst) {
                    api.prevent_close();
                } else if state.uninstall {
                    api.prevent_close();
                    window.app_handle().exit(1223);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            connection_settings,
            save_connection_settings,
            connect_workspace,
            local_runtime_info,
            local_runtime_setup,
            select_local_workspace,
            cleanup_context,
            cleanup_components,
            cleanup_finish
        ])
        .run(tauri::generate_context!())
        .expect("could not run Aixand desktop");
}
