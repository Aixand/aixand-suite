use aixand_ir::{OperationIdentity, ValidationError};
use serde::Serialize;

#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct Failure {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Box<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invocation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<Box<OperationIdentity>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cleanup_errors: Vec<Failure>,
}

impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
            invocation_id: None,
            operation: None,
            cleanup_errors: vec![],
        }
    }
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(Box::new(details));
        self
    }
    pub fn at(mut self, id: &str, identity: &OperationIdentity) -> Self {
        self.invocation_id = Some(id.into());
        self.operation = Some(Box::new(identity.clone()));
        self
    }
}
impl From<ValidationError> for Failure {
    fn from(error: ValidationError) -> Self {
        Self::new("validation", error.to_string())
            .with_details(serde_json::json!({"diagnostics":error.0}))
    }
}
