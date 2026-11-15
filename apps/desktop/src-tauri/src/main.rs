#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod client_transport;
mod component_refresh;
mod connections;
mod desktop_client;
mod launcher;
mod local_runtime;
mod native_updates;

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
struct ComponentUpdatesState(tokio::sync::Mutex<component_refresh::Review>);

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
    if cfg!(feature = "client") {
        return Err("Client has no local components to maintain.".into());
    }
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
        let _connecting = connection
            .connecting
            .try_lock()
            .map_err(|_| "Wait for the current connection to finish.")?;
        if state.busy.swap(true, Ordering::SeqCst) {
            return Err("Cleanup is already running.".into());
        }
        let result =
            local_runtime::command(&app, vec!["cleanup".into(), action, options.to_string()]).await;
        state.busy.store(false, Ordering::SeqCst);
        return result;
    }
    if !["apply", "stop-processes", "repair-permissions"].contains(&action.as_str())
        || options["confirmed"] != true
    {
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
            let clients = app
                .path()
                .app_config_dir()
                .map_err(|e| e.to_string())?
                .join("clients");
            if let Err(error) = fs::remove_dir_all(clients) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(error.to_string());
                }
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

#[tauri::command]
async fn application_updates(
    app: tauri::AppHandle,
    window: WebviewWindow,
    action: String,
    mut options: serde_json::Value,
    cleanup: tauri::State<'_, CleanupState>,
    connection: tauri::State<'_, ConnectionState>,
) -> Result<serde_json::Value, String> {
    launcher_only(&window)?;
    if cleanup.uninstall || cleanup.busy.load(Ordering::SeqCst) {
        return Err("Finish maintenance before updating.".into());
    }
    if !options.is_object() {
        return Err("Invalid update options.".into());
    }
    if cfg!(feature = "client") {
        let _connecting = connection
            .connecting
            .try_lock()
            .map_err(|_| "Wait for the current connection to finish.")?;
        let result = native_updates::action(&app, &action, &options).await?;
        if action == "install" && result["started"] == true {
            app.exit(0);
        }
        return Ok(result);
    }
    if ![
        "status", "check", "due", "settings", "download", "plan", "install",
    ]
    .contains(&action.as_str())
    {
        return Err("Unknown update operation.".into());
    }
    if action == "install" {
        let _connecting = connection
            .connecting
            .try_lock()
            .map_err(|_| "Wait for the current connection to finish.")?;
        if cleanup.busy.swap(true, Ordering::SeqCst) {
            return Err("Maintenance is already running.".into());
        }
        let result = async {
            options["parentPid"] = serde_json::json!(std::process::id());
            options["application"] =
                serde_json::json!(std::env::current_exe().map_err(|e| e.to_string())?);
            let result = local_runtime::update(&app, action, options).await?;
            desktop_client::close(&app)?;
            app.exit(0);
            Ok(result)
        }
        .await;
        if result.is_err() {
            cleanup.busy.store(false, Ordering::SeqCst);
        }
        return result;
    }
    local_runtime::update(&app, action, options).await
}

#[tauri::command]
async fn component_updates(
    app: tauri::AppHandle,
    window: WebviewWindow,
    action: String,
    options: serde_json::Value,
    cleanup: tauri::State<'_, CleanupState>,
    connection: tauri::State<'_, ConnectionState>,
    reviews: tauri::State<'_, ComponentUpdatesState>,
) -> Result<serde_json::Value, String> {
    launcher_only(&window)?;
    if cfg!(feature = "client") {
        return Err("Client has no local workspace components.".into());
    }
    if cleanup.uninstall || cleanup.busy.load(Ordering::SeqCst) {
        return Err("Finish maintenance before updating.".into());
    }
    if !options.is_object()
        || ![
            "status", "check", "due", "settings", "plan", "download", "install",
        ]
        .contains(&action.as_str())
    {
        return Err("Invalid component update request.".into());
    }
    let _connecting = connection
        .connecting
        .try_lock()
        .map_err(|_| "Wait for the current connection to finish.")?;
    let mut review = reviews
        .0
        .try_lock()
        .map_err(|_| "A component review is already running.")?;
    let reviewing = action == "plan";
    let installing = action == "install";
    let checking_status = action == "status";
    let approved = installing && review.approved(&options);
    let value = local_runtime::command(
        &app,
        vec!["component-updates".into(), action, options.to_string()],
    )
    .await?;
    if installing {
        review.started(approved, &value);
    }
    if checking_status && review.completed(&value) {
        desktop_client::refresh(&app).await?;
    }
    if reviewing {
        review.plan(&value);
        let mut visible = serde_json::Map::new();
        for key in [
            "revision",
            "ready",
            "requested",
            "licenses",
            "restartRequired",
            "unsupported",
        ] {
            visible.insert(key.into(), value[key].clone());
        }
        let candidates = value["candidates"]
            .as_object()
            .ok_or("Invalid component review.")?
            .iter()
            .map(|(id, item)| {
                (
                    id.clone(),
                    serde_json::json!({ "version": item["version"], "requires": item["requires"] }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        visible.insert("candidates".into(), serde_json::Value::Object(candidates));
        visible.insert("blockers".into(), serde_json::json!(value["blockers"].as_array().ok_or("Invalid component blockers.")?.iter().map(|item|
            serde_json::json!({"name": item["name"].as_str().unwrap_or("Active workspace work")})).collect::<Vec<_>>()));
        return Ok(serde_json::Value::Object(visible));
    }
    Ok(value)
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
    if cfg!(feature = "client") && settings.profiles.iter().any(|profile| profile.local) {
        return Err("Client supports Server connections only.".into());
    }
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
) -> Result<serde_json::Value, String> {
    launcher_only(&window)?;
    if cfg!(feature = "client") {
        return Ok(serde_json::json!({ "available": false, "address": "", "role": "client" }));
    }
    serde_json::to_value(local_runtime::info(&app)?).map_err(|e| e.to_string())
}

#[tauri::command]
async fn local_runtime_setup(
    app: tauri::AppHandle,
    window: WebviewWindow,
    action: String,
    options: serde_json::Value,
) -> Result<serde_json::Value, String> {
    launcher_only(&window)?;
    if cfg!(feature = "client") {
        return Err("Local workspaces are not included in Client.".into());
    }
    local_runtime::setup(&app, action, options).await
}

#[tauri::command]
async fn select_local_workspace(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Settings, String> {
    launcher_only(&window)?;
    if cfg!(feature = "client") {
        return Err("Local workspaces are not included in Client.".into());
    }
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
    if cfg!(feature = "client") && profile.local {
        return Err("Select a Server connection.".into());
    }
    let address = if profile.local {
        report(&app, "connecting", "Starting local services…", false);
        server_url(&local_runtime::start(&app).await?)?
    } else {
        server_url(&profile.address)?
    };
    let client = http_client(&address)?;
    probe(&client, &address).await?;
    if cfg!(feature = "client") {
        // Close the previous document before changing its native session.
        if let Some(workspace) = app.get_webview_window("workspace") {
            workspace
                .destroy()
                .map_err(|_| "Cannot close previous workspace")?;
        }
        client_transport::select(&app, address.clone(), &profile.id)?;
    }
    let (interface, fresh_interface) = if cfg!(feature = "client") {
        (
            url::Url::parse("tauri://localhost/index.html")
                .map_err(|_| "Invalid bundled interface")?,
            true,
        )
    } else {
        match desktop_client::address(&app, &address, &profile.id).await? {
            Some(interface) => interface,
            None => {
                probe_frontend(&client, &address).await?;
                (address.clone(), false)
            }
        }
    };
    if let Some(workspace) = app.get_webview_window("workspace") {
        if reload
            || fresh_interface
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
        let client_generation = client_transport::generation(&app);
        let initialization = if cfg!(feature = "client") {
            format!(
                "Object.defineProperty(window, '__AIXAND_CLIENT__', {{value: true}}); Object.defineProperty(window, '__AIXAND_CONNECTION__', {{value: {client_generation}}});"
            )
        } else {
            String::new()
        };
        let workspace = WebviewWindowBuilder::new(
            &app,
            "workspace",
            if cfg!(feature = "client") {
                WebviewUrl::App("index.html".into())
            } else {
                WebviewUrl::External(interface.clone())
            },
        )
        .initialization_script(&initialization)
        .incognito(cfg!(all(feature = "client", target_os = "macos")))
        .on_navigation(|url| {
            !cfg!(feature = "client") || launcher::authorize("main", url, None).is_ok()
        })
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
        });
        // WebKit automation controls only the first WebContext. Native tests
        // deliberately share it; ordinary Client launches isolate browser data.
        let workspace = if cfg!(feature = "client")
            && std::env::var("TAURI_WEBVIEW_AUTOMATION").as_deref() != Ok("true")
        {
            let path = app
                .path()
                .app_config_dir()
                .map_err(|e| e.to_string())?
                .join("browser")
                .join(client_transport::storage_key(&address, &profile.id));
            fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                    .map_err(|e| e.to_string())?;
            }
            workspace.data_directory(path)
        } else {
            workspace
        };
        let workspace = workspace
            .build()
            .map_err(|_| "Could not create the workspace window.".to_string())?;
        let handle = app.clone();
        workspace.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                let _ = desktop_client::close(&handle);
                if cfg!(feature = "client")
                    && client_transport::generation(&handle) != client_generation
                {
                    return;
                }
                client_transport::close(&handle);
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

#[tauri::command]
fn client_reset(
    app: tauri::AppHandle,
    window: WebviewWindow,
    confirmed: bool,
    state: tauri::State<'_, ConnectionState>,
) -> Result<(), String> {
    launcher_only(&window)?;
    if !cfg!(feature = "client") || !confirmed {
        return Err("Confirm clearing Client data.".into());
    }
    let _connecting = state
        .connecting
        .try_lock()
        .map_err(|_| "Wait for the connection to finish")?;
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(workspace) = app.get_webview_window("workspace") {
        workspace
            .clear_all_browsing_data()
            .map_err(|e| e.to_string())?;
        workspace.destroy().map_err(|e| e.to_string())?;
    }
    client_transport::close(&app);
    window
        .clear_all_browsing_data()
        .map_err(|e| e.to_string())?;
    let sessions = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("sessions");
    match fs::remove_dir_all(sessions) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    let browser = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("browser");
    match fs::remove_dir_all(browser) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    write_settings(&app, Settings::default())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(desktop_client::State::default())
        .manage(client_transport::State::default())
        .manage(ConnectionState::default())
        .manage(native_updates::State::default())
        .manage(ComponentUpdatesState::default())
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
            application_updates,
            component_updates,
            cleanup_finish,
            client_reset,
            client_transport::client_request,
            client_transport::client_socket_open,
            client_transport::client_socket_send
        ])
        .run(tauri::generate_context!())
        .expect("could not run Aixand desktop");
}
