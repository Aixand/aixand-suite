use crate::{
    Error, Result,
    engine::{Engine, ExecutionJournal},
    model::*,
    store::Store,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::Notify,
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

use crate::transport::{Listener, Stream};
#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, PermissionsExt};

pub struct Service {
    home: PathBuf,
    _owner: File,
    store: Arc<Store>,
    engine: Arc<dyn Engine>,
    wake: Notify,
    active: Mutex<HashMap<String, CancellationToken>>,
    workers: usize,
    serving: AtomicBool,
}

impl Service {
    /// Acquires exclusive ownership before reconciling the previous process's jobs.
    pub fn open(home: impl AsRef<Path>, engine: Arc<dyn Engine>) -> Result<Arc<Self>> {
        Self::open_with_workers(home, engine, 1)
    }

    pub fn open_with_workers(
        home: impl AsRef<Path>,
        engine: Arc<dyn Engine>,
        workers: usize,
    ) -> Result<Arc<Self>> {
        if !(1..=64).contains(&workers) {
            return Err(Error::new(
                "configuration",
                "workers must be between 1 and 64",
            ));
        }
        let home = home.as_ref();
        #[cfg(unix)]
        if !home.exists() {
            std::fs::create_dir_all(home)?;
            std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(windows)]
        undercurrent_platform_windows::prepare_private_directory(home)?;
        let home = home.canonicalize()?;
        let owner = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(home.join("service.lock"))?;
        fs2::FileExt::try_lock_exclusive(&owner).map_err(|e| {
            Error::new(
                "service_owned",
                format!("Runner home already has an owner or cannot be locked: {e}"),
            )
        })?;
        let store = Arc::new(Store::open(&home.join("jobs.sqlite3"))?);
        #[cfg(unix)]
        std::fs::set_permissions(
            home.join("jobs.sqlite3"),
            std::fs::Permissions::from_mode(0o600),
        )?;
        store.recover(|job| engine.resumable(&job.submission))?;
        store.adopt_queued()?;
        Ok(Arc::new(Self {
            home,
            _owner: owner,
            store,
            engine,
            wake: Notify::new(),
            active: Mutex::new(HashMap::new()),
            workers,
            serving: AtomicBool::new(false),
        }))
    }

    pub fn socket(&self) -> PathBuf {
        self.home.join("runner.sock")
    }

    fn signal_cancellation(&self, job: &Job) -> Result<()> {
        if let Some(token) = self
            .active
            .lock()
            .map_err(|_| Error::new("internal", "Active attempt lock poisoned"))?
            .get(&job.id)
        {
            token.cancel();
        }
        self.wake.notify_one();
        Ok(())
    }

    pub async fn handle(&self, request: Request) -> Result<Value> {
        match request {
            Request::Health => Ok(
                json!({"service":"runner","version":env!("CARGO_PKG_VERSION"),"protocol":1,"engine_digest":self.engine.fingerprint(),"workers":self.workers,"capabilities":self.engine.capabilities()}),
            ),
            Request::Submit { submission } => {
                submission.validate_envelope()?;
                let digest = submission.digest()?;
                // A lost response can be recovered even when runtime configuration changed.
                if let Some(job) = self.store.existing(&submission.key, &digest)? {
                    return Ok(json!({"job":job,"replayed":true}));
                }
                self.engine.preflight(&submission).await?;
                let fingerprint = self.engine.submission_fingerprint(&submission).to_owned();
                let (job, replayed) = self.store.submit(submission, &fingerprint)?;
                self.wake.notify_one();
                Ok(json!({"job":job,"replayed":replayed}))
            }
            Request::List { after, limit } => Ok(json!({"jobs":self.store.list(after,limit)?})),
            Request::Inspect { id } => Ok(serde_json::to_value(self.store.get(&id)?)?),
            Request::Lookup { key } => Ok(serde_json::to_value(self.store.lookup(&key)?)?),
            Request::Result { id } => {
                let job = self.store.get(&id)?;
                Ok(json!({"id":id,"state":job.state,"result":job.result,"error":job.error}))
            }
            Request::Events { id, after, limit } => {
                Ok(serde_json::to_value(self.store.events(&id, after, limit)?)?)
            }
            Request::Cancel { id } => {
                let resumable = self
                    .engine
                    .resumable(&self.store.effective_submission(&id)?);
                let job = self.store.cancel(&id, resumable)?;
                self.signal_cancellation(&job)?;
                Ok(serde_json::to_value(job)?)
            }
            Request::CancelKey { key } => {
                let job = self
                    .store
                    .cancel_submission(&key, |job| self.engine.resumable(&job.submission))?;
                if let Some(job) = &job {
                    self.signal_cancellation(job)?;
                }
                Ok(serde_json::to_value(job)?)
            }
            Request::Resume { id } => {
                if !self
                    .engine
                    .resumable(&self.store.effective_submission(&id)?)
                {
                    return Err(Error::new(
                        "state",
                        "This workflow does not support reconciliation",
                    ));
                }
                let job = self.store.resume(&id)?;
                self.wake.notify_one();
                Ok(serde_json::to_value(job)?)
            }
            Request::Plan { id } => Ok(serde_json::to_value(self.store.plan(&id)?)?),
            Request::Amend {
                id,
                key,
                expected_revision,
                workflow,
                authoring,
            } => {
                crate::plans::validate_key(&key)?;
                crate::plans::validate_amendment(&workflow, authoring.as_ref())?;
                let digest = crate::model::digest(
                    &json!({"expected_revision":expected_revision,"workflow":workflow,"authoring":authoring}),
                )?;
                if let Some(replay) = self.store.amendment_replay(&id, &key, &digest)? {
                    return Ok(replay);
                }
                let mut candidate = self.store.effective_submission(&id)?;
                candidate.workflow = workflow.clone();
                if self.engine.submission_fingerprint(&candidate)
                    != self.store.plan(&id)?.engine_digest
                {
                    return Err(Error::new(
                        "engine_changed",
                        "The run's pinned execution environment changed",
                    ));
                }
                self.engine.preflight(&candidate).await?;
                self.store.amend(
                    &id,
                    &key,
                    expected_revision,
                    &workflow,
                    authoring.as_ref(),
                    &digest,
                )
            }
            Request::Hold { id } => Ok(serde_json::to_value(self.store.hold(&id, true)?)?),
            Request::Release { id } => {
                let plan = self.store.hold(&id, false)?;
                self.wake.notify_one();
                Ok(serde_json::to_value(plan)?)
            }
            Request::Continue {
                id,
                key,
                mut target,
                input_map,
            } => {
                crate::plans::validate_key(&key)?;
                let parent = self.store.get(&id)?;
                target.validate_envelope()?;
                target.key = format!(
                    "runner:continuation:{}",
                    crate::model::digest(&json!([id, key]))?.trim_start_matches("sha256:")
                );
                if !target.metadata.is_object() {
                    return Err(Error::new("request", "Target metadata must be an object"));
                }
                let mut inherited = parent
                    .submission
                    .metadata
                    .get("agent_context")
                    .cloned()
                    .unwrap_or(json!({}));
                if let Some(labels) = inherited.get_mut("labels").and_then(Value::as_object_mut) {
                    for name in [
                        "workflow.run_id",
                        "workflow.step_id",
                        "workflow.name",
                        "runner.job_id",
                    ] {
                        labels.remove(name);
                    }
                }
                if let Some(metadata) = inherited.get_mut("metadata").and_then(Value::as_object_mut)
                {
                    for name in [
                        "suite.spawn_modes",
                        "suite.submission_key",
                        "suite.workflow_title",
                        "suite.stage_title",
                        "suite.input_step_ids",
                    ] {
                        metadata.remove(name);
                    }
                }
                if let Some(context) = target.metadata.get("agent_context") {
                    for layer in ["labels", "metadata"] {
                        if let Some(values) = context.get(layer).and_then(Value::as_object) {
                            if inherited.get(layer).is_none() {
                                inherited[layer] = json!({});
                            }
                            inherited[layer]
                                .as_object_mut()
                                .ok_or_else(|| {
                                    Error::new("agent_context", "Invalid inherited context")
                                })?
                                .extend(values.clone());
                        }
                    }
                }
                if inherited != json!({}) {
                    target.metadata["agent_context"] = inherited;
                }
                target.metadata["parent_job_id"] = json!(id);
                target.metadata["root_job_id"] = parent
                    .submission
                    .metadata
                    .get("root_job_id")
                    .cloned()
                    .unwrap_or(json!(id));
                target.validate_envelope()?;
                if let Some(replay) = self
                    .store
                    .continuation_replay(&id, &key, &target, &input_map)?
                {
                    return Ok(serde_json::to_value(replay)?);
                }
                let inputs = if target.workflow["format"] == crate::graph::FORMAT {
                    &target.workflow["workflow"]["inputs"]
                } else {
                    &target.workflow["inputs"]
                };
                for name in input_map.keys() {
                    if inputs.get(name).is_none() {
                        return Err(Error::new(
                            "input_mapping",
                            "A mapped input must be declared by the child workflow",
                        ));
                    }
                }
                if let Some(declared) = inputs.as_object() {
                    for (name, input) in declared {
                        if !input_map.contains_key(name)
                            && target.inputs.get(name).is_none()
                            && input.get("default").is_none()
                        {
                            return Err(Error::new(
                                "input_mapping",
                                format!("Missing child input {name}"),
                            ));
                        }
                    }
                }
                self.engine.preflight_template(&target).await?;
                let fingerprint = self.engine.submission_fingerprint(&target).to_owned();
                Ok(serde_json::to_value(self.store.register_continuation(
                    &id,
                    &key,
                    &target,
                    &input_map,
                    &fingerprint,
                )?)?)
            }
            Request::Continuations { id } => {
                Ok(json!({"continuations":self.store.continuations(&id)?}))
            }
            Request::CancelContinuation { id } => {
                Ok(serde_json::to_value(self.store.cancel_continuation(&id)?)?)
            }
            Request::Runs { offset, limit } => self.store.workflow_runs(offset, limit),
            Request::EnableEdits {
                id,
                key,
                authoring,
                groups,
                identities,
            } => {
                crate::plans::validate_key(&key)?;
                let plan = self.store.plan(&id)?;
                if plan.revision > 0 {
                    return Ok(serde_json::to_value(plan)?);
                }
                let original = self.store.effective_submission(&id)?;
                if plan.engine_digest != self.engine.submission_fingerprint(&original) {
                    return Err(Error::new(
                        "engine_changed",
                        "The legacy execution environment changed",
                    ));
                }
                let mut candidate = original.clone();
                if !matches!(
                    candidate.workflow["format"].as_str(),
                    Some("aixand.chat-workflow" | "aixand.workflow-graph")
                ) {
                    return Err(Error::new(
                        "unsupported",
                        "Only native plans and flat graphs can adopt mutable execution",
                    ));
                }
                candidate.workflow["version"] = json!(2);
                if candidate.workflow["format"] == crate::graph::FORMAT {
                    candidate.workflow["groups"] = if groups.is_empty() {
                        json!(
                            candidate.workflow["workflow"]["body"]["steps"]
                                .as_array()
                                .ok_or_else(|| Error::new("graph", "Missing operations"))?
                                .iter()
                                .map(|step| (
                                    step["id"].as_str().unwrap_or("").to_owned(),
                                    vec![step["id"].as_str().unwrap_or("").to_owned()]
                                ))
                                .collect::<std::collections::BTreeMap<_, _>>()
                        )
                    } else {
                        json!(groups)
                    };
                    if !identities.is_empty() {
                        candidate.workflow["identities"] = json!(identities);
                    }
                    if candidate.workflow["workflow"]["outputs"]
                        .get("result")
                        .is_none()
                    {
                        let steps = candidate.workflow["workflow"]["body"]["steps"]
                            .as_array()
                            .unwrap();
                        let result = steps
                            .iter()
                            .find(|step| step["operation"]["id"] == "carrier.human.deliver")
                            .map(|step| step["inputs"]["value"].clone())
                            .or_else(|| {
                                candidate.workflow["workflow"]["outputs"]["final_reply_text"]
                                    .get("value")
                                    .cloned()
                            })
                            .or_else(|| {
                                candidate.workflow["workflow"]["outputs"]
                                    .as_object()
                                    .and_then(|outputs| outputs.values().next())
                                    .and_then(|output| output.get("value"))
                                    .cloned()
                            });
                        if let Some(result) = result {
                            candidate.workflow["workflow"]["outputs"]["result"] =
                                json!({"type":{"kind":"json"},"value":result});
                        }
                    }
                }
                self.engine.preflight(&candidate).await?;
                let request = json!({"key":key,"workflow":candidate.workflow,"authoring":authoring,"engine_digest":self.engine.submission_fingerprint(&candidate)});
                self.store
                    .request_adoption(&id, &request, self.engine.resumable(&original))?;
                if let Some(token) = self
                    .active
                    .lock()
                    .map_err(|_| Error::new("internal", "Active attempt lock poisoned"))?
                    .get(&id)
                {
                    token.cancel();
                }
                self.wake.notify_one();
                for _ in 0..150 {
                    self.store.adopt_queued()?;
                    let plan = self.store.plan(&id)?;
                    if plan.revision > 0 {
                        return Ok(serde_json::to_value(plan)?);
                    }
                    if !self.store.adoption_pending(&id)? {
                        if self.store.get(&id)?.state == JobState::Uncertain {
                            return Err(Error::new(
                                "effect_uncertain",
                                "Reconcile existing effects before enabling edits",
                            ));
                        }
                        return Err(Error::new(
                            "run_finalizing",
                            "The legacy run completed or began delivery; attach a follow-up",
                        ));
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(Error::new(
                    "adoption_pending",
                    "The suspension is still being reconciled. Retry the same request.",
                ))
            }
        }
    }

    pub async fn serve(self: Arc<Self>, shutdown: CancellationToken) -> Result<()> {
        if self.serving.swap(true, Ordering::SeqCst) {
            return Err(Error::new(
                "service_owned",
                "This service has already started",
            ));
        }
        let path = self.socket();
        #[cfg(unix)]
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_socket() => std::fs::remove_file(&path)?,
            Ok(_) => {
                return Err(Error::new(
                    "socket",
                    "Refusing to replace a non-socket file",
                ));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
        #[cfg(unix)]
        let listener = Listener::bind(&path)?;
        #[cfg(windows)]
        let listener = Listener::bind(&path).await?;
        #[cfg(unix)]
        let _socket = SocketFile(path.clone());
        #[cfg(unix)]
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let worker_service = self.clone();
        let worker_stop = shutdown.clone();
        let mut worker = tokio::spawn(async move {
            let mut pool = JoinSet::new();
            let continuations = worker_service.clone();
            let continuation_stop = worker_stop.clone();
            pool.spawn(async move {
                continuations
                    .dispatch_continuations(continuation_stop)
                    .await
            });
            for _ in 0..worker_service.workers {
                let service = worker_service.clone();
                let stop = worker_stop.clone();
                pool.spawn(async move { service.work(stop).await });
            }
            let mut failure = None;
            while let Some(result) = pool.join_next().await {
                let result = result
                    .map_err(|e| Error::new("worker", e.to_string()))
                    .and_then(|r| r);
                if let Err(error) = result {
                    failure.get_or_insert(error);
                    worker_stop.cancel();
                }
            }
            failure.map_or(Ok(()), Err)
        });
        let mut clients = JoinSet::new();
        let mut accept_error = None;
        let worker_outcome = loop {
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => break None,
                result = &mut worker => break Some(result),
                Some(result) = clients.join_next(), if !clients.is_empty() => {
                    if let Err(e) = result { eprintln!("Client task failed: {e}"); }
                }
                incoming = listener.accept() => {
                    match incoming {
                        Ok((stream,_)) => {
                            let service = self.clone();
                            clients.spawn(async move { service.connection(stream).await });
                        }
                        Err(e) => { accept_error = Some(Error::from(e)); break None; }
                    }
                }
            }
        };
        drop(listener);
        shutdown.cancel();
        let result = match worker_outcome {
            Some(result) => result,
            None => worker.await,
        }
        .map_err(|e| Error::new("worker", e.to_string()))?;
        // Let in-flight submissions persist and replies finish before closing clients.
        if tokio::time::timeout(Duration::from_secs(6), async {
            while clients.join_next().await.is_some() {}
        })
        .await
        .is_err()
        {
            clients.abort_all();
            while clients.join_next().await.is_some() {}
        }
        if let Some(e) = accept_error {
            return Err(e);
        }
        result
    }

    async fn connection(&self, mut stream: Stream) {
        let result = async {
            let bytes = tokio::time::timeout(
                Duration::from_secs(5),
                read_frame(&mut stream, MAX_REQUEST_BYTES),
            )
            .await
            .map_err(|_| Error::new("timeout", "Timed out reading request"))??;
            let source =
                std::str::from_utf8(&bytes).map_err(|e| Error::new("request", e.to_string()))?;
            let value = aixand_ir::parse_json(source)?;
            let request =
                serde_json::from_value(value).map_err(|e| Error::new("request", e.to_string()))?;
            self.handle(request).await
        }
        .await;
        let response = Response::from(result);
        let mut bytes = match serde_json::to_vec(&response) {
            Ok(bytes) => bytes,
            Err(_) => return,
        };
        if bytes.len() > MAX_RESPONSE_BYTES {
            bytes = serde_json::to_vec(&Response::from(Err(Error::new(
                "response_limit",
                "Response exceeds 16 MiB; request a smaller event page",
            ))))
            .unwrap_or_default();
        }
        bytes.push(b'\n');
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.write_all(&bytes)).await;
    }

    async fn dispatch_continuations(&self, shutdown: CancellationToken) -> Result<()> {
        loop {
            if shutdown.is_cancelled() {
                return Ok(());
            }
            for id in self.store.ready_continuations()? {
                let (record, mut target, input_map, pinned) =
                    self.store.continuation_target(&id)?;
                if record.state != "ready" {
                    continue;
                }
                let parent = self.store.get(&record.parent_id)?;
                let prepare = async {
                    let result = parent.result.as_ref().ok_or_else(|| {
                        Error::new("input_mapping", "Parent result is unavailable")
                    })?;
                    for (name, path) in input_map {
                        let value = result.pointer(&path).ok_or_else(|| {
                            Error::new(
                                "input_mapping",
                                format!("Parent result has no value at {path}"),
                            )
                        })?;
                        target.inputs[&name] = value.clone();
                    }
                    if self.engine.submission_fingerprint(&target) != pinned {
                        return Err(Error::new(
                            "engine_changed",
                            "Continuation's pinned execution environment changed",
                        ));
                    }
                    self.engine.preflight(&target).await?;
                    Ok(target)
                };
                let outcome: Result<Submission> = tokio::select! { _=shutdown.cancelled()=>return Ok(()), result=prepare=>result };
                match outcome {
                    Ok(target) => match self.store.materialize_continuation(&id, target, &pinned) {
                        Ok(Some(_)) => self.wake.notify_one(),
                        Ok(None) => (),
                        Err(error) if matches!(error.code.as_str(), "cancelled" | "conflict") => {
                            self.store.block_continuation(&id, &error)?
                        }
                        Err(error) => return Err(error),
                    },
                    Err(error)
                        if matches!(
                            error.code.as_str(),
                            "suite_unavailable" | "carrier_unavailable" | "io"
                        ) => {}
                    Err(error) => self.store.block_continuation(&id, &error)?,
                }
            }
            tokio::select! {_=shutdown.cancelled()=>return Ok(()),_=tokio::time::sleep(Duration::from_millis(250))=>()}
        }
    }

    async fn work(&self, shutdown: CancellationToken) -> Result<()> {
        loop {
            if shutdown.is_cancelled() {
                return Ok(());
            }
            let Some(job) = self.store.claim()? else {
                tokio::select! { _ = shutdown.cancelled() => return Ok(()), _ = self.wake.notified() => () }
                continue;
            };
            let plan = self.store.plan(&job.id)?;
            let submission = self.store.effective_submission(&job.id)?;
            if plan.engine_digest != self.engine.submission_fingerprint(&submission) {
                self.store.finish(&job.id,JobState::Blocked,None,Some(json!({"code":"engine_changed","message":"Pinned runtime configuration or operation contracts changed. Submit reviewed work under a new key."})))?;
                continue;
            }
            let cancel = CancellationToken::new();
            self.active
                .lock()
                .map_err(|_| Error::new("internal", "Active attempt lock poisoned"))?
                .insert(job.id.clone(), cancel.clone());
            self.wake.notify_one();
            // Closes the race between claiming the row and exposing its live token.
            if self.store.get(&job.id)?.cancel_requested || self.store.adoption_pending(&job.id)? {
                cancel.cancel();
            }
            let journal_failed = Arc::new(AtomicBool::new(false));
            let workflow_completed = Arc::new(AtomicBool::new(false));
            let completed = workflow_completed.clone();
            let failed = journal_failed.clone();
            let observer_store = self.store.clone();
            let observer_id = job.id.clone();
            let observer_cancel = cancel.clone();
            let observer = Arc::new(move |event: Value| {
                if event["event"] == "completed" {
                    completed.store(true, Ordering::SeqCst);
                }
                if let Err(error) = observer_store.record_attempt_event(
                    &observer_id,
                    &event,
                    observer_cancel.is_cancelled(),
                ) {
                    eprintln!("Cannot retain job event: {error}");
                    failed.store(true, Ordering::SeqCst);
                    observer_cancel.cancel();
                }
            });
            let checkpoint_store = self.store.clone();
            let checkpoint_id = job.id.clone();
            let cancel_store = self.store.clone();
            let cancel_id = job.id.clone();
            let resumable = self.engine.resumable(&submission);
            let journal = ExecutionJournal {
                job_id: job.id.clone(),
                checkpoint: self.store.checkpoint(&job.id)?,
                persist: Arc::new(move |value| {
                    checkpoint_store
                        .save_checkpoint(&checkpoint_id, value)
                        .map_err(|error| {
                            Error::new(
                                "effect_uncertain",
                                format!("Checkpoint persistence failed: {}", error.message),
                            )
                        })
                }),
                cancel_requested: Arc::new(move || {
                    cancel_store
                        .get(&cancel_id)
                        .map_or(true, |job| job.cancel_requested)
                }),
                control: if plan.revision > 0 {
                    Some(Arc::new(crate::plans::PlanControl::new(
                        self.store.clone(),
                        job.id.clone(),
                        cancel.clone(),
                    )))
                } else {
                    None
                },
            };
            let execution =
                self.engine
                    .execute_journaled(submission, observer, cancel.clone(), journal);
            tokio::pin!(execution);
            let outcome = tokio::select! {
                value = &mut execution => Some(value),
                _ = shutdown.cancelled() => {
                    if !resumable { self.store.cancel(&job.id, false)?; }
                    cancel.cancel();
                    tokio::time::timeout(Duration::from_secs(10), &mut execution).await.ok()
                }
            };
            let suspended = resumable
                && (shutdown.is_cancelled() || self.store.adoption_pending(&job.id)?)
                && !self.store.get(&job.id)?.cancel_requested
                && outcome
                    .as_ref()
                    .is_none_or(|value| matches!(value, Err(error) if error.code == "suspended"));
            let (state, result, error) = if journal_failed.load(Ordering::SeqCst) {
                (
                    JobState::Uncertain,
                    None,
                    Some(
                        json!({"code":"journal_failed","message":"Execution event persistence failed"}),
                    ),
                )
            } else if suspended {
                (JobState::Queued, None, None)
            } else {
                match outcome {
                    Some(Ok(result)) => {
                        if serde_json::to_vec(&result)?.len() > MAX_RESPONSE_BYTES / 2 {
                            (
                                JobState::Failed,
                                None,
                                Some(
                                    json!({"code":"result_limit","message":"Workflow output exceeds 8 MiB; return artifact references"}),
                                ),
                            )
                        } else {
                            (JobState::Completed, Some(result), None)
                        }
                    }
                    Some(Err(error)) => {
                        let state = if workflow_completed.load(Ordering::SeqCst)
                            || !error.cleanup_errors.is_empty()
                            || matches!(
                                error.code.as_str(),
                                "binding_panic"
                                    | "runner_panic"
                                    | "runner_task"
                                    | "effect_uncertain"
                            ) {
                            JobState::Uncertain
                        } else if error.code == "cancelled" {
                            JobState::Cancelled
                        } else {
                            JobState::Failed
                        };
                        (state, None, Some(serde_json::to_value(error)?))
                    }
                    None => (
                        JobState::Uncertain,
                        None,
                        Some(
                            json!({"code":"shutdown_timeout","message":"Cancellation/cleanup did not finish within 10 seconds; effects require inspection"}),
                        ),
                    ),
                }
            };
            self.store.finish(&job.id, state, result, error)?;
            self.active
                .lock()
                .map_err(|_| Error::new("internal", "Active attempt lock poisoned"))?
                .remove(&job.id);
            self.store.adopt_queued()?;
            self.wake.notify_one();
            if journal_failed.load(Ordering::SeqCst) {
                return Err(Error::new(
                    "storage",
                    "Worker stopped after event persistence failed",
                ));
            }
        }
    }
}

struct SocketFile(PathBuf);
impl Drop for SocketFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(crate) async fn read_frame(stream: &mut Stream, max: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    BufReader::new(stream)
        .take((max + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .await?;
    if bytes.len() > max {
        return Err(Error::new(
            "request_limit",
            format!("Frame exceeds {max} bytes"),
        ));
    }
    if bytes.last() != Some(&b'\n') {
        return Err(Error::new(
            "protocol",
            "Expected a newline-terminated JSON frame",
        ));
    }
    Ok(bytes)
}
