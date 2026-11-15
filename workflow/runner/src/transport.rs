//! Platform-local byte streams. Windows uses a protected capability descriptor;
//! service traffic stays on loopback and is authenticated before JSON dispatch.
#[cfg(unix)]
pub use tokio::net::{UnixListener as Listener, UnixStream as Stream};

#[cfg(unix)]
pub async fn connect(path: &std::path::Path) -> std::io::Result<Stream> {
    Stream::connect(path).await
}

#[cfg(windows)]
pub use windows::{Listener, connect};
#[cfg(windows)]
pub type Stream = tokio::net::TcpStream;

#[cfg(windows)]
mod windows {
    use super::Stream;
    use serde::{Deserialize, Serialize};
    use std::{
        io::{self, Read, Write},
        path::{Path, PathBuf},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use undercurrent_platform_windows::open_private_file;

    #[derive(Serialize, Deserialize)]
    struct Endpoint {
        schema: String,
        port: u16,
        token: String,
    }

    pub async fn connect(path: &Path) -> io::Result<Stream> {
        let mut source = open_private_file(path, false, false)?.into_file();
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut source)
            .take(4097)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 4096 {
            return Err(io::Error::other("Invalid local endpoint"));
        }
        let endpoint: Endpoint = serde_json::from_slice(&bytes)?;
        if endpoint.schema != "aixand.local/1" || endpoint.port < 1024 || endpoint.token.len() != 64
        {
            return Err(io::Error::other("Invalid local endpoint"));
        }
        let mut stream = Stream::connect((std::net::Ipv4Addr::LOCALHOST, endpoint.port)).await?;
        stream
            .write_all(format!("{{\"token\":\"{}\"}}\n", endpoint.token).as_bytes())
            .await?;
        Ok(stream)
    }

    pub struct Listener {
        inner: tokio::net::TcpListener,
        path: PathBuf,
        token: String,
    }
    impl Listener {
        pub async fn bind(path: &Path) -> io::Result<Self> {
            let inner = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
            let token = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            let endpoint = Endpoint {
                schema: "aixand.local/1".into(),
                port: inner.local_addr()?.port(),
                token: token.clone(),
            };
            let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
            let mut target = open_private_file(&temporary, true, true)?.into_file();
            target.write_all(&serde_json::to_vec(&endpoint)?)?;
            target.sync_all()?;
            drop(target);
            std::fs::rename(&temporary, path)?;
            Ok(Self {
                inner,
                path: path.into(),
                token,
            })
        }
        pub async fn accept(&self) -> io::Result<(Stream, ())> {
            loop {
                let (mut stream, _) = self.inner.accept().await?;
                let authenticated =
                    tokio::time::timeout(std::time::Duration::from_secs(5), async {
                        let mut bytes = Vec::new();
                        loop {
                            let byte = stream.read_u8().await?;
                            if byte == b'\n' {
                                break;
                            }
                            bytes.push(byte);
                            if bytes.len() > 256 {
                                return Err(io::Error::other("Invalid local authentication"));
                            }
                        }
                        let value: serde_json::Value = serde_json::from_slice(&bytes)?;
                        if value["token"].as_str() != Some(&self.token) {
                            return Err(io::Error::other("Invalid local authentication"));
                        }
                        Ok::<_, io::Error>(())
                    })
                    .await;
                if matches!(authenticated, Ok(Ok(()))) {
                    return Ok((stream, ()));
                }
            }
        }
    }
    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
