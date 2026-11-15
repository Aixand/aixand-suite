use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Error {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new("io", e.to_string())
    }
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::new("storage", e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::new("json", e.to_string())
    }
}
impl From<aixand_ir::ValidationError> for Error {
    fn from(e: aixand_ir::ValidationError) -> Self {
        Self {
            code: "validation".into(),
            message: e.to_string(),
            details: Some(serde_json::json!({"diagnostics": e.0})),
        }
    }
}
impl From<aixand_ir_runner::Failure> for Error {
    fn from(e: aixand_ir_runner::Failure) -> Self {
        Self {
            code: e.code.clone(),
            message: e.message.clone(),
            details: serde_json::to_value(e).ok(),
        }
    }
}
