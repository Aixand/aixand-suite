//! Native chat dependencies are executed by Runner. Suite is an idempotent effect adapter.
use crate::{
    Error, Result, Submission,
    engine::{Engine, ExecutionJournal, Observer},
    model::digest,
    permissions::PermissionMode,
};
use aixand_ir_runner::Failure;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatStep {
    pub id: String,
    pub title: String,
    pub instruction: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdk_approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_selection: Option<crate::profiles::ProfileSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_requirements: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_names: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatWorkflow {
    pub format: String,
    pub version: u32,
    pub name: String,
    pub project_id: String,
    pub origin_chat_id: String,
    pub profile: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdk_approval_policy: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_selection: Option<crate::profiles::ProfileSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_requirements: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_capture: Option<crate::profiles::ResourceCapture>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub require_explicit_access: bool,
    pub steps: Vec<ChatStep>,
    pub delivery_step: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub inputs: BTreeMap<String, aixand_ir::WorkflowInput>,
}

impl ChatWorkflow {
    pub fn parse(value: &Value) -> Result<Self> {
        let plan: Self = serde_json::from_value(value.clone())?;
        if plan.format != "aixand.chat-workflow" || !matches!(plan.version, 1 | 2) {
            return Err(Error::new(
                "workflow_version",
                "Unsupported chat workflow version",
            ));
        }
        if plan.name.trim().is_empty()
            || plan.name.len() > 240
            || plan.steps.is_empty()
            || plan.steps.len() > 16
        {
            return Err(Error::new(
                "validation",
                "A chat workflow needs a name and 1–16 steps",
            ));
        }
        for id in [&plan.project_id, &plan.origin_chat_id] {
            uuid::Uuid::parse_str(id).map_err(|_| {
                Error::new(
                    "validation",
                    "Saved project and source chat UUIDs are required",
                )
            })?;
        }
        if let Some(policy) = &plan.profile_selection {
            policy.validate()?;
        }
        let sdk = validate_sdk_execution(
            plan.provider.as_deref(),
            plan.backend.as_deref(),
            plan.sdk_approval_policy.as_deref(),
        )?;
        if sdk && (plan.permission_mode.is_some() || plan.require_explicit_access) {
            return Err(Error::new(
                "validation",
                "SDK workflows cannot claim Codex sandbox presets",
            ));
        }
        let mut ids = BTreeSet::new();
        for step in &plan.steps {
            if sdk
                && (step.permission_mode.is_some()
                    || step
                        .sdk_approval_policy
                        .as_deref()
                        .is_some_and(|p| !matches!(p, "ask" | "deny")))
                || !sdk && step.sdk_approval_policy.is_some()
            {
                return Err(Error::new(
                    "validation",
                    "Invalid stage SDK approval policy",
                ));
            }
            if plan.resource_capture == Some(crate::profiles::ResourceCapture::Workflow)
                && !step
                    .profile_requirements
                    .as_ref()
                    .or(plan.profile_requirements.as_ref())
                    .is_some_and(crate::profiles::captured_resources)
            {
                return Err(Error::new(
                    "validation",
                    "Workflow resource capture requires prepared immutable resources for every stage",
                ));
            }
            if let Some(policy) = &step.profile_selection {
                policy.validate()?;
            }
            if plan.require_explicit_access
                && step.permission_mode.is_none()
                && plan.permission_mode.is_none()
            {
                return Err(Error::new(
                    "validation",
                    format!("Manual access requires permission_mode for {}", step.id),
                ));
            }
            if step.id.is_empty()
                || step.id.len() > 64
                || !step
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                || !ids.insert(step.id.clone())
            {
                return Err(Error::new(
                    "validation",
                    "Step IDs must be unique identifiers of up to 64 bytes",
                ));
            }
            if step.title.trim().is_empty()
                || step.title.chars().count() > 120
                || step.instruction.trim().is_empty()
                || step.instruction.chars().count() > 24_000
            {
                return Err(Error::new(
                    "validation",
                    "Each step needs a title and instructions of up to 24000 characters",
                ));
            }
        }
        if !ids.contains(&plan.delivery_step) {
            return Err(Error::new(
                "validation",
                "Delivery must reference a workflow step",
            ));
        }
        for step in &plan.steps {
            let dependencies: BTreeSet<_> = step.depends_on.iter().collect();
            if dependencies.len() != step.depends_on.len()
                || dependencies
                    .iter()
                    .any(|id| !ids.contains(*id) || **id == step.id)
            {
                return Err(Error::new(
                    "validation",
                    "Dependencies must reference distinct other steps",
                ));
            }
            let inputs: BTreeSet<_> = step.input_names.iter().collect();
            if (plan.version == 1 && (!inputs.is_empty() || !plan.inputs.is_empty()))
                || inputs.len() != step.input_names.len()
                || inputs
                    .iter()
                    .any(|name| !plan.inputs.contains_key(*name) || ids.contains(*name))
            {
                return Err(Error::new(
                    "validation",
                    "Stage inputs must reference distinct declared workflow inputs",
                ));
            }
        }
        for (name, input) in &plan.inputs {
            if name.is_empty() || name.len() > 64 || !input.ty.json_only() {
                return Err(Error::new(
                    "validation",
                    "Native inputs need names and JSON types",
                ));
            }
            aixand_ir::validate_type(&input.ty, "/inputs")?;
        }
        let mut visited = BTreeSet::new();
        loop {
            let before = visited.len();
            for step in &plan.steps {
                if step.depends_on.iter().all(|id| visited.contains(id)) {
                    visited.insert(step.id.clone());
                }
            }
            if visited.len() == plan.steps.len() {
                break;
            }
            if visited.len() == before {
                return Err(Error::new(
                    "validation",
                    "Workflow dependencies contain a cycle",
                ));
            }
        }
        Ok(plan)
    }

    fn resolved_inputs(&self, supplied: &Value) -> Result<BTreeMap<String, Value>> {
        let mut inputs: BTreeMap<String, Value> = serde_json::from_value(supplied.clone())?;
        if inputs.keys().any(|name| !self.inputs.contains_key(name)) {
            return Err(Error::new("validation", "Unknown workflow input"));
        }
        for (name, input) in &self.inputs {
            if !inputs.contains_key(name) {
                inputs.insert(
                    name.clone(),
                    input
                        .default
                        .clone()
                        .ok_or_else(|| Error::new("validation", format!("Missing input {name}")))?,
                );
            }
            aixand_ir::validate_value(
                &aixand_ir::Value::from_json(&inputs[name])?,
                &input.ty,
                "/inputs",
            )?;
        }
        Ok(inputs)
    }
}

pub(crate) fn validate_sdk_execution(
    provider: Option<&str>,
    backend: Option<&str>,
    policy: Option<&str>,
) -> Result<bool> {
    if provider.is_none() && backend.is_none() && policy.is_none() {
        return Ok(false);
    }
    if provider == Some("codex") && backend == Some("native-codex") && policy.is_none() {
        return Ok(false);
    }
    if matches!(
        (provider, backend),
        (Some("claude"), Some("claude-sdk" | "claude-acp"))
            | (Some("antigravity"), Some("antigravity-sdk"))
            | (Some("codex"), Some("codex-acp"))
            | (Some("opencode"), Some("opencode-native" | "opencode-acp"))
            | (Some("copilot"), Some("copilot-acp" | "copilot-sdk"))
    ) && matches!(policy, Some("ask" | "deny"))
    {
        return Ok(true);
    }
    Err(Error::new(
        "validation",
        "Workflow provider, backend and approval policy must match",
    ))
}

pub fn default_suite_socket() -> PathBuf {
    if let Some(path) = std::env::var_os("SUITE_WORKFLOW_SOCKET") {
        return path.into();
    }
    let state = std::env::var_os("AGENTS_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("XDG_STATE_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state")
                })
                .join("aixand/chats")
        });
    state.join("native-workflows.sock")
}

pub struct WorkflowEngine {
    ir: Arc<dyn Engine>,
    socket: PathBuf,
    fingerprint: String,
    mutable_fingerprint: String,
    poll_interval: Duration,
}

impl WorkflowEngine {
    pub fn new(ir: Arc<dyn Engine>, socket: PathBuf) -> Result<Self> {
        let fingerprint =
            digest(&json!({"ir":ir.fingerprint(),"native_chat_workflow":1,"suite_socket":socket}))?;
        let mutable_fingerprint = digest(&json!({"legacy":fingerprint,"native_chat_workflow":2}))?;
        Ok(Self {
            ir,
            socket,
            fingerprint,
            mutable_fingerprint,
            poll_interval: Duration::from_secs(1),
        })
    }

    async fn rpc(&self, op: &str, args: Value) -> Result<Value> {
        crate::graph::rpc(&self.socket, op, args).await
    }

    async fn run(
        &self,
        submission: Submission,
        observer: Observer,
        cancellation: CancellationToken,
        journal: ExecutionJournal,
    ) -> std::result::Result<Value, Failure> {
        let mut plan = ChatWorkflow::parse(&submission.workflow).map_err(failure)?;
        let supplied_inputs = plan.resolved_inputs(&submission.inputs).map_err(failure)?;
        let mut checkpoint = journal.checkpoint;
        if !checkpoint.is_object() {
            return Err(Failure::new("checkpoint", "Invalid workflow checkpoint"));
        }
        if checkpoint.get("steps").is_none() {
            checkpoint["steps"] = json!({});
        }
        observer(json!({"event":"prepared","warnings":[]}));
        loop {
            let mut revision = 0;
            let mut held = false;
            if let Some(control) = &journal.control {
                let current = control.snapshot().map_err(failure)?;
                revision = current.revision;
                held = current.held;
                plan = ChatWorkflow::parse(&current.workflow).map_err(failure)?;
                if checkpoint.get("failure").is_some() {
                    control.stop_admission().map_err(failure)?;
                }
            }
            if cancellation.is_cancelled() {
                if !(journal.cancel_requested)() {
                    return Err(Failure::new(
                        "suspended",
                        "Workflow suspended for service shutdown",
                    ));
                }
                for step in &plan.steps {
                    if checkpoint["steps"][&step.id].is_object() {
                        self.rpc("cancel", json!({"job_id":journal.job_id,"step_id":step.id}))
                            .await
                            .map_err(|error| Failure::new("effect_uncertain", error.message))?;
                    }
                }
                return Err(Failure::new(
                    "cancelled",
                    "Workflow cancelled; its active chats were interrupted",
                ));
            }
            if checkpoint.get("failure").is_none() {
                // Starting a chat returns after input acceptance. All ready siblings
                // are dispatched before waiting, so their turns execute concurrently.
                for step in &plan.steps {
                    if checkpoint.get("failure").is_some() {
                        break;
                    }
                    let state = checkpoint["steps"][&step.id]["state"]
                        .as_str()
                        .unwrap_or("pending");
                    if held && state == "pending" {
                        continue;
                    }
                    if !matches!(state, "pending" | "starting")
                        || !step.depends_on.iter().all(|id| {
                            checkpoint["steps"][id]["state"] == "completed"
                                && checkpoint["steps"][id]["acknowledged"] == true
                        })
                    {
                        continue;
                    }
                    if cancellation.is_cancelled() {
                        break;
                    }
                    let mut inputs: BTreeMap<_, _> = step
                        .depends_on
                        .iter()
                        .map(|id| (id, checkpoint["steps"][id]["result"].clone()))
                        .collect();
                    for name in &step.input_names {
                        inputs.insert(name, supplied_inputs[name].clone());
                    }
                    let mut request = json!({"job_id":journal.job_id,"workflow":plan,"step":step,"inputs":inputs});
                    if let Some(context) = submission.metadata.get("agent_context") {
                        request["agent_context"] = context.clone();
                    }
                    if let Some(control) = &journal.control {
                        if !control
                            .claim_request(revision, &step.id, &request)
                            .map_err(failure)?
                        {
                            break;
                        }
                        request = control.request(&step.id, &request).map_err(failure)?;
                    }
                    checkpoint["steps"][&step.id] = json!({"state":"starting"});
                    (journal.persist)(&checkpoint).map_err(failure)?;
                    match self.rpc("start", request).await {
                        Ok(value) => {
                            checkpoint["steps"][&step.id] = value;
                        }
                        Err(error) if transient(&error) => {
                            continue;
                        }
                        Err(error) => {
                            checkpoint["steps"][&step.id] = json!({"state":if error.code == "effect_uncertain" {"uncertain"} else {"failed"},"error":error.message});
                            (journal.persist)(&checkpoint).map_err(failure)?;
                            if error.code == "effect_uncertain" {
                                return Err(failure(error));
                            }
                            checkpoint["failure"] =
                                json!({"code":error.code,"message":error.message});
                        }
                    }
                    (journal.persist)(&checkpoint).map_err(failure)?;
                    observer(step_event(step, &checkpoint["steps"][&step.id]));
                    if checkpoint["steps"][&step.id]["state"] == "uncertain" {
                        return Err(Failure::new(
                            "effect_uncertain",
                            "The chat launch outcome needs reconciliation",
                        ));
                    }
                    if checkpoint["steps"][&step.id]["state"] == "failed" {
                        checkpoint["failure"] = json!({"code":"task_failed","message":checkpoint["steps"][&step.id]["error"]});
                        (journal.persist)(&checkpoint).map_err(failure)?;
                    }
                }
                for step in &plan.steps {
                    if !matches!(
                        checkpoint["steps"][&step.id]["state"].as_str(),
                        Some("running" | "waiting" | "offline" | "uncertain")
                    ) {
                        continue;
                    }
                    match self
                        .rpc(
                            "inspect",
                            json!({"job_id":journal.job_id,"step_id":step.id}),
                        )
                        .await
                    {
                        Ok(value) => {
                            if value["state"] == "uncertain" {
                                return Err(Failure::new(
                                    "effect_uncertain",
                                    value["error"]
                                        .as_str()
                                        .unwrap_or("Inspect the chat's unconfirmed outcome"),
                                ));
                            }
                            if checkpoint["steps"][&step.id] != value {
                                checkpoint["steps"][&step.id] = value;
                                (journal.persist)(&checkpoint).map_err(failure)?;
                                observer(step_event(step, &checkpoint["steps"][&step.id]));
                            }
                            if checkpoint["steps"][&step.id]["state"] == "failed" {
                                checkpoint["failure"] = json!({"code":"task_failed","message":checkpoint["steps"][&step.id]["error"]});
                                (journal.persist)(&checkpoint).map_err(failure)?;
                            }
                        }
                        Err(error) if transient(&error) => (),
                        Err(error) => return Err(failure(error)),
                    }
                }
            }
            // Retry acknowledgments after restart, including the window between
            // saving a completed result and acknowledging its Carrier message.
            let mut acknowledgments_pending = false;
            for step in &plan.steps {
                if matches!(
                    checkpoint["steps"][&step.id]["state"].as_str(),
                    Some("completed" | "failed")
                ) && checkpoint["steps"][&step.id]["acknowledged"] != true
                {
                    if checkpoint["steps"][&step.id]["result"].is_null() {
                        checkpoint["steps"][&step.id]["acknowledged"] = json!(true);
                        (journal.persist)(&checkpoint).map_err(failure)?;
                        continue;
                    }
                    match self
                        .rpc(
                            "ack_result",
                            json!({"job_id":journal.job_id,"step_id":step.id}),
                        )
                        .await
                    {
                        Ok(_) => {
                            checkpoint["steps"][&step.id]["acknowledged"] = json!(true);
                            (journal.persist)(&checkpoint).map_err(failure)?;
                        }
                        Err(error) if transient(&error) => {
                            acknowledgments_pending = true;
                        }
                        Err(error) => return Err(failure(error)),
                    }
                }
            }
            let finished = plan.steps.iter().all(|step| {
                checkpoint["steps"][&step.id]["state"] == "completed"
                    && checkpoint["steps"][&step.id]["acknowledged"] == true
            });
            if let Some(control) = &journal.control {
                for step in &plan.steps {
                    if checkpoint["steps"][&step.id]["state"] == "completed"
                        && checkpoint["steps"][&step.id]["acknowledged"] == true
                    {
                        control.completed(&step.id).map_err(failure)?;
                    }
                }
            }
            if finished || checkpoint.get("failure").is_some() {
                let failed = checkpoint.get("failure").is_some();
                if let Some(control) = &journal.control {
                    if failed {
                        control.stop_admission().map_err(failure)?;
                    } else if !control.finalize(revision).map_err(failure)? {
                        tokio::select! {_=cancellation.cancelled()=>(),_=tokio::time::sleep(self.poll_interval)=>()};
                        continue;
                    }
                }
                if failed {
                    let mut cleanup_pending = false;
                    for step in &plan.steps {
                        if matches!(
                            checkpoint["steps"][&step.id]["state"].as_str(),
                            Some("running" | "waiting" | "offline" | "starting")
                        ) {
                            match self
                                .rpc("cancel", json!({"job_id":journal.job_id,"step_id":step.id}))
                                .await
                            {
                                Ok(_) => {
                                    checkpoint["steps"][&step.id]["state"] = json!("cancelled");
                                    (journal.persist)(&checkpoint).map_err(failure)?;
                                }
                                Err(error) if transient(&error) => {
                                    cleanup_pending = true;
                                }
                                Err(error) => return Err(failure(error)),
                            }
                        }
                    }
                    if cleanup_pending {
                        tokio::select! { _ = cancellation.cancelled() => (), _ = tokio::time::sleep(self.poll_interval) => () };
                        continue;
                    }
                }
                if acknowledgments_pending {
                    tokio::select! { _ = cancellation.cancelled() => (), _ = tokio::time::sleep(self.poll_interval) => () };
                    continue;
                }
                if checkpoint.get("delivery").is_none() {
                    if cancellation.is_cancelled() {
                        continue;
                    }
                    observer(json!({"event":"chat_delivery","status":"delivering"}));
                    let body = if failed {
                        format!(
                            "Workflow {} could not finish.\n\n{}\n\nInspect the linked chats before retrying. Dependent tasks require successful reports from every prerequisite.",
                            plan.name,
                            checkpoint["failure"]["message"]
                                .as_str()
                                .unwrap_or("A workflow step failed")
                        )
                    } else {
                        checkpoint["steps"][&plan.delivery_step]["result"]["report"]
                            .as_str()
                            .unwrap_or("")
                            .to_owned()
                    };
                    match self.rpc("publish", json!({"job_id":journal.job_id,"workflow":plan,"failed":failed,"body":body,"steps":checkpoint["steps"]})).await {
                        Ok(value) => { checkpoint["delivery"] = value; (journal.persist)(&checkpoint).map_err(failure)?; }
                        Err(error) if transient(&error) => (),
                        Err(error) => return Err(failure(error)),
                    }
                }
                if checkpoint.get("delivery").is_some() {
                    if failed {
                        return Err(Failure::new(
                            checkpoint["failure"]["code"]
                                .as_str()
                                .unwrap_or("task_failed"),
                            checkpoint["failure"]["message"]
                                .as_str()
                                .unwrap_or("Workflow step failed"),
                        ));
                    }
                    observer(json!({"event":"completed"}));
                    if plan.version == 2 {
                        checkpoint["result"] =
                            checkpoint["steps"][&plan.delivery_step]["result"].clone();
                    }
                    return Ok(checkpoint);
                }
            }
            tokio::select! { _ = cancellation.cancelled() => (), _ = tokio::time::sleep(self.poll_interval) => () }
        }
    }
}

fn transient(error: &Error) -> bool {
    matches!(
        error.code.as_str(),
        "suite_unavailable" | "carrier_unavailable" | "io"
    )
}
fn failure(error: Error) -> Failure {
    Failure::new(&error.code, error.message)
}
fn step_event(step: &ChatStep, progress: &Value) -> Value {
    json!({"event":"chat_step","invocation":step.id,"title":step.title,"status":progress["state"],"chat_id":progress["chat_id"],"error":progress["error"],
        "sdk_approval_policy":progress["sdkApprovalPolicy"],"permission_mode":progress["permissionMode"],"permission_source":progress["permissionSource"],"profile_selection":progress["profileSelection"],"profile_decision":progress["profileDecision"]})
}

#[async_trait]
impl Engine for WorkflowEngine {
    fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
    fn capabilities(&self) -> Value {
        let mut capabilities = self.ir.capabilities();
        capabilities["native_chat_workflows"] = json!([1, 2]);
        capabilities["sdk_chat_workflows"] = json!([1]);
        capabilities["managed_chat_backends"] = json!([
            "native-codex",
            "codex-acp",
            "claude-sdk",
            "claude-acp",
            "opencode-native",
            "opencode-acp",
            "antigravity-sdk",
            "copilot-acp",
            "copilot-sdk"
        ]);
        capabilities["chat_permission_modes"] = json!(crate::permissions::MODES);
        capabilities["chat_profile_selection"] = json!([1]);
        capabilities["chat_spawn_policy"] = json!([1]);
        capabilities["resource_capture_policies"] = json!(["stage", "workflow"]);
        capabilities
    }
    fn submission_fingerprint(&self, submission: &Submission) -> &str {
        if submission.workflow["format"] == "aixand.chat-workflow" {
            if submission.workflow["version"] == 2 {
                &self.mutable_fingerprint
            } else {
                &self.fingerprint
            }
        } else {
            self.ir.submission_fingerprint(submission)
        }
    }
    fn resumable(&self, submission: &Submission) -> bool {
        submission.workflow["format"] == "aixand.chat-workflow" || self.ir.resumable(submission)
    }
    async fn preflight(&self, submission: &Submission) -> Result<()> {
        if submission.workflow["format"] != "aixand.chat-workflow" {
            return self.ir.preflight(submission).await;
        }
        let plan = ChatWorkflow::parse(&submission.workflow)?;
        plan.resolved_inputs(&submission.inputs)?;
        self.rpc("validate", json!({"workflow":plan})).await?;
        Ok(())
    }
    async fn preflight_template(&self, submission: &Submission) -> Result<()> {
        if submission.workflow["format"] != "aixand.chat-workflow" {
            return self.ir.preflight_template(submission).await;
        }
        let plan = ChatWorkflow::parse(&submission.workflow)?;
        self.rpc("validate", json!({"workflow":plan})).await?;
        Ok(())
    }
    async fn execute(
        &self,
        submission: Submission,
        observer: Observer,
        cancellation: CancellationToken,
    ) -> std::result::Result<Value, Failure> {
        if submission.workflow["format"] == "aixand.chat-workflow" {
            return Err(Failure::new(
                "checkpoint_required",
                "Native workflows require a Runner job journal",
            ));
        }
        self.ir.execute(submission, observer, cancellation).await
    }
    async fn execute_journaled(
        &self,
        submission: Submission,
        observer: Observer,
        cancellation: CancellationToken,
        journal: ExecutionJournal,
    ) -> std::result::Result<Value, Failure> {
        if submission.workflow["format"] == "aixand.chat-workflow" {
            self.run(submission, observer, cancellation, journal).await
        } else {
            self.ir
                .execute_journaled(submission, observer, cancellation, journal)
                .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::IrEngine;

    fn plan() -> Value {
        json!({"format":"aixand.chat-workflow","version":1,"name":"Audit", "project_id":uuid::Uuid::new_v4().to_string(),
          "origin_chat_id":uuid::Uuid::new_v4().to_string(),"profile":"work","steps":[
            {"id":"architecture","title":"Architecture","instruction":"Audit architecture"},
            {"id":"security","title":"Security","instruction":"Audit security"},
            {"id":"tasks","title":"Tasks","instruction":"Merge reports","depends_on":["architecture","security"]}],"delivery_step":"tasks"})
    }

    #[test]
    fn sdk_workflows_retain_provider_and_tool_policies_and_reject_sandbox_mixing() {
        for (provider, backend) in [
            ("claude", "claude-sdk"),
            ("antigravity", "antigravity-sdk"),
            ("codex", "codex-acp"),
            ("claude", "claude-acp"),
            ("opencode", "opencode-native"),
            ("opencode", "opencode-acp"),
            ("copilot", "copilot-acp"),
            ("copilot", "copilot-sdk"),
        ] {
            let mut value = plan();
            value["provider"] = json!(provider);
            value["backend"] = json!(backend);
            value["sdk_approval_policy"] = json!("ask");
            value["steps"][0]["sdk_approval_policy"] = json!("deny");
            let saved = serde_json::to_value(ChatWorkflow::parse(&value).unwrap()).unwrap();
            assert_eq!(saved["backend"], value["backend"]);
            assert_eq!(saved["steps"][0]["sdk_approval_policy"], json!("deny"));
            value["permission_mode"] = json!("read-only");
            assert!(ChatWorkflow::parse(&value).is_err());
            value.as_object_mut().unwrap().remove("permission_mode");
            value["steps"][1]["permission_mode"] = json!("workspace-write");
            assert!(ChatWorkflow::parse(&value).is_err());
        }
        assert!(
            validate_sdk_execution(Some("claude"), Some("antigravity-sdk"), Some("ask")).is_err()
        );
        assert!(validate_sdk_execution(Some("claude"), Some("claude-sdk"), Some("allow")).is_err());
        assert!(validate_sdk_execution(None, Some("claude-sdk"), None).is_err());
        let mut native = plan();
        native["provider"] = json!("codex");
        native["backend"] = json!("native-codex");
        native["permission_mode"] = json!("read-only");
        assert!(ChatWorkflow::parse(&native).is_ok());
        native["sdk_approval_policy"] = json!("deny");
        assert!(ChatWorkflow::parse(&native).is_err());
    }

    #[test]
    fn workflow_capture_requires_prepared_resources_and_preserves_legacy_shape() {
        let mut value = plan();
        let legacy = serde_json::to_value(ChatWorkflow::parse(&value).unwrap()).unwrap();
        assert!(legacy.get("resource_capture").is_none());
        value["resource_capture"] = json!("workflow");
        assert!(ChatWorkflow::parse(&value).is_err());
        value["profile_requirements"] = json!({"schema":"agent-manager/resource-request-1", "inherit_profile":false,
            "instructions":{"mode":"off"},"skills":{"add":[]},"mcp":{"add":[]}});
        assert!(ChatWorkflow::parse(&value).is_ok());
        value["profile_requirements"]["mcp"]["add"] = json!([{"target":"mutable-name"}]);
        assert!(ChatWorkflow::parse(&value).is_err());
        value["resource_capture"] = json!("stage");
        assert!(ChatWorkflow::parse(&value).is_ok());
        value["resource_capture"] = json!("unknown");
        assert!(ChatWorkflow::parse(&value).is_err());
    }

    #[test]
    fn profile_policies_round_trip_and_manual_never_becomes_a_runtime_mode() {
        let mut value = plan();
        value["profile_selection"] = json!({"mode":"auto","eligibleProfiles":["work","backup"]});
        value["steps"][0]["profile_selection"] = json!({"mode":"specific","profile":"backup"});
        let parsed = ChatWorkflow::parse(&value).unwrap();
        let saved = serde_json::to_value(parsed).unwrap();
        assert_eq!(saved["profile_selection"], value["profile_selection"]);
        assert_eq!(
            saved["steps"][0]["profile_selection"],
            value["steps"][0]["profile_selection"]
        );
        for invalid in [
            json!({"mode":"specific"}),
            json!({"mode":"auto","profile":"work"}),
            json!({"mode":"auto","eligibleProfiles":[]}),
            json!({"mode":"auto","eligibleProfiles":["work","work"]}),
        ] {
            value["profile_selection"] = invalid;
            assert!(ChatWorkflow::parse(&value).is_err());
        }
        let mut manual = plan();
        manual["require_explicit_access"] = json!(true);
        assert!(ChatWorkflow::parse(&manual).is_err());
        manual["permission_mode"] = json!("full-access");
        assert!(ChatWorkflow::parse(&manual).is_ok());
        manual["permission_mode"] = json!("manual");
        assert!(ChatWorkflow::parse(&manual).is_err());
        let legacy = serde_json::to_value(ChatWorkflow::parse(&plan()).unwrap()).unwrap();
        for field in [
            "profile_selection",
            "profile_requirements",
            "permission_source",
            "require_explicit_access",
        ] {
            assert!(legacy.get(field).is_none());
            assert!(legacy["steps"][0].get(field).is_none());
        }
    }

    #[test]
    fn dag_validation_accepts_siblings_and_rejects_cycles_missing_or_duplicate_dependencies() {
        assert!(ChatWorkflow::parse(&plan()).is_ok());
        for dependencies in [
            json!(["tasks"]),
            json!(["missing"]),
            json!(["security", "security"]),
        ] {
            let mut invalid = plan();
            invalid["steps"][0]["depends_on"] = dependencies;
            assert!(ChatWorkflow::parse(&invalid).is_err());
        }
        let mut invalid = plan();
        invalid["steps"][0]["id"] = json!("security");
        assert!(ChatWorkflow::parse(&invalid).is_err());
        invalid = plan();
        invalid["steps"][0]["instruction"] = json!("");
        assert!(ChatWorkflow::parse(&invalid).is_err());
    }

    #[test]
    fn permission_presets_round_trip_and_unknown_modes_are_rejected() {
        for mode in crate::permissions::MODES {
            let mut value = plan();
            value["permission_mode"] = json!(mode);
            value["steps"][0]["permission_mode"] = json!(PermissionMode::ReadOnly);
            let parsed = ChatWorkflow::parse(&value).unwrap();
            assert_eq!(parsed.permission_mode, Some(mode));
            assert_eq!(
                parsed.steps[0].permission_mode,
                Some(PermissionMode::ReadOnly)
            );
            let saved = serde_json::to_value(parsed).unwrap();
            assert_eq!(saved["permission_mode"], json!(mode));
            assert_eq!(saved["steps"][0]["permission_mode"], json!("read-only"));
        }
        let mut invalid = plan();
        invalid["permission_mode"] = json!("yolo");
        assert!(ChatWorkflow::parse(&invalid).is_err());
        invalid = plan();
        invalid["steps"][0]["permission_mode"] = json!("danger-full-access");
        assert!(ChatWorkflow::parse(&invalid).is_err());
        // Omitted fields must stay omitted: Suite compares saved start requests
        // byte-for-byte after canonicalization when reconciling older jobs.
        let legacy = serde_json::to_value(ChatWorkflow::parse(&plan()).unwrap()).unwrap();
        assert!(legacy.get("permission_mode").is_none());
        assert!(legacy["steps"][0].get("permission_mode").is_none());
    }

    #[test]
    fn installing_native_execution_preserves_legacy_ir_fingerprints() {
        let ir = Arc::new(IrEngine::verifier().unwrap());
        let native = WorkflowEngine::new(ir.clone(), "/tmp/suite.sock".into()).unwrap();
        assert!(ir.capabilities().get("native_chat_workflows").is_none());
        assert_eq!(
            native.capabilities()["native_chat_workflows"],
            json!([1, 2])
        );
        assert_eq!(
            native.capabilities()["chat_permission_modes"],
            json!(crate::permissions::MODES)
        );
        let mut submission = Submission {
            key: "test".into(),
            workflow: json!({"format":"aixand.workflow"}),
            inputs: json!({}),
            metadata: json!({}),
        };
        assert_eq!(native.submission_fingerprint(&submission), ir.fingerprint());
        submission.workflow = plan();
        assert_eq!(
            native.submission_fingerprint(&submission),
            native.fingerprint()
        );
        assert!(native.resumable(&submission));
    }
}
