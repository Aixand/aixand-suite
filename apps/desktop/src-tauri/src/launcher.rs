use url::Url;

pub fn authorize(label: &str, url: &Url, development_url: Option<&Url>) -> Result<(), String> {
    let bundled = url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")));
    // Match the exact configured development origin, including its port. A
    // Suite server or SSH tunnel on another local port is not the launcher.
    let development = development_url.is_some_and(|expected| {
        matches!(expected.scheme(), "http" | "https")
            && matches!(
                expected.host_str(),
                Some("localhost" | "127.0.0.1" | "[::1]")
            )
            && url.origin() == expected.origin()
    });
    if label != "main"
        || !url.username().is_empty()
        || url.password().is_some()
        || !(bundled || development)
    {
        return Err("Only the bundled connection window can manage desktop connections.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(label: &str, address: &str, development_url: Option<&str>) -> bool {
        authorize(
            label,
            &Url::parse(address).unwrap(),
            development_url
                .map(|address| Url::parse(address).unwrap())
                .as_ref(),
        )
        .is_ok()
    }

    #[test]
    fn accepts_packaged_launcher_urls_on_all_desktop_platforms() {
        for address in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
        ] {
            assert!(allowed("main", address, None), "{address}");
            assert!(!allowed("workspace", address, None), "{address}");
        }
    }

    #[test]
    fn accepts_tauri_development_server_without_trusting_other_local_services() {
        for address in [
            "http://localhost:1430/",
            "http://127.0.0.1:1431/",
            "http://[::1]:1432/",
        ] {
            assert!(allowed("main", address, Some(address)), "{address}");
            assert!(!allowed("main", address, None), "{address}");
            assert!(!allowed("workspace", address, Some(address)), "{address}");
        }
        let development = Some("http://localhost:1430/");
        for address in [
            "http://localhost:8753/",
            "http://127.0.0.1:1430/",
            "https://localhost:1430/",
            "http://localhost.evil.example:1430/",
        ] {
            assert!(!allowed("main", address, development), "{address}");
        }
    }

    #[test]
    fn rejects_arbitrary_origins_and_credential_urls() {
        for address in [
            "tauri://other/",
            "http://tauri.localhost:8753/",
            "http://tauri.localhost.evil.example/",
            "https://suite.example/",
            "http://192.0.2.1:1430/",
            "file:///tmp/index.html",
            "http://user:password@localhost:1430/",
            "tauri://user@localhost/",
        ] {
            assert!(!allowed("main", address, None), "{address}");
            assert!(!allowed("main", address, Some(address)), "{address}");
        }
    }
}
