use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Submission {
    pub key: String,
    pub workflow: Value,
    #[serde(default = "object")]
    pub inputs: Value,
    #[serde(default = "object")]
    pub metadata: Value,
}

fn object() -> Value {
    json!({})
}

impl Submission {
    pub fn validate_envelope(&self) -> Result<()> {
        if self.key.trim().is_empty() || self.key.len() > 256 {
            return Err(Error::new(
                "request",
                "key must contain 1–256 bytes of nonempty text",
            ));
        }
        if !self.inputs.is_object() || !self.metadata.is_object() {
            return Err(Error::new(
                "request",
                "inputs and metadata must be JSON objects",
            ));
        }
        if let Some(context) = self.metadata.get("agent_context") {
            validate_agent_context(context)?;
        }
        if serde_json::to_vec(self)?.len() > MAX_REQUEST_BYTES {
            return Err(Error::new("request", "submission exceeds 4 MiB"));
        }
        Ok(())
    }

    pub fn digest(&self) -> Result<String> {
        digest(&serde_json::to_value(self)?)
    }
}

fn validate_agent_context(value: &Value) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| Error::new("agent_context", "Agent context must be an object"))?;
    if object
        .keys()
        .any(|key| key != "labels" && key != "metadata")
    {
        return Err(Error::new(
            "agent_context",
            "Agent context accepts labels and metadata only",
        ));
    }
    for kind in ["labels", "metadata"] {
        let Some(layer) = object.get(kind) else {
            continue;
        };
        let entries = layer.as_object().ok_or_else(|| {
            Error::new("agent_context", "Agent attributes must be string mappings")
        })?;
        if entries.len() > 64 {
            return Err(Error::new(
                "agent_context",
                "Agent attribute maps accept at most 64 entries",
            ));
        }
        for (key, value) in entries {
            let maximum = if kind == "labels" { 256 } else { 4096 };
            let value = value.as_str().ok_or_else(|| {
                Error::new("agent_context", "Agent attribute values must be strings")
            })?;
            if key.is_empty()
                || key.len() > 64
                || key.starts_with("agent_manager.")
                || key.chars().any(char::is_control)
                || value.len() > maximum
                || value.chars().any(char::is_control)
            {
                return Err(Error::new(
                    "agent_context",
                    "Invalid agent attribute key or value",
                ));
            }
        }
    }
    Ok(())
}

pub fn digest(value: &Value) -> Result<String> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(aixand_ir::canonicalize(value)?)
    ))
}

pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Blocked,
    Uncertain,
}

impl JobState {
    pub fn settled(self) -> bool {
        !matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub sequence: i64,
    pub id: String,
    pub state: JobState,
    pub submission: Submission,
    pub request_digest: String,
    pub engine_digest: String,
    pub attempt_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub cancel_requested: bool,
    pub result: Option<Value>,
    pub error: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JobSummary {
    pub sequence: i64,
    pub id: String,
    pub key: String,
    pub state: JobState,
    pub created_at: i64,
    pub updated_at: i64,
    pub cancel_requested: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Event {
    pub sequence: i64,
    pub job_id: String,
    pub recorded_at: i64,
    pub kind: String,
    pub data: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Events {
    pub events: Vec<Event>,
    pub state: JobState,
    pub next_after: i64,
    pub has_more: bool,
}

fn page_size() -> usize {
    100
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Health,
    Submit {
        submission: Submission,
    },
    List {
        #[serde(default)]
        after: i64,
        #[serde(default = "page_size")]
        limit: usize,
    },
    Inspect {
        id: String,
    },
    Lookup {
        key: String,
    },
    Result {
        id: String,
    },
    Events {
        id: String,
        #[serde(default)]
        after: i64,
        #[serde(default = "page_size")]
        limit: usize,
    },
    Cancel {
        id: String,
    },
    CancelKey {
        key: String,
    },
    Resume {
        id: String,
    },
    Plan {
        id: String,
    },
    Amend {
        id: String,
        key: String,
        expected_revision: u64,
        workflow: Value,
        #[serde(default)]
        authoring: Option<Value>,
    },
    Hold {
        id: String,
    },
    Release {
        id: String,
    },
    Continue {
        id: String,
        key: String,
        target: Submission,
        #[serde(default)]
        input_map: BTreeMap<String, String>,
    },
    Continuations {
        id: String,
    },
    CancelContinuation {
        id: String,
    },
    Runs {
        #[serde(default)]
        offset: usize,
        #[serde(default = "page_size")]
        limit: usize,
    },
    EnableEdits {
        id: String,
        key: String,
        #[serde(default)]
        authoring: Option<Value>,
        #[serde(default)]
        groups: BTreeMap<String, Vec<String>>,
        #[serde(default)]
        identities: BTreeMap<String, String>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Error>,
}

impl From<Result<Value>> for Response {
    fn from(value: Result<Value>) -> Self {
        match value {
            Ok(data) => Self {
                ok: true,
                data: Some(data),
                error: None,
            },
            Err(error) => Self {
                ok: false,
                data: None,
                error: Some(error),
            },
        }
    }
}
