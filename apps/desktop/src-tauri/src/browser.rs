use url::Url;

fn web_link(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn open(url: &Url) -> Result<(), &'static str> {
    if !web_link(url) {
        return Err("Only HTTP and HTTPS links can open in your browser.");
    }
    open::that_detached(url.as_str()).map_err(
        |_| "Could not open your browser. Copy the sign-in link and open it in your browser.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_sign_in_pages_and_web_links() {
        for address in [
            "https://auth.openai.com/codex/device",
            "https://auth.openai.com/authorize?state=opaque&redirect_uri=http%3A%2F%2Flocalhost%3A1455",
            "https://github.com/login/device",
            "http://127.0.0.1:8753/",
        ] {
            assert!(web_link(&Url::parse(address).unwrap()), "{address}");
        }
    }

    #[test]
    fn rejects_local_files_custom_protocols_and_embedded_credentials() {
        for address in [
            "file:///tmp/sign-in.html",
            "javascript:alert(1)",
            "data:text/html,sign-in",
            "about:blank",
            "tauri://localhost/",
            "ms-settings:privacy",
            "https://user:password@auth.openai.com/",
            "https://user@auth.openai.com/",
        ] {
            assert!(!web_link(&Url::parse(address).unwrap()), "{address}");
        }
    }
}
