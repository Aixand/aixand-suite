use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Duration;
use url::Url;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub address: String,
    #[serde(default)]
    pub local: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub profiles: Vec<Profile>,
    pub selected_id: String,
    pub auto_connect: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            profiles: vec![],
            selected_id: String::new(),
            auto_connect: false,
        }
    }
}

pub fn server_url(address: &str) -> Result<Url, String> {
    if address.len() > 2048 {
        return Err("The server address is too long.".into());
    }
    let url = Url::parse(address.trim()).map_err(|_| {
        "Enter a complete server address, including http:// or https://.".to_string()
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(
            "Use the server's root HTTP(S) address without credentials, a path, or a query.".into(),
        );
    }
    if url.scheme() == "http"
        && !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
    {
        return Err("Use HTTPS for a network server, or a loopback address for a local service or SSH tunnel.".into());
    }
    Ok(url)
}

impl Settings {
    pub fn validate(mut self) -> Result<Self, String> {
        if self.profiles.len() > 20 {
            return Err("Keep no more than twenty saved connections.".into());
        }
        if self.profiles.is_empty() {
            if !self.selected_id.is_empty() {
                return Err("Select a saved connection.".into());
            }
            self.auto_connect = false;
            return Ok(self);
        }
        let mut ids = HashSet::new();
        for profile in &mut self.profiles {
            if profile.id.is_empty()
                || profile.id.len() > 64
                || !profile
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                || !ids.insert(profile.id.clone())
            {
                return Err("Saved connection identifiers must be unique.".into());
            }
            profile.name = profile.name.trim().to_string();
            if profile.name.is_empty() || profile.name.chars().count() > 80 {
                return Err("Give each connection a name between 1 and 80 characters.".into());
            }
            profile.address = server_url(&profile.address)?.to_string();
            if profile.local {
                let url = server_url(&profile.address)?;
                if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
                    return Err(
                        "A local workspace must use this computer's loopback address.".into(),
                    );
                }
            }
        }
        self.selected()?;
        Ok(self)
    }

    pub fn selected(&self) -> Result<&Profile, String> {
        self.profiles
            .iter()
            .find(|profile| profile.id == self.selected_id)
            .ok_or_else(|| "Select a saved connection.".into())
    }
}

pub fn http_client(address: &Url) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(8));
    if matches!(
        address.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]")
    ) {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|_| "Could not prepare the server connection.".into())
}

pub async fn probe(client: &reqwest::Client, address: &Url) -> Result<Option<String>, String> {
    let endpoint = address
        .join("api/health")
        .map_err(|_| "Invalid server address.".to_string())?;
    let mut response = client.get(endpoint).send().await
        .map_err(|_| "Cannot reach Aixand. Check that the server and, if needed, your SSH tunnel are running.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "The server returned HTTP {}. Check the connection address.",
            response.status().as_u16()
        ));
    }
    if response
        .headers()
        .get("x-aixand-protocol")
        .is_some_and(|value| value != "1")
    {
        return Err("This server uses an incompatible Aixand API. Update Desktop and Server to compatible releases.".into());
    }
    let workspace = response
        .headers()
        .get("x-aixand-workspace")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The server connection was interrupted.".to_string())?
    {
        if body.len() + chunk.len() > 64 * 1024 {
            return Err("The address did not return a valid Aixand health response.".into());
        }
        body.extend_from_slice(&chunk);
    }
    let health: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| "The address did not return a valid Aixand health response.".to_string())?;
    if health["service"] != "aixand-server" || health["status"] != "ok" {
        return Err("This address is not a healthy Aixand server.".into());
    }
    Ok(workspace)
}

pub async fn probe_frontend(client: &reqwest::Client, address: &Url) -> Result<(), String> {
    let response = client.get(address.clone()).send().await.map_err(|_| {
        "Cannot load the Aixand interface. Check the server connection.".to_string()
    })?;
    let html = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/html"));
    if !response.status().is_success() || !html {
        return Err(
            "This address does not serve the Aixand interface. Check your server address.".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn response_server(status: &str, kind: &str, body: &str) -> (Url, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request);
            let _ = socket.write_all(response.as_bytes());
        });
        (address, thread)
    }

    #[test]
    fn checks_server_identity_and_limits_health_response_size() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = http_client(&Url::parse("http://127.0.0.1:8753/").unwrap()).unwrap();
        for (body, accepted) in [
            (
                r#"{"status":"ok","service":"aixand-server"}"#.to_string(),
                true,
            ),
            (
                r#"{"status":"ok","service":"other-server"}"#.to_string(),
                false,
            ),
            ("<html>Sign in elsewhere</html>".to_string(), false),
            ("x".repeat(70 * 1024), false),
        ] {
            let (address, server) = response_server("200 OK", "application/json", &body);
            assert_eq!(runtime.block_on(probe(&client, &address)).is_ok(), accepted);
            server.join().unwrap();
        }
    }

    #[test]
    fn rejects_redirects_and_missing_frontend_instead_of_opening_an_error_page() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = http_client(&Url::parse("http://127.0.0.1:8753/").unwrap()).unwrap();
        let (address, server) = response_server(
            "302 Found\r\nLocation: http://127.0.0.1:1/",
            "text/html",
            "redirect",
        );
        assert!(
            runtime
                .block_on(probe(&client, &address))
                .unwrap_err()
                .contains("302")
        );
        server.join().unwrap();
        let (address, server) = response_server("404 Not Found", "application/json", "{}");
        assert!(runtime.block_on(probe_frontend(&client, &address)).is_err());
        server.join().unwrap();
        let (address, server) = response_server(
            "200 OK",
            "text/html; charset=utf-8",
            "<!doctype html><title>Aixand</title>",
        );
        assert!(runtime.block_on(probe_frontend(&client, &address)).is_ok());
        server.join().unwrap();
    }

    #[test]
    fn accepts_loopback_and_https_but_not_credentials_or_arbitrary_navigation() {
        for address in [
            "http://127.0.0.1:8753",
            "http://localhost:8753/",
            "http://[::1]:8753/",
            "https://suite.example/",
        ] {
            assert!(server_url(address).is_ok(), "{address}");
        }
        for address in [
            "http://127.0.0.1:87532",
            "http://192.0.2.1:8753",
            "https://user:password@suite.example/",
            "https://suite.example/api",
            "https://suite.example/?token=secret",
            "file:///tmp/index.html",
            "javascript:alert(1)",
        ] {
            assert!(server_url(address).is_err(), "{address}");
        }
    }

    #[test]
    fn validates_saved_selection_and_prevents_duplicate_profiles() {
        assert!(Settings::default().validate().unwrap().profiles.is_empty());
        let mut settings = Settings::default();
        settings.selected_id = "missing".into();
        assert!(settings.validate().is_err());
        let mut settings: Settings = serde_json::from_str(r#"{"profiles":[{"id":"remote","name":"Remote","address":"https://suite.example/"}],"selectedId":"remote","autoConnect":false}"#).unwrap();
        settings.profiles.push(settings.profiles[0].clone());
        assert!(settings.validate().is_err());
    }

    #[test]
    fn upgrades_existing_remote_profiles_and_keeps_local_profiles_on_loopback() {
        let settings: Settings = serde_json::from_str(r#"{"profiles":[{"id":"remote","name":"Remote","address":"https://suite.example/"}],"selectedId":"remote","autoConnect":false}"#).unwrap();
        assert!(!settings.validate().unwrap().selected().unwrap().local);
        let mut settings: Settings = serde_json::from_str(r#"{"profiles":[{"id":"local","name":"Local workspace","address":"http://127.0.0.1:8753/","local":true}],"selectedId":"local","autoConnect":false}"#).unwrap();
        assert!(settings.clone().validate().is_ok());
        settings.profiles[0].address = "https://suite.example/".into();
        assert!(settings.validate().is_err());
    }

    #[test]
    fn empty_settings_do_not_connect_automatically() {
        let mut settings = Settings::default();
        settings.auto_connect = true;
        let settings = settings.validate().unwrap();
        assert!(!settings.auto_connect);
        assert!(settings.selected().is_err());
    }
}
