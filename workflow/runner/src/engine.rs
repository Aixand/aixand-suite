use crate::{Error, Result, Submission, model::digest};
use aixand_ir::{
    AIXAND_CATALOG, CatalogRegistry, VERIFIER_CATALOG, Workflow, parse_catalog, parse_workflow,
};
use aixand_ir_runner::{BindingRegistry, CleanupPolicy, Event, Failure, Runner, Scope};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub type Observer = Arc<dyn Fn(Value) + Send + Sync>;
pub type CheckpointWriter = Arc<dyn Fn(&Value) -> Result<()> + Send + Sync>;

/// A host-owned checkpoint. External effects must have stable identities before dispatch.
pub struct ExecutionJournal {
    pub job_id: String,
    pub checkpoint: Value,
    pub persist: CheckpointWriter,
    pub cancel_requested: Arc<dyn Fn() -> bool + Send + Sync>,
    pub control: Option<Arc<crate::plans::PlanControl>>,
}

/// Embedders register executable bindings; portable requests cannot load code.
#[async_trait]
pub trait Engine: Send + Sync {
    fn fingerprint(&self) -> &str;
    fn capabilities(&self) -> Value {
        json!({})
    }
    fn submission_fingerprint(&self, _submission: &Submission) -> &str {
        self.fingerprint()
    }
    async fn preflight(&self, submission: &Submission) -> Result<()>;
    async fn preflight_template(&self, submission: &Submission) -> Result<()> {
        self.preflight(submission).await
    }
    async fn execute(
        &self,
        submission: Submission,
        observer: Observer,
        cancellation: CancellationToken,
    ) -> std::result::Result<Value, Failure>;

    fn resumable(&self, _submission: &Submission) -> bool {
        false
    }

    async fn execute_journaled(
        &self,
        submission: Submission,
        observer: Observer,
        cancellation: CancellationToken,
        _journal: ExecutionJournal,
    ) -> std::result::Result<Value, Failure> {
        self.execute(submission, observer, cancellation).await
    }
}

pub struct IrEngine {
    catalogs: CatalogRegistry,
    bindings: BindingRegistry,
    fingerprint: String,
    graph_fingerprint: String,
    graph_v2_fingerprint: String,
    suite_socket: std::path::PathBuf,
    #[cfg(feature = "sdk")]
    sdk: Option<aixand_ir_aixand::Config>,
}

impl IrEngine {
    pub fn verifier() -> Result<Self> {
        let catalogs = CatalogRegistry::new([
            parse_catalog(VERIFIER_CATALOG)?,
            parse_catalog(AIXAND_CATALOG)?,
            crate::graph::catalog()?,
        ])?;
        let mut bindings = BindingRegistry::default();
        aixand_ir_verifier::register(&mut bindings)?;
        Self::with_bindings(catalogs, bindings, "builtin-verifier-1")
    }

    /// `binding_version` must change when executable behavior changes incompatibly.
    pub fn with_bindings(
        catalogs: CatalogRegistry,
        bindings: BindingRegistry,
        binding_version: &str,
    ) -> Result<Self> {
        let all_contracts: Vec<_> = catalogs.definitions().map(|d| d.as_ref()).collect();
        let contracts: Vec<_> = all_contracts
            .iter()
            .filter(|definition| {
                ![
                    "workflow.value",
                    "workflow.text",
                    "aixand.project.chat",
                    "carrier.human.deliver",
                ]
                .contains(&definition.id.as_str())
            })
            .collect();
        let fingerprint = digest(
            &json!({"host":env!("CARGO_PKG_VERSION"),"bindings":binding_version,"contracts":contracts}),
        )?;
        let graph_fingerprint =
            digest(&json!({"legacy":fingerprint,"graph_bindings":1,"contracts":all_contracts}))?;
        let graph_v2_fingerprint = digest(&json!({"legacy":graph_fingerprint,"mutable_graph":2}))?;
        Ok(Self {
            catalogs,
            bindings,
            graph_fingerprint,
            graph_v2_fingerprint,
            fingerprint,
            suite_socket: crate::native::default_suite_socket(),
            #[cfg(feature = "sdk")]
            sdk: None,
        })
    }

    #[cfg(feature = "sdk")]
    pub fn with_sdk(config: aixand_ir_aixand::Config) -> Result<Self> {
        config.initialize_python().map_err(|e| Error::new(&e.code, e.message))?;
        let mut engine = Self::verifier()?;
        engine.fingerprint = digest(&json!({"engine":engine.fingerprint,"sdk_config":config}))?;
        engine.graph_fingerprint =
            digest(&json!({"engine":engine.graph_fingerprint,"sdk_config":config}))?;
        engine.graph_v2_fingerprint =
            digest(&json!({"engine":engine.graph_v2_fingerprint,"sdk_config":config}))?;
        engine.sdk = Some(config);
        Ok(engine)
    }

    pub fn with_suite_socket(mut self, socket: std::path::PathBuf) -> Result<Self> {
        self.graph_fingerprint =
            digest(&json!({"engine":self.graph_fingerprint,"suite_socket":socket}))?;
        self.graph_v2_fingerprint =
            digest(&json!({"engine":self.graph_v2_fingerprint,"suite_socket":socket}))?;
        self.suite_socket = socket;
        Ok(self)
    }

    async fn prepare(
        &self,
        workflow: &Workflow,
        _observer: Option<Observer>,
        effects: Option<Arc<crate::graph::Effects>>,
        agent_context: &Value,
        job_id: Option<&str>,
        _all_bindings: bool,
    ) -> std::result::Result<(Runner, Scope), Failure> {
        let scope = Scope::new(CleanupPolicy::StopOwned);
        #[allow(unused_mut)]
        let mut bindings = self.bindings.clone();
        if let Some(effects) = effects {
            crate::graph::install(&self.catalogs, &mut bindings, effects)
                .map_err(|error| Failure::new(&error.code, error.message))?;
        }
        #[cfg(feature = "sdk")]
        if (_all_bindings
            || workflow.body.operations().iter().any(|step| {
                step.identity()
                    .is_some_and(|op| op.id.starts_with("aixand."))
            }))
            && let Some(config) = &self.sdk
        {
            let mut labels = json!({"orchestrator":"runner"});
            if let Some(job_id) = job_id {
                labels["runner.job_id"] = json!(job_id);
            }
            if let Some(name) = &workflow.name
                && name.len() <= 256
                && !name.chars().any(char::is_control)
            {
                labels["workflow.name"] = json!(name);
            }
            let config = config.with_context(agent_context)?;
            if let Some(job_id) = job_id
                && config
                    .connection
                    .get("labels")
                    .and_then(|v| v.get("workflow.run_id"))
                    .is_none()
            {
                labels["workflow.run_id"] = json!(job_id);
            }
            if config
                .connection
                .get("labels")
                .and_then(|v| v.get("workflow.name"))
                .is_some()
            {
                labels
                    .as_object_mut()
                    .expect("label map")
                    .remove("workflow.name");
            }
            let config = config.with_context(&json!({"labels":labels}))?;
            let config = if config
                .connection
                .get("labels")
                .and_then(|v| v.get("app"))
                .is_none()
            {
                config.with_context(&json!({"labels":{"app":"runner"}}))?
            } else {
                config
            };
            let installed = if let Some(observer) = _observer {
                aixand_ir_aixand::install_with_session_observer(
                    &scope,
                    &mut bindings,
                    config.clone(),
                    Arc::new(move |session| {
                        observer(
                            json!({"event":"agent_session", "invocation":session.invocation,
                            "run_id":session.run_id, "session_id":session.session_id,
                            "provider":session.provider}),
                        );
                    }),
                )
            } else {
                aixand_ir_aixand::install(&scope, &mut bindings, config.clone())
            };
            if let Err(mut error) = installed {
                if let Err(cleanup) = scope.close().await {
                    error.cleanup_errors.push(cleanup);
                }
                return Err(error);
            }
        }
        let _ = workflow;
        let _ = (agent_context, job_id);
        Ok((Runner::new(self.catalogs.clone(), bindings), scope))
    }

    async fn execute_ir(
        &self,
        submission: Submission,
        observer: Observer,
        cancellation: CancellationToken,
        job_id: Option<&str>,
    ) -> std::result::Result<Value, Failure> {
        let workflow = parse_workflow(&submission.workflow.to_string())?;
        let (runner, scope) = self
            .prepare(
                &workflow,
                Some(observer.clone()),
                None,
                submission
                    .metadata
                    .get("agent_context")
                    .unwrap_or(&json!({})),
                job_id,
                false,
            )
            .await?;
        runner.with_observer(move |event| observer(match event {
            Event::Prepared {warnings} => json!({"event":"prepared","warnings":warnings}),
            Event::Started {invocation,operation} => json!({"event":"started","invocation":invocation,"operation":operation}),
            Event::Published {invocation} => json!({"event":"published","invocation":invocation}),
            Event::Failed {failure} => json!({"event":"failed","failure":failure}),
            Event::BranchEvaluated {invocation,result,selected} => json!({"event":"branch_evaluated","invocation":invocation,"result":result,"selected":selected}),
            Event::Completed => json!({"event":"completed"}),
        })).run_scoped_json(&workflow, submission.inputs, scope, cancellation).await
    }
}

#[async_trait]
impl Engine for IrEngine {
    fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
    fn submission_fingerprint(&self, submission: &Submission) -> &str {
        if submission.workflow["format"] == crate::graph::FORMAT {
            if submission.workflow["version"] == 2 {
                &self.graph_v2_fingerprint
            } else {
                &self.graph_fingerprint
            }
        } else {
            &self.fingerprint
        }
    }
    fn capabilities(&self) -> Value {
        json!({"workflow_graphs":[1,2],"workflow_amendments":[2],"workflow_continuations":[1],"workflow_edits_adoption":[1],"resource_capture_policies":["stage","workflow"]})
    }
    fn resumable(&self, submission: &Submission) -> bool {
        submission.workflow["format"] == crate::graph::FORMAT
            && crate::graph::Graph::parse(&submission.workflow).is_ok_and(|graph| graph.resumable())
    }
    async fn execute_journaled(
        &self,
        submission: Submission,
        observer: Observer,
        cancellation: CancellationToken,
        journal: ExecutionJournal,
    ) -> std::result::Result<Value, Failure> {
        if submission.workflow["format"] != crate::graph::FORMAT {
            return self
                .execute_ir(submission, observer, cancellation, Some(&journal.job_id))
                .await;
        }
        let graph = crate::graph::Graph::parse(&submission.workflow)
            .map_err(|error| Failure::new(&error.code, error.message))?;
        let effects = Arc::new(crate::graph::Effects {
            job_id: journal.job_id.clone(),
            context: graph.context.clone(),
            observer: observer.clone(),
            socket: self.suite_socket.clone(),
            agent_context: submission
                .metadata
                .get("agent_context")
                .cloned()
                .unwrap_or(json!({})),
            control: journal.control.clone(),
        });
        let (runner, scope) = self
            .prepare(
                &graph.workflow,
                Some(observer.clone()),
                Some(effects),
                submission
                    .metadata
                    .get("agent_context")
                    .unwrap_or(&json!({})),
                Some(&journal.job_id),
                graph.version == 2,
            )
            .await?;
        let notify = observer.clone();
        let runner = runner.with_observer(move |event| notify(match event {
            Event::Prepared {warnings} => json!({"event":"prepared","warnings":warnings}),
            Event::Started {invocation,operation} => json!({"event":"started","invocation":invocation,"operation":operation}),
            Event::Published {invocation} => json!({"event":"published","invocation":invocation}),
            Event::Failed {failure} => json!({"event":"failed","failure":failure}),
            Event::BranchEvaluated {invocation,result,selected} => json!({"event":"branch_evaluated","invocation":invocation,"result":result,"selected":selected}),
            Event::Completed => json!({"event":"completed"}),
        }));
        let resumable = graph.resumable();
        let checkpoint = Arc::new(std::sync::Mutex::new(journal.checkpoint));
        let restored = if resumable {
            checkpoint
                .lock()
                .map_err(|_| Failure::new("checkpoint", "Checkpoint lock failed"))?
                .get("published")
                .cloned()
                .unwrap_or(json!({}))
        } else {
            json!({})
        };
        let saved = checkpoint.clone();
        let persist = journal.persist.clone();
        let publish = Arc::new(move |id: &str, outputs: &Value| {
            if resumable {
                let mut value = saved
                    .lock()
                    .map_err(|_| Failure::new("checkpoint", "Checkpoint lock failed"))?;
                if value.get("published").is_none() {
                    value["published"] = json!({});
                }
                value["published"][id] = outputs.clone();
                persist(&value).map_err(|error| Failure::new(&error.code, error.message))?;
            }
            Ok(())
        });
        let mut result = if let Some(control) = journal.control.clone() {
            runner
                .run_graph_controlled(
                    submission.inputs,
                    &scope,
                    cancellation.clone(),
                    restored,
                    control,
                )
                .await
        } else {
            runner
                .run_graph_json(
                    &graph.workflow,
                    submission.inputs,
                    &graph.dependencies,
                    &scope,
                    cancellation.clone(),
                    restored,
                    publish,
                )
                .await
        };
        if let Err(cleanup) = scope.close().await {
            match &mut result {
                Err(error) => error.cleanup_errors.push(cleanup),
                Ok(_) => result = Err(cleanup),
            }
        }
        let current_graph = journal
            .control
            .as_ref()
            .map(|control| control.snapshot())
            .transpose()
            .map_err(|error| Failure::new(&error.code, error.message))?
            .map(|plan| crate::graph::Graph::parse(&plan.workflow))
            .transpose()
            .map_err(|error| Failure::new(&error.code, error.message))?
            .unwrap_or(graph);
        let graph = current_graph;
        if cancellation.is_cancelled() && !(journal.cancel_requested)() && graph.resumable() {
            if result
                .as_ref()
                .err()
                .is_some_and(|error| !error.cleanup_errors.is_empty())
            {
                return result;
            }
            return Err(Failure::new(
                "suspended",
                "Workflow suspended for service shutdown",
            ));
        }
        if cancellation.is_cancelled()
            && !(journal.cancel_requested)()
            && journal.control.is_some()
            && !graph.resumable()
        {
            return Err(Failure::new(
                "effect_uncertain",
                "SDK resources cannot be restored after service interruption",
            ));
        }
        let reconcile = graph.resumable()
            && result
                .as_ref()
                .is_err_and(|error| error.code == "effect_uncertain");
        if result.is_err() && graph.has_chats() && !reconcile {
            for step in graph.workflow.body.operations() {
                if step
                    .identity()
                    .is_some_and(|op| op.id == "aixand.project.chat")
                    && let Err(error) = crate::graph::rpc(
                        &self.suite_socket,
                        "cancel",
                        json!({"job_id":journal.job_id,"step_id":step.id()}),
                    )
                    .await
                    && let Err(primary) = &mut result
                {
                    primary
                        .cleanup_errors
                        .push(Failure::new("effect_uncertain", error.message));
                }
            }
        }
        if let Err(error) = &result
            && graph.has_delivery()
            && error.code != "cancelled"
            && !reconcile
        {
            let args = json!({"job_id":journal.job_id,"context":graph.context,"title":graph.workflow.name,"value":format!("Workflow could not finish: {}", error.message),"failed":true});
            if let Err(delivery) =
                crate::graph::rpc(&self.suite_socket, "graph_publish", args).await
                && let Err(primary) = &mut result
            {
                primary
                    .cleanup_errors
                    .push(Failure::new(&delivery.code, delivery.message));
            }
        }
        result
    }

    async fn preflight(&self, submission: &Submission) -> Result<()> {
        if submission.workflow["format"] == crate::graph::FORMAT {
            let graph = crate::graph::Graph::parse(&submission.workflow)?;
            let effects = Arc::new(crate::graph::Effects {
                job_id: String::new(),
                context: graph.context.clone(),
                observer: Arc::new(|_| {}),
                socket: self.suite_socket.clone(),
                agent_context: submission
                    .metadata
                    .get("agent_context")
                    .cloned()
                    .unwrap_or(json!({})),
                control: None,
            });
            let (runner, scope) = self
                .prepare(
                    &graph.workflow,
                    None,
                    Some(effects),
                    submission
                        .metadata
                        .get("agent_context")
                        .unwrap_or(&json!({})),
                    None,
                    graph.version == 2,
                )
                .await?;
            let result = runner
                .preflight_json(&graph.workflow, &submission.inputs, &scope)
                .and_then(|_| runner.validate_graph(&graph.workflow, &graph.dependencies));
            let cleanup = scope.close().await;
            result?;
            cleanup?;
            crate::graph::validate(&graph, &self.suite_socket).await?;
            return Ok(());
        }
        let workflow = parse_workflow(&submission.workflow.to_string())?;
        let (runner, scope) = self
            .prepare(
                &workflow,
                None,
                None,
                submission
                    .metadata
                    .get("agent_context")
                    .unwrap_or(&json!({})),
                None,
                false,
            )
            .await?;
        let result = runner
            .preflight_json(&workflow, &submission.inputs, &scope)
            .map_err(Error::from);
        let cleanup = scope.close().await.map_err(Error::from);
        result.and(cleanup)
    }

    async fn preflight_template(&self, submission: &Submission) -> Result<()> {
        let (workflow, graph) = if submission.workflow["format"] == crate::graph::FORMAT {
            let graph = crate::graph::Graph::parse(&submission.workflow)?;
            (graph.workflow.clone(), Some(graph))
        } else {
            (parse_workflow(&submission.workflow.to_string())?, None)
        };
        let effects = graph.as_ref().map(|graph| {
            Arc::new(crate::graph::Effects {
                job_id: String::new(),
                context: graph.context.clone(),
                observer: Arc::new(|_| {}),
                socket: self.suite_socket.clone(),
                agent_context: submission
                    .metadata
                    .get("agent_context")
                    .cloned()
                    .unwrap_or(json!({})),
                control: None,
            })
        });
        let (runner, scope) = self
            .prepare(
                &workflow,
                None,
                effects,
                submission
                    .metadata
                    .get("agent_context")
                    .unwrap_or(&json!({})),
                None,
                graph.as_ref().is_some_and(|g| g.version == 2),
            )
            .await?;
        let result = runner
            .preflight_template(&workflow, &scope)
            .and_then(|_| match &graph {
                Some(g) => runner.validate_graph(&workflow, &g.dependencies),
                None => Ok(()),
            });
        let cleanup = scope.close().await;
        result?;
        cleanup?;
        if let Some(graph) = graph {
            crate::graph::validate(&graph, &self.suite_socket).await?;
        }
        Ok(())
    }

    async fn execute(
        &self,
        submission: Submission,
        observer: Observer,
        cancellation: CancellationToken,
    ) -> std::result::Result<Value, Failure> {
        self.execute_ir(submission, observer, cancellation, None)
            .await
    }
}
