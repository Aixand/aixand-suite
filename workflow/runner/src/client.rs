use crate::{
    Error, Result,
    model::{MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, Request, Response},
    service::read_frame,
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncWriteExt;

#[derive(Clone)]
pub struct Client {
    socket: PathBuf,
}

impl Client {
    pub fn new(home: impl AsRef<Path>) -> Self {
        Self {
            socket: home.as_ref().join("runner.sock"),
        }
    }

    pub async fn request(&self, request: Request) -> Result<Value> {
        tokio::time::timeout(Duration::from_secs(30), async {
            let mut bytes = serde_json::to_vec(&request)?;
            bytes.push(b'\n');
            if bytes.len() > MAX_REQUEST_BYTES {
                return Err(Error::new("request_limit", "Request exceeds 4 MiB"));
            }
            let mut stream = crate::transport::connect(&self.socket).await.map_err(|e| {
                Error::new(
                    "connection",
                    format!(
                        "{}: {e}; start runner serve with the same --home",
                        self.socket.display()
                    ),
                )
            })?;
            stream.write_all(&bytes).await?;
            let bytes = read_frame(&mut stream, MAX_RESPONSE_BYTES).await?;
            let response: Response = serde_json::from_slice(&bytes)?;
            if response.ok {
                response
                    .data
                    .ok_or_else(|| Error::new("protocol", "Successful response has no data"))
            } else {
                Err(response
                    .error
                    .unwrap_or_else(|| Error::new("protocol", "Failed response has no error")))
            }
        })
        .await
        .map_err(|_| {
            Error::new(
                "timeout",
                "Request timed out; a submission may have committed. Retry using the same key.",
            )
        })?
    }
}

pub fn default_home() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("RUNNER_HOME") {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = std::env::var_os("XDG_STATE_HOME") {
        return Ok(PathBuf::from(path).join("runner"));
    }
    if cfg!(windows)
        && let Some(path) = std::env::var_os("LOCALAPPDATA")
    {
        return Ok(PathBuf::from(path).join("Aixand/Runner"));
    }
    std::env::var_os("HOME")
        .map(|p| PathBuf::from(p).join(".local/state/runner"))
        .ok_or_else(|| Error::new("configuration", "Set RUNNER_HOME or pass --home"))
}
