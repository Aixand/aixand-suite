//! Outbound-only transport. The frontend cannot select arbitrary hosts or supply
//! cookies, Origin, proxy headers, or native filesystem paths.
pub use futures_util;
use reqwest::{
    Client, Method,
    cookie::CookieStore as _,
    header::{COOKIE, HeaderValue},
};
use serde::{Deserialize, Serialize};
use std::{
    io::BufReader,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
pub use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async_with_config, tungstenite::client::IntoClientRequest};
use url::Url;

const LIMIT: usize = 16 * 1024 * 1024;

struct Cookies {
    values: Mutex<cookie_store::CookieStore>,
    path: PathBuf,
}
impl reqwest::cookie::CookieStore for Cookies {
    fn set_cookies(&self, headers: &mut dyn Iterator<Item = &HeaderValue>, url: &Url) {
        let Ok(mut values) = self.values.lock() else {
            return;
        };
        for header in headers {
            if let Ok(raw) = header.to_str() {
                let _ = values.parse(raw, url);
            }
        }
        // Persist expiry times, never restart Max-Age on application launch.
        let result = (|| -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            std::fs::create_dir_all(self.path.parent().ok_or("Missing session directory")?)?;
            let temporary = self.path.with_extension("tmp");
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            cookie_store::serde::json::save(&values, &mut file)?;
            file.sync_all()?;
            std::fs::rename(temporary, &self.path)?;
            Ok(())
        })();
        if result.is_err() {
            eprintln!("Client session could not be saved; sign-in may be required after restart.");
        }
    }
    fn cookies(&self, url: &Url) -> Option<HeaderValue> {
        let values = self.values.lock().ok()?;
        let header = values
            .get_request_values(url)
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        if header.is_empty() {
            None
        } else {
            HeaderValue::from_str(&header).ok()
        }
    }
}

pub struct Session {
    pub backend: Url,
    client: Client,
    cookies: Arc<Cookies>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub path: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub fn endpoint(backend: &Url, path: &str) -> Result<Url, String> {
    if !path.starts_with("/api/") || path.contains('\\') || path.contains('#') || path.len() > 8192
    {
        return Err("Only workspace API paths are available.".into());
    }
    let endpoint = backend.join(path).map_err(|_| "Invalid API path")?;
    if endpoint.origin() != backend.origin() || !endpoint.path().starts_with("/api/") {
        return Err("The request must stay on the selected server's API.".into());
    }
    Ok(endpoint)
}
impl Session {
    pub fn new(backend: Url, path: PathBuf) -> Result<Self, String> {
        if backend.path() != "/"
            || backend.query().is_some()
            || backend.fragment().is_some()
            || !backend.username().is_empty()
            || backend.password().is_some()
            || !(backend.scheme() == "https"
                || backend.scheme() == "http"
                    && matches!(
                        backend.host_str(),
                        Some("localhost" | "127.0.0.1" | "[::1]")
                    ))
        {
            return Err("Use a root HTTPS address or an HTTP loopback address.".into());
        }
        let values = std::fs::File::open(&path)
            .ok()
            .and_then(|file| cookie_store::serde::json::load(BufReader::new(file)).ok())
            .unwrap_or_default();
        let cookies = Arc::new(Cookies {
            values: Mutex::new(values),
            path,
        });
        let mut builder = Client::builder()
            .cookie_provider(cookies.clone())
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120));
        if matches!(
            backend.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]")
        ) {
            builder = builder.no_proxy();
        }
        Ok(Self {
            backend,
            cookies,
            client: builder
                .build()
                .map_err(|_| "Cannot prepare server connection")?,
        })
    }
    pub async fn request(&self, input: Request) -> Result<Response, String> {
        let url = endpoint(&self.backend, &input.path)?;
        if input.body.as_ref().is_some_and(|body| body.len() > LIMIT) || input.headers.len() > 16 {
            return Err("Request is too large.".into());
        }
        let method =
            Method::from_bytes(input.method.as_bytes()).map_err(|_| "Invalid request method")?;
        if !matches!(
            method,
            Method::GET
                | Method::POST
                | Method::PUT
                | Method::PATCH
                | Method::DELETE
                | Method::HEAD
        ) {
            return Err("Unsupported request method.".into());
        }
        let mut request = self
            .client
            .request(method, url)
            .header("Origin", self.backend.origin().ascii_serialization());
        for (name, value) in input.headers {
            if !matches!(
                name.to_ascii_lowercase().as_str(),
                "content-type" | "accept" | "x-csrf-token"
            ) {
                return Err("Unsupported request header.".into());
            }
            request = request.header(name, value);
        }
        if let Some(body) = input.body {
            request = request.body(body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "Cannot reach the selected server.")?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| {
                matches!(
                    name.as_str(),
                    "content-type" | "cache-control" | "retry-after"
                )
            })
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.to_string(), value.to_owned()))
            })
            .collect();
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Server response interrupted")?
        {
            if body.len() + chunk.len() > LIMIT {
                return Err("Server response is too large.".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Response {
            status,
            headers,
            body,
        })
    }
    pub async fn socket(
        &self,
        path: &str,
    ) -> Result<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        String,
    > {
        let http = endpoint(&self.backend, path)?;
        if !matches!(
            http.path(),
            "/api/agents/ws"
                | "/api/carrier/ws"
                | "/api/terminals/ws"
                | "/api/workflows/ws"
                | "/api/workflow-jobs/ws"
                | "/api/vox/ws"
        ) || http.query().is_some()
        {
            return Err("Unsupported workspace socket.".into());
        }
        let mut url = http.clone();
        url.set_scheme(if http.scheme() == "https" {
            "wss"
        } else {
            "ws"
        })
        .map_err(|_| "Invalid socket scheme")?;
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| "Invalid socket request")?;
        request.headers_mut().insert(
            "Origin",
            self.backend
                .origin()
                .ascii_serialization()
                .parse()
                .map_err(|_| "Invalid server origin")?,
        );
        if let Some(cookies) = self.cookies.cookies(&http) {
            request.headers_mut().insert(COOKIE, cookies);
        }
        let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
        config.max_message_size = Some(LIMIT);
        config.max_frame_size = Some(LIMIT);
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(10),
            connect_async_with_config(request, Some(config), false),
        )
        .await
        .map_err(|_| "Server socket connection timed out")?
        .map_err(|_| "Cannot open server socket")?;
        Ok(socket)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confines_requests_to_selected_api() {
        let backend = Url::parse("https://suite.example/").unwrap();
        for path in [
            "https://evil.example/api/x",
            "//evil.example/api/x",
            "/api/../secrets",
            "/api/%2e%2e/secrets",
            "/api/\\evil",
            "/index.html",
            "/api/auth#x",
        ] {
            assert!(endpoint(&backend, path).is_err(), "{path}");
        }
        assert_eq!(
            endpoint(&backend, "/api/auth/status?x=1")
                .unwrap()
                .host_str(),
            Some("suite.example")
        );
    }
    #[test]
    fn rejects_insecure_network_backends() {
        assert!(
            Session::new(
                Url::parse("http://suite.example/").unwrap(),
                PathBuf::from("unused")
            )
            .is_err()
        );
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn request_text(stream: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        loop {
            let mut buffer = [0u8; 4096];
            let count = stream.read(&mut buffer).await.unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&buffer[..count]);
            if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                break;
            }
        }
        String::from_utf8(bytes).unwrap().to_ascii_lowercase()
    }
    fn get(path: &str) -> Request {
        Request {
            path: path.into(),
            method: "GET".into(),
            headers: vec![],
            body: None,
        }
    }

    #[tokio::test]
    async fn persists_cookies_and_keeps_native_sessions_out_of_responses() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let origin = backend.origin().ascii_serialization();
        let server = tokio::spawn(async move {
            for index in 0..3 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = request_text(&mut stream).await;
                assert!(request.contains(&format!("origin: {origin}")));
                if index != 0 {
                    assert!(request.contains("cookie: aixand-dev-session=secret"));
                }
                let cookie = if index == 0 {
                    "Set-Cookie: aixand-dev-session=secret; Path=/; HttpOnly; Max-Age=3600\r\n"
                } else {
                    ""
                };
                stream.write_all(format!("HTTP/1.1 200 OK\r\n{cookie}Content-Length: 2\r\nConnection: close\r\n\r\n{{}}").as_bytes()).await.unwrap();
            }
        });
        let directory = std::env::temp_dir().join(format!(
            "aixand-client-session-{}-{}",
            std::process::id(),
            backend.port().unwrap()
        ));
        let path = directory.join("session.json");
        let session = Session::new(backend.clone(), path.clone()).unwrap();
        let response = session.request(get("/api/auth/login")).await.unwrap();
        assert!(
            !response
                .headers
                .iter()
                .any(|(name, _)| name == "set-cookie")
        );
        session.request(get("/api/auth/session")).await.unwrap();
        drop(session);
        Session::new(backend, path.clone())
            .unwrap()
            .request(get("/api/auth/session"))
            .await
            .unwrap();
        server.await.unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn websocket_uses_native_cookies_and_selected_origin() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let origin = backend.origin().ascii_serialization();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                stream,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(request.headers()["origin"], origin);
                    assert_eq!(request.headers()["cookie"], "aixand-dev-session=secret");
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let message = socket.next().await.unwrap().unwrap();
            socket.send(message).await.unwrap();
        });
        let session = Session::new(
            backend.clone(),
            std::env::temp_dir().join("unused-client-ws-session"),
        )
        .unwrap();
        session
            .cookies
            .values
            .lock()
            .unwrap()
            .parse("aixand-dev-session=secret; Path=/", &backend)
            .unwrap();
        let mut socket = session.socket("/api/terminals/ws").await.unwrap();
        socket
            .send(Message::Text("terminal input".into()))
            .await
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "terminal input"
        );
        server.await.unwrap();
        assert!(session.socket("/api/unsupported/ws").await.is_err());
    }

    #[tokio::test]
    async fn refuses_cookie_injection_and_does_not_follow_redirects() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            request_text(&mut stream).await;
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://evil.example/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        });
        let session = Session::new(
            backend,
            std::env::temp_dir().join("unused-client-redirect-session"),
        )
        .unwrap();
        let mut injected = get("/api/auth/status");
        injected.headers.push(("Cookie".into(), "stolen".into()));
        assert!(session.request(injected).await.is_err());
        assert_eq!(
            session
                .request(get("/api/auth/status"))
                .await
                .unwrap()
                .status,
            302
        );
        server.await.unwrap();
    }
}
