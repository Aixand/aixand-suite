use aixand_client_transport::{Session, Request, Message, futures_util::{SinkExt, StreamExt}};
use serde_json::{json, Value};
use std::path::PathBuf;

async fn request(s: &Session, path: &str, body: Option<Value>, csrf: Option<&str>, status: u16) -> Value {
    let mut headers = vec![];
    if body.is_some() { headers.push(("content-type".into(), "application/json".into())); }
    if let Some(csrf) = csrf { headers.push(("x-csrf-token".into(), csrf.into())); }
    let response = s.request(Request { path: path.into(), method: if body.is_some() { "POST" } else { "GET" }.into(), headers, body: body.map(|v| v.to_string().into_bytes()) }).await.unwrap();
    assert_eq!(response.status, status, "{path}: {}", String::from_utf8_lossy(&response.body));
    assert!(response.headers.iter().all(|(k,_)| !["set-cookie", "cookie"].contains(&k.as_str())));
    serde_json::from_slice(&response.body).unwrap()
}
async fn closed(socket: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) {
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next()).await.unwrap().unwrap().unwrap();
    match frame { Message::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 1008), other => panic!("Expected auth close, got {other:?}") }
}
#[tokio::main(flavor="current_thread")]
async fn main() {
    let args: Vec<_> = std::env::args().collect();
    let path = PathBuf::from(&args[3]);
    let s = Session::new(url::Url::parse(&args[2]).unwrap(), path.clone()).unwrap();
    if args[1] == "login" {
        assert_eq!(request(&s,"/api/auth/status",None,None,200).await["state"], "configured");
        request(&s,"/api/auth/session",None,None,401).await;
        closed(&mut s.socket("/api/terminals/ws").await.unwrap()).await;
        request(&s,"/api/auth/login",Some(json!({"password":"wrong fixture password"})),None,401).await;
        request(&s,"/api/auth/login",Some(json!({"password":"isolated Suite password 9274!"})),None,201).await;
        let value = request(&s,"/api/auth/session",None,None,200).await;
        assert_eq!(value["authenticated"], true);
        assert!(value["csrfToken"].as_str().unwrap().len() > 10);
        request(&s,"/api/auth/logout",Some(json!({})),Some("incorrect"),403).await;
        let mut socket = s.socket("/api/terminals/ws").await.unwrap();
        socket.send(Message::Text("native transport echo".into())).await.unwrap();
        let echo = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next()).await.unwrap().unwrap().unwrap();
        assert_eq!(echo.into_text().unwrap(), "native transport echo");
        socket.close(None).await.unwrap();
        drop(s);
        let restored = Session::new(url::Url::parse(&args[2]).unwrap(),path.clone()).unwrap();
        request(&restored,"/api/auth/session",None,None,200).await;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(path).unwrap().permissions().mode() & 0o777,0o600); }
        println!("PASS login: unauthorized HTTP/WS, bad password, real login, cookie secrecy, CSRF rejection, native WS echo, disk reload, mode0600");
    } else {
        let value = request(&s,"/api/auth/session",None,None,200).await;
        let replay = path.with_extension("replay.json");
        std::fs::copy(&path,&replay).unwrap();
        let mut socket = s.socket("/api/terminals/ws").await.unwrap();
        socket.send(Message::Text("after Server restart".into())).await.unwrap();
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(5),socket.next()).await.unwrap().unwrap().unwrap().into_text().unwrap(),"after Server restart");
        request(&s,"/api/auth/logout",Some(json!({})),value["csrfToken"].as_str(),201).await;
        closed(&mut socket).await;
        request(&s,"/api/auth/session",None,None,401).await;
        drop(s);
        for cookie_path in [path,replay] {
            let restored = Session::new(url::Url::parse(&args[2]).unwrap(),cookie_path).unwrap();
            request(&restored,"/api/auth/session",None,None,401).await;
            closed(&mut restored.socket("/api/terminals/ws").await.unwrap()).await;
        }
        println!("PASS recovery/logout: persisted session after Server restart, WS echo, logout closes active WS1008, HTTP401, disk reload signed out, revoked-cookie replay rejected HTTP/WS");
    }
}
