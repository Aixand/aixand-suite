use serde::Serialize;
use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub location: String,
    pub severity: Severity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invocation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<crate::OperationIdentity>,
}

impl Diagnostic {
    pub fn error(code: &str, location: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            location: location.into(),
            severity: Severity::Error,
            invocation_id: None,
            operation: None,
        }
    }
    pub fn warning(code: &str, location: &str, message: impl Into<String>) -> Self {
        Self {
            severity: Severity::Warning,
            ..Self::error(code, location, message)
        }
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: {}: {}",
            if self.location.is_empty() {
                "/"
            } else {
                &self.location
            },
            self.code,
            self.message
        )
    }
}

#[derive(Clone, Debug)]
pub struct ValidationError(pub Vec<Diagnostic>);
impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, d) in self.0.iter().enumerate() {
            if i > 0 {
                writeln!(f)?;
            }
            write!(f, "{d}")?;
        }
        Ok(())
    }
}
impl std::error::Error for ValidationError {}
impl From<Diagnostic> for ValidationError {
    fn from(d: Diagnostic) -> Self {
        Self(vec![d])
    }
}

pub fn pointer(base: &str, segment: impl fmt::Display) -> String {
    format!(
        "{base}/{}",
        segment.to_string().replace('~', "~0").replace('/', "~1")
    )
}
