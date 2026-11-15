//! Durable plan admission and continuation records. SQLite serializes edits,
//! operation claims and finalization; the original submission remains immutable.
use crate::{
    Error, Job, JobState, Result, Submission,
    model::{MAX_REQUEST_BYTES, digest, now},
    store::{Store, event, get, save},
};
use aixand_ir_runner::{Failure, GraphControl, GraphRevision};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlanSnapshot {
    pub id: String,
    pub revision: u64,
    pub workflow: Value,
    pub authoring: Option<Value>,
    pub held: bool,
    pub phase: String,
    pub engine_digest: String,
    pub locked_groups: Vec<String>,
    pub operations: BTreeMap<String, String>,
    pub status_sequence: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Continuation {
    pub id: String,
    pub parent_id: String,
    pub key: String,
    pub state: String,
    pub child_id: Option<String>,
    pub error: Option<Value>,
}

pub(crate) fn initialize(c: &Connection, job: &Job) -> Result<()> {
    if job.submission.workflow["version"] != 2
        || !matches!(
            job.submission.workflow["format"].as_str(),
            Some("aixand.workflow-graph" | "aixand.chat-workflow")
        )
    {
        return Ok(());
    }
    let source = serde_json::to_string(&job.submission.workflow)?;
    let authoring = job
        .submission
        .metadata
        .get("suite_canvas")
        .map(serde_json::to_string)
        .transpose()?;
    c.execute(
        "INSERT INTO execution_plans VALUES (?,1,?,?,'open',0,?)",
        params![job.id, source, authoring, job.engine_digest],
    )?;
    c.execute(
        "INSERT INTO plan_revisions VALUES (?,1,'initial',?,?,?,?)",
        params![job.id, job.request_digest, source, authoring, now()],
    )?;
    Ok(())
}

pub(crate) fn snapshot(c: &Connection, job: &Job) -> Result<PlanSnapshot> {
    let row = c.query_row("SELECT revision,workflow,authoring,phase,held,engine_digest FROM execution_plans WHERE job_id=?", [&job.id], |r| {
        Ok((r.get::<_,i64>(0)? as u64,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,bool>(4)?,r.get::<_,String>(5)?))
    }).optional()?;
    let (revision, workflow, authoring, phase, held, engine_digest) = match row {
        Some((revision, w, a, phase, held, e)) => (
            revision,
            serde_json::from_str(&w)?,
            a.map(|s| serde_json::from_str(&s)).transpose()?,
            phase,
            held,
            e,
        ),
        None => (
            0,
            job.submission.workflow.clone(),
            job.submission.metadata.get("suite_canvas").cloned(),
            "legacy".into(),
            false,
            job.engine_digest.clone(),
        ),
    };
    let rows = c
        .prepare("SELECT invocation,group_id,state FROM operation_runs WHERE job_id=?")?
        .query_map([&job.id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let locked_groups = rows
        .iter()
        .map(|(_, g, _)| g.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let status_sequence = c.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM events WHERE job_id=?",
        [&job.id],
        |r| r.get(0),
    )?;
    let mut operations: BTreeMap<String, String> =
        rows.into_iter().map(|(id, _, state)| (id, state)).collect();
    if revision == 0 && workflow["format"] == crate::graph::FORMAT {
        let events = c
            .prepare("SELECT data FROM events WHERE job_id=? AND kind='ir' ORDER BY seq")?
            .query_map([&job.id], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for source in events {
            let event: Value = serde_json::from_str(&source)?;
            if let Some(id) = event["invocation"].as_str() {
                let state = match event["event"].as_str() {
                    Some("started") => "claimed",
                    Some("published") => "completed",
                    Some("failed") => "failed",
                    _ => continue,
                };
                operations.insert(id.into(), state.into());
            }
        }
    }
    Ok(PlanSnapshot {
        id: job.id.clone(),
        revision,
        workflow,
        authoring,
        phase,
        held,
        engine_digest,
        locked_groups,
        status_sequence,
        operations,
    })
}

fn definitions(workflow: &Value) -> Result<BTreeMap<String, (String, Value)>> {
    let mut result = BTreeMap::new();
    if workflow["format"] == "aixand.workflow-graph" {
        let graph = crate::graph::Graph::parse(workflow)?;
        for step in graph.workflow.body.steps() {
            let group = graph
                .groups
                .iter()
                .find(|(_, ids)| ids.iter().any(|id| id == step.id()))
                .map(|(g, _)| g.clone())
                .unwrap_or_else(|| step.id().into());
            let mut definition =
                json!({"step":step,"dependencies":graph.dependencies.get(step.id())});
            if let Some(policy) = graph.context.chat_policies.get(step.id()) {
                definition["chat_policy"] = serde_json::to_value(policy)?;
            }
            result.insert(step.id().into(), (group, definition));
        }
    } else if workflow["format"] == "aixand.chat-workflow" {
        for step in workflow["steps"]
            .as_array()
            .ok_or_else(|| Error::new("validation", "Missing chat stages"))?
        {
            let id = step["id"]
                .as_str()
                .ok_or_else(|| Error::new("validation", "Missing stage identity"))?;
            result.insert(id.into(), (id.into(), step.clone()));
        }
    } else {
        return Err(Error::new("unsupported", "This workflow cannot be amended"));
    }
    Ok(result)
}

fn error_details(code: &str, message: &str, details: Value) -> Error {
    Error {
        code: code.into(),
        message: message.into(),
        details: Some(details),
    }
}

impl Store {
    pub fn adoption_pending(&self, id: &str) -> Result<bool> {
        Ok(self.connection()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM pending_adoptions WHERE job_id=?)",
            [id],
            |r| r.get(0),
        )?)
    }

    pub fn request_adoption(
        &self,
        id: &str,
        request: &Value,
        resumable: bool,
    ) -> Result<PlanSnapshot> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let job = get(&tx, id)?;
        let plan = snapshot(&tx, &job)?;
        if plan.revision > 0 {
            return Ok(plan);
        }
        if job.cancel_requested || !matches!(job.state, JobState::Queued | JobState::Running) {
            return Err(Error::new(
                "state",
                "Only queued or running legacy jobs can enable edits",
            ));
        }
        if job.attempt_id.is_some() && !resumable {
            return Err(Error::new(
                "opaque_resources",
                "A started legacy SDK run must keep its existing scope; use a linked follow-up",
            ));
        }
        let previous: Option<String> = tx
            .query_row(
                "SELECT request FROM pending_adoptions WHERE job_id=?",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            if serde_json::from_str::<Value>(&previous)? != *request {
                return Err(Error::new("conflict", "Another adoption is pending"));
            }
        } else {
            tx.execute(
                "INSERT INTO pending_adoptions VALUES (?,?)",
                params![id, serde_json::to_string(request)?],
            )?;
        }
        tx.commit()?;
        Ok(plan)
    }

    pub fn adopt_queued(&self) -> Result<()> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let rows=tx.prepare("SELECT a.job_id,a.request FROM pending_adoptions a JOIN jobs j ON j.id=a.job_id WHERE j.state!='running'")?
            .query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        for (id, source) in rows {
            let job = get(&tx, &id)?;
            if job.state != JobState::Queued || job.cancel_requested {
                tx.execute("DELETE FROM pending_adoptions WHERE job_id=?", [&id])?;
                continue;
            }
            let request: Value = serde_json::from_str(&source)?;
            let workflow = &request["workflow"];
            let defs = definitions(workflow)?;
            let checkpoint_source: Option<String> = tx
                .query_row("SELECT data FROM checkpoints WHERE job_id=?", [&id], |r| {
                    r.get(0)
                })
                .optional()?;
            let checkpoint: Value = checkpoint_source
                .map(|s| serde_json::from_str(&s))
                .transpose()?
                .unwrap_or(json!({}));
            let mut claimed = BTreeSet::new();
            let mut requests = BTreeMap::new();
            if workflow["format"] == "aixand.chat-workflow" {
                let old = crate::native::ChatWorkflow::parse(&job.submission.workflow)?;
                for step in &old.steps {
                    if checkpoint["steps"].get(&step.id).is_some() {
                        claimed.insert(step.id.clone());
                        let inputs: BTreeMap<_, _> = step
                            .depends_on
                            .iter()
                            .map(|parent| (parent, checkpoint["steps"][parent]["result"].clone()))
                            .collect();
                        let mut sealed =
                            json!({"job_id":id,"workflow":old,"step":step,"inputs":inputs});
                        if let Some(context) = job.submission.metadata.get("agent_context") {
                            sealed["agent_context"] = context.clone();
                        }
                        requests.insert(step.id.clone(), sealed);
                    }
                }
            } else {
                let events = tx
                    .prepare("SELECT data FROM events WHERE job_id=? AND kind='ir'")?
                    .query_map([&id], |r| r.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                for event in events {
                    let event: Value = serde_json::from_str(&event)?;
                    if event["event"] == "started"
                        && let Some(id) = event["invocation"].as_str()
                    {
                        claimed.insert(id.into());
                    }
                }
            }
            let delivering = checkpoint.get("delivery").is_some()
                || claimed.iter().any(|id| {
                    defs.get(id).is_some_and(|(_, definition)| {
                        definition["step"]["operation"]["id"] == "carrier.human.deliver"
                    })
                });
            if delivering {
                tx.execute("DELETE FROM pending_adoptions WHERE job_id=?", [&id])?;
                continue;
            }
            let authoring = request
                .get("authoring")
                .filter(|v| !v.is_null())
                .map(serde_json::to_string)
                .transpose()?;
            tx.execute(
                "INSERT INTO execution_plans VALUES (?,1,?,?,'open',1,?)",
                params![
                    id,
                    serde_json::to_string(workflow)?,
                    authoring,
                    request["engine_digest"].as_str()
                ],
            )?;
            tx.execute(
                "INSERT INTO plan_revisions VALUES (?,1,?,?,?,?,?)",
                params![
                    id,
                    format!("enable:{}", request["key"].as_str().unwrap_or("")),
                    digest(&request)?,
                    serde_json::to_string(workflow)?,
                    authoring,
                    now()
                ],
            )?;
            for invocation in claimed {
                let (group, definition) = defs.get(&invocation).ok_or_else(|| {
                    Error::new(
                        "adoption",
                        "A recorded operation is absent from the original plan",
                    )
                })?;
                let complete = checkpoint["published"].get(&invocation).is_some()
                    || checkpoint["steps"][&invocation]["state"] == "completed"
                        && checkpoint["steps"][&invocation]["acknowledged"] == true;
                tx.execute(
                    "INSERT INTO operation_runs VALUES (?,?,?,1,?,?,?)",
                    params![
                        id,
                        invocation,
                        group,
                        serde_json::to_string(definition)?,
                        if complete { "completed" } else { "claimed" },
                        requests
                            .get(&invocation)
                            .map(serde_json::to_string)
                            .transpose()?
                    ],
                )?;
            }
            event(
                &tx,
                &id,
                "edits_enabled",
                &json!({"revision":1,"held":true}),
            )?;
            tx.execute("DELETE FROM pending_adoptions WHERE job_id=?", [&id])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn workflow_runs(&self, offset: usize, limit: usize) -> Result<Value> {
        if limit == 0 || limit > 500 || offset > 1_000_000 {
            return Err(Error::new("request", "Invalid workflow run page"));
        }
        let c = self.connection()?;
        let rows=c.prepare("SELECT payload FROM jobs WHERE json_extract(payload,'$.submission.metadata.origin') IN ('suite.chat','aixand.workflow-builder') OR json_extract(payload,'$.submission.metadata.agent_context.labels.app')='aixand-suite' ORDER BY seq DESC LIMIT ? OFFSET ?")?
            .query_map(params![(limit+1) as i64,offset as i64],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let has_more = rows.len() > limit;
        let mut views = Vec::new();
        for row in rows.into_iter().take(limit) {
            let job: Job = serde_json::from_str(&row)?;
            let plan = snapshot(&c, &job)?;
            let definition = if plan.workflow["format"] == "aixand.workflow-graph" {
                &plan.workflow["workflow"]
            } else {
                &plan.workflow
            };
            let origin = plan.workflow["context"]["originChatId"]
                .as_str()
                .or_else(|| plan.workflow["origin_chat_id"].as_str())
                .or_else(|| job.submission.metadata["originChatId"].as_str());
            let project = plan.workflow["context"]["projectId"]
                .as_str()
                .or_else(|| plan.workflow["project_id"].as_str());
            let delivery = job
                .result
                .as_ref()
                .and_then(|r| r.get("delivery"))
                .cloned()
                .or_else(|| {
                    job.result
                        .as_ref()
                        .and_then(Value::as_object)
                        .and_then(|r| {
                            r.values()
                                .find(|v| v.get("message_id").is_some() && v.get("inbox").is_some())
                        })
                        .cloned()
                });
            views.push(json!({"id":job.id,"key":job.submission.key,"state":job.state,"title":definition["name"],
                "createdAt":job.created_at,"updatedAt":job.updated_at,"originChatId":origin,"projectId":project,
                "parentJobId":job.submission.metadata["parent_job_id"],"workflowId":job.submission.metadata["workflowId"],
                "namespace":job.submission.metadata["suite_namespace"],"error":job.error.as_ref().and_then(|e|e.get("message")),
                "delivery":delivery,"plan":plan}));
        }
        Ok(
            json!({"runs":views,"has_more":has_more,"next_offset":if has_more{Some(offset+limit)}else{None}}),
        )
    }

    pub fn plan(&self, id: &str) -> Result<PlanSnapshot> {
        let c = self.connection()?;
        snapshot(&c, &get(&c, id)?)
    }

    pub fn effective_submission(&self, id: &str) -> Result<Submission> {
        let c = self.connection()?;
        let job = get(&c, id)?;
        let plan = snapshot(&c, &job)?;
        let mut submission = job.submission;
        submission.workflow = plan.workflow;
        Ok(submission)
    }

    pub fn amendment_replay(
        &self,
        id: &str,
        key: &str,
        request_digest: &str,
    ) -> Result<Option<Value>> {
        let c = self.connection()?;
        let row=c.query_row("SELECT revision,request_digest FROM plan_revisions WHERE job_id=? AND amendment_key=?",params![id,key],|r| Ok((r.get::<_,i64>(0)? as u64,r.get::<_,String>(1)?))).optional()?;
        match row {
            Some((revision, previous)) if previous == request_digest => Ok(Some(
                json!({"revision":revision,"replayed":true,"plan":snapshot(&c,&get(&c,id)?)?}),
            )),
            Some(_) => Err(Error::new(
                "conflict",
                "Amendment key already identifies different content",
            )),
            None => Ok(None),
        }
    }

    pub fn amend(
        &self,
        id: &str,
        key: &str,
        expected: u64,
        workflow: &Value,
        authoring: Option<&Value>,
        request_digest: &str,
    ) -> Result<Value> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let job = get(&tx, id)?;
        let previous = snapshot(&tx, &job)?;
        let replay=tx.query_row("SELECT revision,request_digest FROM plan_revisions WHERE job_id=? AND amendment_key=?",params![id,key],|r| Ok((r.get::<_,i64>(0)? as u64,r.get::<_,String>(1)?))).optional()?;
        if let Some((revision, d)) = replay {
            if d != request_digest {
                return Err(Error::new(
                    "conflict",
                    "Amendment key already identifies different content",
                ));
            }
            return Ok(json!({"revision":revision,"replayed":true,"plan":previous}));
        }
        if previous.revision == 0 {
            return Err(Error::new(
                "legacy_plan",
                "This run uses a fixed legacy plan; attach a follow-up workflow",
            ));
        }
        if !matches!(job.state, JobState::Queued | JobState::Running)
            || job.cancel_requested
            || previous.phase != "open"
        {
            return Err(Error::new(
                "run_finalizing",
                "This run is sealed or has settled; attach a follow-up workflow",
            ));
        }
        if previous.revision != expected {
            return Err(error_details(
                "revision_conflict",
                "The run plan changed; reload before applying",
                json!({"expected_revision":expected,"revision":previous.revision}),
            ));
        }
        if workflow["format"] != previous.workflow["format"]
            || workflow["version"] != previous.workflow["version"]
        {
            return Err(Error::new(
                "validation",
                "An amendment cannot change execution formats",
            ));
        }
        let mut before = previous.workflow.clone();
        let mut after = workflow.clone();
        if before["format"] == "aixand.workflow-graph" {
            if let Some(context) = before["context"].as_object_mut() {
                context.remove("chatPolicies");
            }
            if let Some(context) = after["context"].as_object_mut() {
                context.remove("chatPolicies");
            }
            for field in ["workflow", "dependencies", "groups"] {
                before.as_object_mut().unwrap().remove(field);
                after.as_object_mut().unwrap().remove(field);
            }
            if previous.workflow["workflow"]["inputs"] != workflow["workflow"]["inputs"]
                || previous.workflow["workflow"]["name"] != workflow["workflow"]["name"]
            {
                return Err(Error::new(
                    "validation",
                    "Run inputs and identity stay fixed",
                ));
            }
        } else {
            for field in ["steps", "delivery_step"] {
                before.as_object_mut().unwrap().remove(field);
                after.as_object_mut().unwrap().remove(field);
            }
        }
        if before != after {
            return Err(Error::new(
                "validation",
                "Run context and identity stay fixed",
            ));
        }
        let old = definitions(&previous.workflow)?;
        let new = definitions(workflow)?;
        for group in &previous.locked_groups {
            let a: BTreeMap<_, _> = old.iter().filter(|(_, (g, _))| g == group).collect();
            let b: BTreeMap<_, _> = new.iter().filter(|(_, (g, _))| g == group).collect();
            if a != b {
                return Err(error_details(
                    "step_locked",
                    "A started step cannot change its instructions, inputs or dependencies",
                    json!({"group":group,"operations":previous.operations}),
                ));
            }
        }
        for id in new.keys().filter(|id| !old.contains_key(*id)) {
            if tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM retired_operations WHERE job_id=? AND invocation=?)",
                params![id_to_job(&job), id],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(Error::new(
                    "identity_retired",
                    "A removed step needs a new identity",
                ));
            }
        }
        // A continuation's named parent export cannot disappear beneath it.
        let maps=tx.prepare("SELECT input_map FROM continuations WHERE parent_id=? AND state IN ('waiting','ready')")?
            .query_map([id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        for map in maps {
            for path in serde_json::from_str::<BTreeMap<String, String>>(&map)?.values() {
                validate_export(workflow, path)?;
            }
        }
        for removed in old.keys().filter(|id| !new.contains_key(*id)) {
            tx.execute(
                "INSERT OR IGNORE INTO retired_operations VALUES (?,?)",
                params![id, removed],
            )?;
        }
        let revision = previous.revision + 1;
        let source = serde_json::to_string(workflow)?;
        let authoring = authoring.map(serde_json::to_string).transpose()?;
        tx.execute(
            "INSERT INTO plan_revisions VALUES (?,?,?,?,?,?,?)",
            params![
                id,
                revision as i64,
                key,
                request_digest,
                source,
                authoring,
                now()
            ],
        )?;
        tx.execute(
            "UPDATE execution_plans SET revision=?,workflow=?,authoring=? WHERE job_id=?",
            params![revision as i64, source, authoring, id],
        )?;
        event(
            &tx,
            id,
            "plan_amended",
            &json!({"revision":revision,"key":key}),
        )?;
        let plan = snapshot(&tx, &job)?;
        tx.commit()?;
        Ok(json!({"revision":revision,"replayed":false,"plan":plan}))
    }

    pub fn hold(&self, id: &str, held: bool) -> Result<PlanSnapshot> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let job = get(&tx, id)?;
        let plan = snapshot(&tx, &job)?;
        if plan.revision == 0
            || plan.phase != "open"
            || !matches!(job.state, JobState::Queued | JobState::Running)
            || job.cancel_requested
        {
            return Err(Error::new(
                "state",
                "Only an open mutable run can hold upcoming steps",
            ));
        }
        tx.execute(
            "UPDATE execution_plans SET held=? WHERE job_id=?",
            params![held, id],
        )?;
        if held != plan.held {
            event(&tx, id, "dispatch_held", &json!({"held":held}))?;
        }
        let plan = snapshot(&tx, &job)?;
        tx.commit()?;
        Ok(plan)
    }

    fn claim_operation(
        &self,
        id: &str,
        revision: u64,
        invocation: &str,
        request: Option<&Value>,
    ) -> Result<bool> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let job = get(&tx, id)?;
        let plan = snapshot(&tx, &job)?;
        let existing: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM operation_runs WHERE job_id=? AND invocation=?)",
            params![id, invocation],
            |r| r.get(0),
        )?;
        if job.cancel_requested
            || job.state != JobState::Running
            || plan.revision != revision
            || (plan.held && !existing)
        {
            return Ok(false);
        }
        let defs = definitions(&plan.workflow)?;
        let (group, definition) = defs
            .get(invocation)
            .ok_or_else(|| Error::new("graph", "Unknown operation"))?;
        if plan.phase != "open" && !existing {
            return Ok(false);
        }
        let delivery = definition["step"]["operation"]["id"] == "carrier.human.deliver";
        if delivery {
            tx.execute(
                "UPDATE execution_plans SET phase='finalizing' WHERE job_id=?",
                [id],
            )?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO operation_runs VALUES (?,?,?,?,?,'claimed',?)",
            params![
                id,
                invocation,
                group,
                revision as i64,
                serde_json::to_string(definition)?,
                request.map(serde_json::to_string).transpose()?
            ],
        )?;
        if !existing {
            event(
                &tx,
                id,
                "step_claimed",
                &json!({"invocation":invocation,"group":group,"revision":revision}),
            )?;
        }
        tx.commit()?;
        Ok(true)
    }

    fn sealed_request(&self, id: &str, invocation: &str, candidate: &Value) -> Result<Value> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let saved: Option<String> = tx.query_row(
            "SELECT request FROM operation_runs WHERE job_id=? AND invocation=?",
            params![id, invocation],
            |r| r.get(0),
        )?;
        let request = match saved {
            Some(s) => serde_json::from_str(&s)?,
            None => {
                let mut candidate = candidate.clone();
                // Graph bindings may have been prepared before an amendment.
                // Use the definition committed by the atomic operation claim,
                // then freeze that exact request for every retry/restart.
                if candidate["step"].is_object() {
                    let definition: String = tx.query_row(
                        "SELECT definition FROM operation_runs WHERE job_id=? AND invocation=?",
                        params![id, invocation],
                        |row| row.get(0),
                    )?;
                    let definition: Value = serde_json::from_str(&definition)?;
                    for (source, target) in [
                        ("permissionMode", "permission_mode"),
                        ("permissionSource", "permission_source"),
                        ("profileSelection", "profile_selection"),
                        ("profileRequirements", "profile_requirements"),
                    ] {
                        candidate["step"].as_object_mut().unwrap().remove(target);
                        if let Some(value) = definition["chat_policy"].get(source) {
                            candidate["step"][target] = value.clone();
                        }
                    }
                }
                tx.execute(
                    "UPDATE operation_runs SET request=? WHERE job_id=? AND invocation=?",
                    params![serde_json::to_string(&candidate)?, id, invocation],
                )?;
                candidate
            }
        };
        tx.commit()?;
        Ok(request)
    }

    fn publish_operation(&self, id: &str, invocation: &str, outputs: Option<&Value>) -> Result<()> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        if let Some(outputs) = outputs {
            let saved: Option<String> = tx
                .query_row("SELECT data FROM checkpoints WHERE job_id=?", [id], |r| {
                    r.get(0)
                })
                .optional()?;
            let mut checkpoint: Value = saved
                .map(|s| serde_json::from_str(&s))
                .transpose()?
                .unwrap_or(json!({}));
            if checkpoint.get("published").is_none() {
                checkpoint["published"] = json!({});
            }
            checkpoint["published"][invocation] = outputs.clone();
            let source = serde_json::to_string(&checkpoint)?;
            if source.len() > crate::model::MAX_RESPONSE_BYTES / 2 {
                return Err(Error::new("checkpoint_limit", "Checkpoint exceeds 8 MiB"));
            }
            tx.execute("INSERT INTO checkpoints VALUES (?,?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data",params![id,source])?;
        }
        tx.execute(
            "UPDATE operation_runs SET state='completed' WHERE job_id=? AND invocation=?",
            params![id, invocation],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn seal_plan(&self, id: &str, revision: u64) -> Result<bool> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let plan = snapshot(&tx, &get(&tx, id)?)?;
        if plan.held || plan.revision != revision {
            return Ok(false);
        }
        tx.execute(
            "UPDATE execution_plans SET phase='finalizing' WHERE job_id=?",
            [id],
        )?;
        tx.commit()?;
        Ok(true)
    }

    fn seal_failed(&self, id: &str) -> Result<()> {
        self.connection()?.execute(
            "UPDATE execution_plans SET phase='finalizing' WHERE job_id=?",
            [id],
        )?;
        Ok(())
    }

    pub fn register_continuation(
        &self,
        parent: &str,
        key: &str,
        target: &Submission,
        input_map: &BTreeMap<String, String>,
        engine_digest: &str,
    ) -> Result<Continuation> {
        let request_digest = digest(&json!({"target":target,"input_map":input_map}))?;
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let job = get(&tx, parent)?;
        let existing=tx.query_row("SELECT id,request_digest FROM continuations WHERE parent_id=? AND registration_key=?",params![parent,key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
        if let Some((id, d)) = existing {
            if d != request_digest {
                return Err(Error::new(
                    "conflict",
                    "Continuation key already identifies different content",
                ));
            }
            return continuation(&tx, &id);
        }
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM continuations WHERE parent_id=?",
            [parent],
            |r| r.get(0),
        )?;
        if count >= 100 {
            return Err(Error::new("limit", "Use at most 100 continuations per run"));
        }
        let plan = snapshot(&tx, &job)?;
        for path in input_map.values() {
            validate_export(&plan.workflow, path)?;
        }
        let state = match job.state {
            JobState::Completed => "ready",
            JobState::Failed | JobState::Cancelled | JobState::Blocked => "skipped",
            _ => "waiting",
        };
        let id = format!("CONT-{}", uuid::Uuid::new_v4());
        tx.execute(
            "INSERT INTO continuations VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?)",
            params![
                id,
                parent,
                key,
                request_digest,
                serde_json::to_string(target)?,
                serde_json::to_string(input_map)?,
                engine_digest,
                state,
                now()
            ],
        )?;
        event(
            &tx,
            parent,
            "continuation_registered",
            &json!({"id":id,"state":state}),
        )?;
        let result = continuation(&tx, &id)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn continuation_replay(
        &self,
        parent: &str,
        key: &str,
        target: &Submission,
        input_map: &BTreeMap<String, String>,
    ) -> Result<Option<Continuation>> {
        let c = self.connection()?;
        let row=c.query_row("SELECT id,request_digest FROM continuations WHERE parent_id=? AND registration_key=?",params![parent,key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
        if let Some((id, previous)) = row {
            if previous != digest(&json!({"target":target,"input_map":input_map}))? {
                return Err(Error::new(
                    "conflict",
                    "Continuation key already identifies different content",
                ));
            }
            return Ok(Some(continuation(&c, &id)?));
        }
        Ok(None)
    }

    pub fn continuation_target(
        &self,
        id: &str,
    ) -> Result<(Continuation, Submission, BTreeMap<String, String>, String)> {
        let c = self.connection()?;
        let record = continuation(&c, id)?;
        let (target, map, engine) = c.query_row(
            "SELECT target,input_map,engine_digest FROM continuations WHERE id=?",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )?;
        Ok((
            record,
            serde_json::from_str(&target)?,
            serde_json::from_str(&map)?,
            engine,
        ))
    }

    pub fn continuations(&self, parent: &str) -> Result<Vec<Continuation>> {
        let c = self.connection()?;
        get(&c, parent)?;
        let ids = c
            .prepare("SELECT id FROM continuations WHERE parent_id=? ORDER BY created_at,id")?
            .query_map([parent], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.iter().map(|id| continuation(&c, id)).collect()
    }

    pub fn ready_continuations(&self) -> Result<Vec<String>> {
        Ok(self
            .connection()?
            .prepare(
                "SELECT id FROM continuations WHERE state='ready' ORDER BY created_at LIMIT 100",
            )?
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn block_continuation(&self, id: &str, error: &Error) -> Result<()> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let record = continuation(&tx, id)?;
        let changed = tx.execute(
            "UPDATE continuations SET state='blocked',error=? WHERE id=? AND state='ready'",
            params![serde_json::to_string(error)?, id],
        )?;
        if changed > 0 {
            event(
                &tx,
                &record.parent_id,
                "continuation_blocked",
                &json!({"id":id,"error":error}),
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn cancel_continuation(&self, id: &str) -> Result<Continuation> {
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let record = continuation(&tx, id)?;
        if record.child_id.is_some() {
            return Err(error_details(
                "child_submitted",
                "Cancel the linked child run",
                json!({"child_id":record.child_id}),
            ));
        }
        tx.execute(
            "UPDATE continuations SET state='cancelled' WHERE id=?",
            [id],
        )?;
        event(
            &tx,
            &record.parent_id,
            "continuation_cancelled",
            &json!({"id":id}),
        )?;
        let record = continuation(&tx, id)?;
        tx.commit()?;
        Ok(record)
    }

    pub fn materialize_continuation(
        &self,
        id: &str,
        submission: Submission,
        engine_digest: &str,
    ) -> Result<Option<Job>> {
        submission.validate_envelope()?;
        let mut c = self.connection()?;
        let tx = c.transaction()?;
        let record = continuation(&tx, id)?;
        if record.state != "ready" {
            return Ok(None);
        }
        let parent = get(&tx, &record.parent_id)?;
        if parent.state != JobState::Completed {
            return Err(Error::new("state", "Parent has not completed"));
        }
        let cancelled: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM cancelled_submissions WHERE submission_key=?)",
            [&submission.key],
            |r| r.get(0),
        )?;
        if cancelled {
            return Err(Error::new(
                "cancelled",
                "The continuation submission was cancelled",
            ));
        }
        let occupied: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE submission_key=?)",
            [&submission.key],
            |row| row.get(0),
        )?;
        if occupied {
            return Err(Error::new(
                "conflict",
                "The continuation submission key already identifies another job",
            ));
        }
        let time = now();
        let mut job = Job {
            sequence: 0,
            id: format!("JOB-{}", uuid::Uuid::new_v4()),
            state: JobState::Queued,
            request_digest: submission.digest()?,
            submission,
            engine_digest: engine_digest.into(),
            attempt_id: None,
            created_at: time,
            updated_at: time,
            cancel_requested: false,
            result: None,
            error: None,
        };
        tx.execute("INSERT INTO jobs (id,submission_key,request_digest,state,created_at,updated_at,cancel_requested,payload) VALUES (?,?,?,'queued',?,?,0,'{}')",params![job.id,job.submission.key,job.request_digest,time,time])?;
        job.sequence = tx.last_insert_rowid();
        save(&tx, &job)?;
        initialize(&tx, &job)?;
        tx.execute(
            "UPDATE continuations SET state='submitted',child_id=? WHERE id=?",
            params![job.id, id],
        )?;
        event(
            &tx,
            &job.id,
            "queued",
            &json!({"parent_id":parent.id,"continuation_id":id}),
        )?;
        event(
            &tx,
            &parent.id,
            "continuation_submitted",
            &json!({"id":id,"child_id":job.id}),
        )?;
        tx.commit()?;
        Ok(Some(job))
    }
}

fn id_to_job(job: &Job) -> &str {
    &job.id
}

fn validate_export(workflow: &Value, path: &str) -> Result<()> {
    if path.is_empty() {
        return Ok(());
    }
    if !path.starts_with('/') {
        return Err(Error::new(
            "input_mapping",
            "Use JSON pointers for parent-result mappings",
        ));
    }
    let first = path[1..]
        .split('/')
        .next()
        .unwrap_or("")
        .replace("~1", "/")
        .replace("~0", "~");
    let outputs = if workflow["format"] == "aixand.workflow-graph" {
        &workflow["workflow"]["outputs"]
    } else {
        &workflow["outputs"]
    };
    if workflow["format"] == "aixand.chat-workflow" {
        if !["result", "steps", "delivery"].contains(&first.as_str()) {
            return Err(Error::new(
                "input_mapping",
                "Unknown native workflow result export",
            ));
        }
    } else if outputs.get(&first).is_none() {
        return Err(Error::new("input_mapping", "Unknown parent result export"));
    }
    Ok(())
}

fn continuation(c: &Connection, id: &str) -> Result<Continuation> {
    let row = c
        .query_row(
            "SELECT parent_id,registration_key,state,child_id,error FROM continuations WHERE id=?",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| Error::new("not_found", "Continuation not found"))?;
    Ok(Continuation {
        id: id.into(),
        parent_id: row.0,
        key: row.1,
        state: row.2,
        child_id: row.3,
        error: row.4.map(|s| serde_json::from_str(&s)).transpose()?,
    })
}

pub struct PlanControl {
    store: Arc<Store>,
    id: String,
    cancellation: tokio_util::sync::CancellationToken,
}
impl PlanControl {
    pub(crate) fn new(
        store: Arc<Store>,
        id: String,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Self {
        Self {
            store,
            id,
            cancellation,
        }
    }
    pub fn snapshot(&self) -> Result<PlanSnapshot> {
        self.store.plan(&self.id)
    }
    pub fn claim_request(&self, revision: u64, id: &str, request: &Value) -> Result<bool> {
        self.store
            .claim_operation(&self.id, revision, id, Some(request))
    }
    pub fn request(&self, id: &str, candidate: &Value) -> Result<Value> {
        self.store.sealed_request(&self.id, id, candidate)
    }
    pub fn completed(&self, id: &str) -> Result<()> {
        self.store.publish_operation(&self.id, id, None)
    }
    pub fn finalize(&self, revision: u64) -> Result<bool> {
        self.store.seal_plan(&self.id, revision)
    }
    pub fn stop_admission(&self) -> Result<()> {
        self.store.seal_failed(&self.id)
    }
}
fn failure(error: Error) -> Failure {
    Failure::new(&error.code, error.message)
}
impl GraphControl for PlanControl {
    fn current(&self) -> std::result::Result<GraphRevision, Failure> {
        let plan = self.snapshot().map_err(failure)?;
        let graph = crate::graph::Graph::parse(&plan.workflow).map_err(failure)?;
        Ok(GraphRevision {
            revision: plan.revision,
            workflow: graph.workflow,
            dependencies: graph.dependencies,
            held: plan.held,
            claimed: plan.operations.into_keys().collect(),
        })
    }
    fn claim(&self, revision: u64, id: &str) -> std::result::Result<bool, Failure> {
        self.store
            .claim_operation(&self.id, revision, id, None)
            .map_err(failure)
    }
    fn publish(&self, id: &str, outputs: Option<&Value>) -> std::result::Result<(), Failure> {
        self.store
            .publish_operation(&self.id, id, outputs)
            .map_err(failure)
    }
    fn seal(&self, revision: u64) -> std::result::Result<bool, Failure> {
        self.finalize(revision).map_err(failure)
    }
    fn fail(&self) -> std::result::Result<(), Failure> {
        if self.cancellation.is_cancelled()
            && !self.store.get(&self.id).map_err(failure)?.cancel_requested
        {
            return Ok(()); // Service suspension must keep pending work admissible.
        }
        self.stop_admission().map_err(failure)
    }
}

pub fn validate_key(key: &str) -> Result<()> {
    if key.trim().is_empty() || key.len() > 256 {
        return Err(Error::new("request", "Provide a key of 1–256 bytes"));
    }
    Ok(())
}

pub fn validate_amendment(workflow: &Value, authoring: Option<&Value>) -> Result<()> {
    if serde_json::to_vec(&json!({"workflow":workflow,"authoring":authoring}))?.len()
        > MAX_REQUEST_BYTES
    {
        return Err(Error::new("request_limit", "Amendment exceeds 4 MiB"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workflow() -> Value {
        json!({"format":"aixand.workflow-graph","version":2,"context":{},"groups":{"work":["work"]},"dependencies":{"work":[]},
            "workflow":{"ir_version":"0.1","name":"Race","inputs":{},"body":{"kind":"sequence","steps":[{"kind":"operation","id":"work","operation":{"id":"workflow.value","version":"1.0.0"},"inputs":{"value":{"kind":"literal","value":"original"}}}]},"outputs":{}}})
    }
    fn running(store: &Store, key: &str) -> Job {
        store
            .submit(
                Submission {
                    key: key.into(),
                    workflow: workflow(),
                    inputs: json!({}),
                    metadata: json!({}),
                },
                "test",
            )
            .unwrap();
        store.claim().unwrap().unwrap()
    }

    #[test]
    fn claimed_chat_policy_overrides_stale_binding_and_is_sealed_for_retries() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(&directory.path().join("jobs.sqlite3")).unwrap();
        let mut graph = workflow();
        graph["workflow"]["body"]["steps"][0]["operation"]["id"] = json!("aixand.project.chat");
        graph["context"]["chatPolicies"] = json!({"work":{"permissionMode":"full-access"}});
        store
            .submit(
                Submission {
                    key: "policy".into(),
                    workflow: graph.clone(),
                    inputs: json!({}),
                    metadata: json!({}),
                },
                "test",
            )
            .unwrap();
        let job = store.claim().unwrap().unwrap();
        graph["context"]["chatPolicies"]["work"]["permissionMode"] = json!("read-only");
        store
            .amend(&job.id, "edit-policy", 1, &graph, None, "edit")
            .unwrap();
        assert!(store.claim_operation(&job.id, 2, "work", None).unwrap());
        let stale = json!({"step":{"id":"work","permission_mode":"full-access"}});
        let sealed = store.sealed_request(&job.id, "work", &stale).unwrap();
        assert_eq!(sealed["step"]["permission_mode"], "read-only");
        assert_eq!(
            store.sealed_request(&job.id, "work", &stale).unwrap(),
            sealed
        );
        graph["context"]["chatPolicies"]["work"]["permissionMode"] = json!("workspace-auto");
        assert_eq!(
            store
                .amend(&job.id, "locked-policy", 2, &graph, None, "locked")
                .unwrap_err()
                .code,
            "step_locked"
        );
    }

    #[test]
    fn service_suspension_keeps_graph_open_but_user_cancellation_closes_it() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&directory.path().join("jobs.sqlite3")).unwrap());
        let job = running(&store, "suspend");
        let token = tokio_util::sync::CancellationToken::new();
        let control = PlanControl::new(store.clone(), job.id.clone(), token.clone());
        token.cancel();
        GraphControl::fail(&control).unwrap();
        store
            .record_attempt_event(
                &job.id,
                &json!({"event":"failed","failure":{"code":"cancelled","invocation_id":"work"}}),
                true,
            )
            .unwrap();
        assert_eq!(store.plan(&job.id).unwrap().phase, "open");
        store.cancel(&job.id, false).unwrap();
        store
            .record_attempt_event(
                &job.id,
                &json!({"event":"failed","failure":{"code":"cancelled","invocation_id":"work"}}),
                true,
            )
            .unwrap();
        GraphControl::fail(&control).unwrap();
        assert_eq!(store.plan(&job.id).unwrap().phase, "finalizing");
    }
    #[test]
    fn amendment_and_claim_have_one_atomic_winner() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&directory.path().join("jobs.sqlite3")).unwrap());
        for index in 0..20 {
            let job = running(&store, &format!("claim-{index}"));
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let mut revised = workflow();
            revised["workflow"]["body"]["steps"][0]["inputs"]["value"]["value"] = json!("revised");
            let claim = {
                let store = store.clone();
                let barrier = barrier.clone();
                let id = job.id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.claim_operation(&id, 1, "work", None).unwrap()
                })
            };
            let edit = {
                let store = store.clone();
                let barrier = barrier.clone();
                let id = job.id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.amend(&id, "edit", 1, &revised, None, "digest")
                })
            };
            let claimed = claim.join().unwrap();
            let edited = edit.join().unwrap();
            if claimed {
                assert_eq!(edited.unwrap_err().code, "step_locked");
            } else {
                assert_eq!(edited.unwrap()["revision"], 2);
            }
            store
                .finish(&job.id, JobState::Completed, Some(json!({})), None)
                .unwrap();
        }
    }
    #[test]
    fn append_and_finalization_have_one_atomic_winner() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&directory.path().join("jobs.sqlite3")).unwrap());
        for index in 0..20 {
            let job = running(&store, &format!("seal-{index}"));
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let mut revised = workflow();
            let mut extra = revised["workflow"]["body"]["steps"][0].clone();
            extra["id"] = json!("next");
            revised["workflow"]["body"]["steps"]
                .as_array_mut()
                .unwrap()
                .push(extra);
            revised["groups"]["next"] = json!(["next"]);
            revised["dependencies"]["next"] = json!(["work"]);
            let seal = {
                let store = store.clone();
                let barrier = barrier.clone();
                let id = job.id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.seal_plan(&id, 1).unwrap()
                })
            };
            let edit = {
                let store = store.clone();
                let barrier = barrier.clone();
                let id = job.id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.amend(&id, "append", 1, &revised, None, "digest")
                })
            };
            let sealed = seal.join().unwrap();
            let edited = edit.join().unwrap();
            if sealed {
                assert_eq!(edited.unwrap_err().code, "run_finalizing");
            } else {
                assert_eq!(edited.unwrap()["revision"], 2);
            }
            store
                .finish(&job.id, JobState::Completed, Some(json!({})), None)
                .unwrap();
        }
    }
}
