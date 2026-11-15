//! One Runner program for dependency graphs, native chats and SDK operations.
use crate::{Error, Result, engine::Observer};
use aixand_ir::{CatalogRegistry, Named, Value, Workflow, parse_catalog};
use aixand_ir_runner::{Binding, BindingRegistry, Failure, InvocationContext};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub const FORMAT: &str = "aixand.workflow-graph";
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Graph {
    pub format: String,
    pub version: u32,
    pub workflow: Workflow,
    pub dependencies: Named<Vec<String>>,
    #[serde(default)]
    pub context: Context,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub groups: Named<Vec<String>>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub identities: Named<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Context {
    pub project_id: Option<String>,
    pub origin_chat_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdk_approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<crate::permissions::PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_explicit_access: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_selection: Option<crate::profiles::ProfileSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_requirements: Option<Json>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_capture: Option<crate::profiles::ResourceCapture>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub chat_policies: Named<ChatPolicy>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChatPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdk_approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<crate::permissions::PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_selection: Option<crate::profiles::ProfileSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_requirements: Option<Json>,
}
impl Graph {
    pub fn parse(value: &Json) -> Result<Self> {
        let graph: Self = serde_json::from_value(value.clone())?;
        let sdk = crate::native::validate_sdk_execution(
            graph.context.provider.as_deref(),
            graph.context.backend.as_deref(),
            graph.context.sdk_approval_policy.as_deref(),
        )?;
        if sdk
            && (graph.context.permission_mode.is_some()
                || graph.context.require_explicit_access == Some(true))
        {
            return Err(Error::new(
                "validation",
                "SDK workflow context cannot claim Codex sandbox presets",
            ));
        }
        if graph.format != FORMAT
            || !matches!(graph.version, 1 | 2)
            || graph.dependencies.is_empty()
            || graph.dependencies.len() > 500
        {
            return Err(Error::new(
                "graph",
                "Use a version 1 workflow graph with 1–500 operations",
            ));
        }
        if graph.version == 2 {
            let ids: std::collections::BTreeSet<_> = graph
                .workflow
                .body
                .steps()
                .iter()
                .map(|step| step.id())
                .collect();
            let grouped: Vec<_> = graph
                .groups
                .values()
                .flatten()
                .map(String::as_str)
                .collect();
            let unique: std::collections::BTreeSet<_> = grouped.iter().copied().collect();
            if graph.groups.is_empty()
                || graph.groups.values().any(Vec::is_empty)
                || grouped.len() != unique.len()
                || unique != ids
            {
                return Err(Error::new(
                    "graph",
                    "Version 2 groups must cover every operation exactly once",
                ));
            }
            let deliveries: Vec<_> = graph
                .workflow
                .body
                .steps()
                .iter()
                .filter(|step| {
                    step.identity()
                        .is_some_and(|op| op.id == "carrier.human.deliver")
                })
                .collect();
            if deliveries.len() > 1 {
                return Err(Error::new("graph", "Use one final human delivery"));
            }
            if let Some(delivery) = deliveries.first() {
                let mut ancestors = std::collections::BTreeSet::new();
                let mut todo = graph
                    .dependencies
                    .get(delivery.id())
                    .cloned()
                    .unwrap_or_default();
                while let Some(id) = todo.pop() {
                    if ancestors.insert(id.clone()) {
                        todo.extend(graph.dependencies.get(&id).cloned().unwrap_or_default());
                    }
                }
                if ids
                    .iter()
                    .any(|id| *id != delivery.id() && !ancestors.contains(*id))
                {
                    return Err(Error::new(
                        "graph",
                        "Final delivery must wait for every other operation",
                    ));
                }
            }
        }
        if let Some(policy) = &graph.context.profile_selection {
            policy.validate()?;
        }
        if graph.context.resource_capture == Some(crate::profiles::ResourceCapture::Workflow)
            && graph.workflow.body.operations().iter().any(|step| {
                step.identity()
                    .is_some_and(|op| op.id == "aixand.project.chat")
                    && !graph
                        .context
                        .chat_policies
                        .get(step.id())
                        .and_then(|policy| policy.profile_requirements.as_ref())
                        .or(graph.context.profile_requirements.as_ref())
                        .is_some_and(crate::profiles::captured_resources)
            })
        {
            return Err(Error::new(
                "validation",
                "Workflow resource capture requires prepared immutable resources for every chat operation",
            ));
        }
        for (id, policy) in &graph.context.chat_policies {
            if graph.context.resource_capture == Some(crate::profiles::ResourceCapture::Workflow)
                && !policy
                    .profile_requirements
                    .as_ref()
                    .or(graph.context.profile_requirements.as_ref())
                    .is_some_and(crate::profiles::captured_resources)
            {
                return Err(Error::new(
                    "validation",
                    "Workflow resource capture requires prepared immutable chat resources",
                ));
            }
            if !graph.workflow.body.operations().iter().any(|step| {
                step.id() == id
                    && step
                        .identity()
                        .is_some_and(|op| op.id == "aixand.project.chat")
            }) {
                return Err(Error::new(
                    "validation",
                    "Chat policies must reference project chat operations",
                ));
            }
            if let Some(selection) = &policy.profile_selection {
                selection.validate()?;
            }
            let sdk = crate::native::validate_sdk_execution(
                graph.context.provider.as_deref(),
                graph.context.backend.as_deref(),
                graph.context.sdk_approval_policy.as_deref(),
            )?;
            if sdk
                && (policy.permission_mode.is_some()
                    || !matches!(policy.sdk_approval_policy.as_deref(), Some("ask" | "deny")))
            {
                return Err(Error::new(
                    "validation",
                    "SDK stages require explicit tool approval policies",
                ));
            }
            if !sdk && policy.permission_mode.is_none() {
                return Err(Error::new(
                    "validation",
                    "Prepare graph access before submission",
                ));
            }
        }
        if graph.context.require_explicit_access == Some(true)
            && graph.workflow.body.operations().iter().any(|step| {
                step.identity()
                    .is_some_and(|op| op.id == "aixand.project.chat")
                    && !graph.context.chat_policies.contains_key(step.id())
            })
        {
            return Err(Error::new(
                "validation",
                "Manual access requires a selection for every chat stage",
            ));
        }
        Ok(graph)
    }
    pub fn resumable(&self) -> bool {
        self.workflow.body.operations().iter().all(|step| {
            step.identity().is_some_and(|op| {
                [
                    "workflow.value",
                    "workflow.text",
                    "verifier.verify",
                    "aixand.project.chat",
                    "carrier.human.deliver",
                ]
                .contains(&op.id.as_str())
            })
        })
    }
    pub fn has_chats(&self) -> bool {
        self.workflow.body.operations().iter().any(|step| {
            step.identity()
                .is_some_and(|op| op.id == "aixand.project.chat")
        })
    }
    pub fn has_delivery(&self) -> bool {
        self.workflow.body.operations().iter().any(|step| {
            step.identity()
                .is_some_and(|op| op.id == "carrier.human.deliver")
        })
    }
}

pub fn catalog() -> Result<aixand_ir::Catalog> {
    let input = |kind: &str| json!({"type":{"kind":kind},"required":true});
    let output = |kind: &str| json!({"type":{"kind":kind}});
    Ok(parse_catalog(&json!({"contract_version":"0.1","package":{"id":"workflow","version":"1.0.0"},"operations":[
        {"id":"workflow.value","version":"1.0.0","inputs":{"value":input("json")},"outputs":{"value":output("json")}},
        {"id":"workflow.text","version":"1.0.0","inputs":{"value":input("json")},"outputs":{"text":output("string")}},
        {"id":"aixand.project.chat","version":"1.0.0","inputs":{"title":input("string"),"instruction":input("string"),"reports":input("json")},"outputs":{"result":output("json")}},
        {"id":"carrier.human.deliver","version":"1.0.0","inputs":{"title":input("string"),"value":input("json")},"outputs":{"delivery":output("json")}}
    ]}).to_string())?)
}

pub async fn rpc(socket: &Path, op: &str, args: Json) -> Result<Json> {
    const LIMIT: usize = 4 * 1024 * 1024;
    let exchange = async {
        let mut stream = crate::transport::connect(socket).await.map_err(|error| {
            Error::new(
                "suite_unavailable",
                format!("Suite RPC {op} could not connect: {error}"),
            )
        })?;
        let mut frame = serde_json::to_vec(&json!({"op":op,"args":args}))?;
        frame.push(b'\n');
        stream.write_all(&frame).await.map_err(|error| {
            Error::new("suite_unavailable", format!("Suite RPC {op} request write was interrupted: {error}; reconcile the same operation identity"))
        })?;
        let mut bytes = Vec::new();
        BufReader::new(stream)
            .take(LIMIT as u64 + 1)
            .read_until(b'\n', &mut bytes)
            .await.map_err(|error| {
                Error::new("suite_unavailable", format!("Suite RPC {op} response read was interrupted: {error}; reconcile the same operation identity"))
            })?;
        let diagnostic = |code: &str, message: String| Error {
            code: code.into(),
            message,
            details: Some(json!({"operation":op,"response_bytes":bytes.len(),
                "frame_limit_bytes":LIMIT,"newline_terminated":bytes.last() == Some(&b'\n')})),
        };
        if bytes.len() > LIMIT {
            return Err(diagnostic(
                "suite_response_limit",
                format!(
                    "Suite RPC {op} response exceeds {LIMIT}-byte limit (received at least {} bytes)",
                    bytes.len()
                ),
            ));
        }
        if bytes.last() != Some(&b'\n') {
            return Err(diagnostic(
                "suite_unavailable",
                format!(
                    "Suite RPC {op} response ended after {} bytes without a newline; reconcile the same operation identity",
                    bytes.len()
                ),
            ));
        }
        let malformed = || {
            diagnostic(
                "suite_protocol",
                format!(
                    "Suite RPC {op} returned an invalid JSON response envelope ({} bytes, newline present)",
                    bytes.len()
                ),
            )
        };
        let response: Json = serde_json::from_slice(&bytes).map_err(|_| malformed())?;
        match response.get("ok").and_then(Json::as_bool) {
            Some(true) => response.get("data").cloned().ok_or_else(malformed),
            Some(false) => {
                let error = response.get("error").ok_or_else(malformed)?;
                let code = error
                    .get("code")
                    .and_then(Json::as_str)
                    .ok_or_else(malformed)?;
                let message = error
                    .get("message")
                    .and_then(Json::as_str)
                    .ok_or_else(malformed)?;
                Err(Error::new(code, message))
            }
            None => Err(malformed()),
        }
    };
    let result = tokio::time::timeout(Duration::from_secs(25), exchange)
        .await
        .map_err(|_| {
            Error::new(
                "suite_unavailable",
                format!("Suite RPC {op} timed out; reconcile the same operation identity"),
            )
        })?;
    if let Err(error) = &result
        && matches!(
            error.code.as_str(),
            "suite_unavailable" | "suite_protocol" | "suite_response_limit"
        )
    {
        // Frame diagnostics omit response bodies, prompts and credentials.
        eprintln!("Runner workflow transport: {error}");
    }
    result
}

fn failure(error: Error) -> Failure {
    Failure::new(&error.code, error.message)
}
fn transient(error: &Error) -> bool {
    matches!(
        error.code.as_str(),
        "suite_unavailable" | "carrier_unavailable" | "io"
    )
}
pub async fn validate(graph: &Graph, socket: &Path) -> Result<()> {
    if graph.has_chats() || graph.has_delivery() {
        rpc(
            socket,
            "graph_validate",
            json!({"context":graph.context,"chats":graph.has_chats()}),
        )
        .await?;
    }
    Ok(())
}

pub struct Effects {
    pub agent_context: Json,
    pub job_id: String,
    pub context: Context,
    pub observer: Observer,
    pub socket: PathBuf,
    pub control: Option<Arc<crate::plans::PlanControl>>,
}
impl Effects {
    async fn retry(
        &self,
        op: &str,
        args: Json,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> std::result::Result<Json, Failure> {
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => return Err(Failure::new("cancelled", "Execution cancelled")),
                result = rpc(&self.socket, op, args.clone()) => match result {
                    Ok(value) => return Ok(value),
                    Err(error) if transient(&error) => (),
                    Err(error) => return Err(failure(error)),
                }
            }
            tokio::select! { _ = cancellation.cancelled() => return Err(Failure::new("cancelled", "Execution cancelled")), _ = tokio::time::sleep(Duration::from_secs(1)) => () }
        }
    }
}
#[async_trait]
impl Binding for Effects {
    async fn invoke(
        &self,
        context: InvocationContext,
        inputs: Named<Value>,
    ) -> std::result::Result<Named<Value>, Failure> {
        let values = Value::Object(Arc::new(inputs)).to_json()?;
        let (name, result) = match context.operation.id.as_str() {
            "workflow.value" => ("value", values["value"].clone()),
            "workflow.text" => ("text", json!(report_text(&values["value"]))),
            "carrier.human.deliver" => ("delivery", self.retry("graph_publish", json!({"job_id":self.job_id,"context":self.context,"title":values["title"],"value":values["value"],"failed":false}), &context.cancellation).await?),
            "aixand.project.chat" => {
                let id = context.invocation_id;
                let reports = values["reports"].as_object().ok_or_else(|| Failure::new("graph", "Chat reports must be an object"))?;
                let args = json!({"job_id":self.job_id,"context":self.context,"step":{"id":id,"title":values["title"],"instruction":values["instruction"],"depends_on":reports.keys().collect::<Vec<_>>()},"inputs":reports});
                let mut args = args;
                if let Some(policy) = self.context.chat_policies.get(&id) {
                    for (key, value) in [("permission_mode", serde_json::to_value(policy.permission_mode).map_err(|e| Failure::new("policy", e.to_string()))?),
                                         ("sdk_approval_policy", json!(policy.sdk_approval_policy)),
                                         ("permission_source", json!(policy.permission_source)),
                                         ("profile_selection", serde_json::to_value(&policy.profile_selection).map_err(|e| Failure::new("policy", e.to_string()))?),
                                         ("profile_requirements", json!(policy.profile_requirements))] {
                        if !value.is_null() { args["step"][key] = value; }
                    }
                }
                let args = if self.agent_context != json!({}) {
                    let mut args = args;
                    args["agent_context"] = self.agent_context.clone();
                    args
                } else { args };
                let args = match &self.control { Some(control)=>control.request(&id,&args).map_err(failure)?,None=>args };
                let mut progress = self.retry(if self.control.is_some() {"graph_start_v2"} else {"graph_start"}, args, &context.cancellation).await?;
                let mut previous = Json::Null;
                loop {
                    let event = json!({"event":"chat_step","invocation":id,"status":progress["state"],"chat_id":progress["chat_id"],"error":progress["error"],
                        "sdk_approval_policy":progress["sdkApprovalPolicy"],"permission_mode":progress["permissionMode"],"permission_source":progress["permissionSource"],"profile_selection":progress["profileSelection"],"profile_decision":progress["profileDecision"]});
                    if event != previous { (self.observer)(event.clone()); previous = event; }
                    match progress["state"].as_str() {
                        Some("completed" | "failed") => {
                            self.retry("ack_result", json!({"job_id":self.job_id,"step_id":id}), &context.cancellation).await?;
                            if progress["state"] == "failed" { return Err(Failure::new("task_failed", progress["error"].as_str().unwrap_or("Project chat failed"))); }
                            break;
                        },
                        Some("uncertain") => return Err(Failure::new("effect_uncertain", progress["error"].as_str().unwrap_or("Chat acceptance is unconfirmed"))),
                        Some("cancelled") => return Err(Failure::new("cancelled", "Project chat was cancelled")),
                        _ => (),
                    }
                    tokio::select! { _ = context.cancellation.cancelled() => return Err(Failure::new("cancelled", "Execution cancelled")), _ = tokio::time::sleep(Duration::from_secs(1)) => () }
                    progress = self.retry("inspect", json!({"job_id":self.job_id,"step_id":id}), &context.cancellation).await?;
                }
                ("result", progress["result"].clone())
            },
            _ => return Err(Failure::new("binding", "Unknown graph operation")),
        };
        Ok(Named::from([(name.into(), Value::from_json(&result)?)]))
    }
}
pub fn install(
    catalogs: &CatalogRegistry,
    bindings: &mut BindingRegistry,
    effects: Arc<Effects>,
) -> Result<()> {
    for id in [
        "workflow.value",
        "workflow.text",
        "aixand.project.chat",
        "carrier.human.deliver",
    ] {
        let identity = aixand_ir::OperationIdentity {
            id: id.into(),
            version: "1.0.0".into(),
        };
        let definition = catalogs
            .resolve(&identity)
            .ok_or_else(|| Error::new("catalog", "Missing graph operation"))?
            .clone();
        bindings
            .register(definition, effects.clone())
            .map_err(Error::from)?;
    }
    Ok(())
}
fn report_text(value: &Json) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    if let Some(object) = value.as_object() {
        for field in ["report", "content", "final_reply_text"] {
            if let Some(text) = object.get(field).and_then(Json::as_str) {
                return text.to_owned();
            }
        }
        return object
            .iter()
            .map(|(name, value)| format!("### {name}\n\n{}", report_text(value)))
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    serde_json::to_string_pretty(value).unwrap_or_default()
}
