//! IPC is granted only to bundled workspace assets. These commands have no
//! filesystem, process, launcher, or server-selection authority.
use aixand_client_transport::{
    Message, Request, Response, Session,
    futures_util::{SinkExt, StreamExt},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Manager, WebviewWindow, ipc::Channel};
use tokio::sync::{mpsc, watch};

#[derive(Default)]
pub struct State {
    active: Mutex<Option<(u64, Arc<Session>)>>,
    sockets: Mutex<HashMap<String, mpsc::Sender<Message>>>,
    generation: watch::Sender<u64>,
}

pub fn generation(app: &tauri::AppHandle) -> u64 {
    *app.state::<State>().generation.borrow()
}
fn check_generation(state: &State, connection: u64) -> Result<(), String> {
    if *state.generation.borrow() != connection {
        return Err("The selected server changed.".into());
    }
    Ok(())
}
pub fn close(app: &tauri::AppHandle) {
    let state = app.state::<State>();
    state.generation.send_modify(|generation| *generation += 1);
    if let Ok(mut sockets) = state.sockets.lock() {
        sockets.clear();
    }
    if let Ok(mut active) = state.active.lock() {
        *active = None;
    }
}

pub fn storage_key(backend: &url::Url, profile: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{profile}-{:x}",
        Sha256::digest(backend.as_str().as_bytes())
    )
}
pub fn select(app: &tauri::AppHandle, backend: url::Url, profile: &str) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "Cannot locate Client settings")?
        .join("sessions")
        .join(format!("{}.json", storage_key(&backend, profile)));
    let session = Arc::new(Session::new(backend, path)?);
    close(app);
    *app.state::<State>()
        .active
        .lock()
        .map_err(|_| "Connection state unavailable")? = Some((generation(app), session));
    Ok(())
}
fn authorize(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "Cannot identify workspace")?;
    // Reuse the strict packaged-origin check, but require the workspace label.
    if !cfg!(feature = "client") || window.label() != "workspace" {
        return Err("Only the bundled Client workspace can use its connection.".into());
    }
    crate::launcher::authorize("main", &url, None)
}
fn session(state: &State, connection: u64) -> Result<Arc<Session>, String> {
    let held = state
        .active
        .lock()
        .map_err(|_| "Connection state unavailable")?;
    let (generation, session) = held.as_ref().ok_or("Select a server first")?;
    if *generation != connection {
        return Err("The selected server changed.".into());
    }
    Ok(session.clone())
}
#[tauri::command]
pub async fn client_request(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    request: Request,
    connection: u64,
) -> Result<Response, String> {
    authorize(&window)?;
    check_generation(&state, connection)?;
    let mut generation = state.generation.subscribe();
    let session = session(&state, connection)?;
    tokio::select! {
        result = session.request(request) => result,
        _ = generation.changed() => Err("The selected server changed.".into()),
    }
}
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SocketEvent {
    Open,
    Message { data: String },
    Close { code: u16, reason: String },
    Error,
}
#[tauri::command]
pub async fn client_socket_open(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    id: String,
    connection: u64,
    path: String,
    events: Channel<SocketEvent>,
) -> Result<(), String> {
    authorize(&window)?;
    check_generation(&state, connection)?;
    if id.len() > 64 || id.is_empty() {
        return Err("Invalid socket identifier".into());
    }
    let mut generation = state.generation.subscribe();
    let session = session(&state, connection)?;
    let (sender, mut messages) = mpsc::channel::<Message>(32);
    {
        let mut sockets = state
            .sockets
            .lock()
            .map_err(|_| "Socket state unavailable")?;
        if sockets.len() >= 32 || sockets.contains_key(&id) {
            return Err("Too many workspace sockets".into());
        }
        sockets.insert(id.clone(), sender);
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let result: Result<(u16, String), String> = async {
            let mut socket = tokio::select! {
                result = session.socket(&path) => result?,
                _ = generation.changed() => return Ok((1001, "Connection changed".to_owned())),
            };
            events.send(SocketEvent::Open).map_err(|_| "Workspace closed")?;
            loop {
                tokio::select! {
                    _ = generation.changed() => { let _ = socket.close(None).await; return Ok((1001, "Connection changed".to_owned())); }
                    message = messages.recv() => {
                        match message {
                            Some(Message::Close(frame)) => { let _ = socket.close(frame).await; return Ok((1000, String::new())); }
                            Some(message) => socket.send(message).await.map_err(|_| "Socket send failed")?,
                            None => return Ok((1001, String::new())),
                        }
                    }
                    message = socket.next() => match message {
                        Some(Ok(Message::Text(data))) => { events.send(SocketEvent::Message { data: data.to_string() }).map_err(|_| "Workspace closed")?; }
                        Some(Ok(Message::Close(frame))) => return Ok(frame.map(|frame| (u16::from(frame.code), frame.reason.to_string())).unwrap_or((1000, String::new()))),
                        Some(Ok(Message::Ping(data))) => { socket.send(Message::Pong(data)).await.map_err(|_| "Socket pong failed")?; }
                        Some(Ok(_)) => {},
                        Some(Err(_)) => return Err("Server socket interrupted".into()),
                        None => return Ok((1006, String::new())),
                    }
                }
            }
        }.await;
        if let Ok(mut sockets) = app.state::<State>().sockets.lock() {
            sockets.remove(&id);
        }
        let (code, reason) = match result {
            Ok(value) => value,
            Err(_) => {
                let _ = events.send(SocketEvent::Error);
                (1006, "Server connection lost".into())
            }
        };
        let _ = events.send(SocketEvent::Close { code, reason });
    });
    Ok(())
}
#[tauri::command]
pub fn client_socket_send(
    window: WebviewWindow,
    state: tauri::State<'_, State>,
    id: String,
    connection: u64,
    data: Option<String>,
    close: bool,
) -> Result<(), String> {
    authorize(&window)?;
    check_generation(&state, connection)?;
    if data.as_ref().is_some_and(|value| value.len() > 1024 * 1024) {
        return Err("Socket message is too large".into());
    }
    let sockets = state
        .sockets
        .lock()
        .map_err(|_| "Socket state unavailable")?;
    let sender = sockets.get(&id).ok_or("Socket is closed")?;
    sender
        .try_send(if close {
            Message::Close(None)
        } else {
            Message::Text(data.ok_or("Missing socket message")?.into())
        })
        .map_err(|_| "Socket is busy or closed".into())
}
