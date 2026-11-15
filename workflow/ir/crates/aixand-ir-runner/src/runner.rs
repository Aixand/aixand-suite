use crate::{BindingRegistry, CleanupPolicy, Failure, InvocationContext, Scope};
use aixand_ir::*;
use futures_util::{FutureExt, future::BoxFuture};
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionMode {
    Embedded,
    Json,
}

#[derive(Clone, Debug)]
pub enum Event {
    Prepared {
        warnings: Vec<Diagnostic>,
    },
    Started {
        invocation: String,
        operation: OperationIdentity,
    },
    Published {
        invocation: String,
    },
    Failed {
        failure: Failure,
    },
    BranchEvaluated {
        invocation: String,
        result: bool,
        selected: BranchArm,
    },
    Completed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchArm {
    Then,
    Else,
}

#[derive(Clone)]
pub struct Runner {
    catalogs: CatalogRegistry,
    bindings: BindingRegistry,
    observer: Option<Arc<dyn Fn(Event) + Send + Sync>>,
}

struct Prepared {
    workflow: Workflow,
    inputs: Named<Value>,
    bindings: Named<crate::registry::Entry>,
}
impl Runner {
    /// Retains active invocations and their scope while a host revises pending work.
    pub async fn run_graph_controlled(
        &self,
        supplied: serde_json::Value,
        scope: &Scope,
        cancellation: CancellationToken,
        restored: serde_json::Value,
        control: Arc<dyn crate::GraphControl>,
    ) -> Result<serde_json::Value, Failure> {
        use futures_util::{StreamExt, stream::FuturesUnordered};
        let mut revision = control.current()?;
        let mut prepared = Arc::new(self.prepare_json(&revision.workflow, &supplied, scope)?);
        self.validate_graph(&revision.workflow, &revision.dependencies)?;
        let mut published = Named::new();
        if let Some(saved) = restored.as_object() {
            for (id, outputs) in saved {
                let entry = prepared
                    .bindings
                    .get(id)
                    .ok_or_else(|| Failure::new("checkpoint", "Unknown saved operation"))?;
                let Value::Object(values) = Value::from_json(outputs)? else {
                    return Err(Failure::new("checkpoint", "Invalid saved outputs"));
                };
                validate_outputs(&values, &entry.definition, "/checkpoint")?;
                published.insert(id.clone(), values.as_ref().clone());
            }
        }
        let child = cancellation.child_token();
        let mut started: std::collections::BTreeSet<String> = published.keys().cloned().collect();
        let mut pending: FuturesUnordered<BoxFuture<'_, (String, Result<Named<Value>, Failure>)>> =
            FuturesUnordered::new();
        loop {
            if child.is_cancelled() {
                return Err(Failure::new("cancelled", "Execution cancelled"));
            }
            let latest = control.current()?;
            if latest.revision != revision.revision {
                self.validate_graph(&latest.workflow, &latest.dependencies)?;
                prepared = Arc::new(self.prepare_json(&latest.workflow, &supplied, scope)?);
            }
            revision = latest;
            {
                for (index, step) in prepared.workflow.body.steps().iter().enumerate() {
                    let id = step.id();
                    if started.contains(id)
                        || revision.held && !revision.claimed.contains(id)
                        || !revision.dependencies[id]
                            .iter()
                            .all(|parent| published.contains_key(parent))
                    {
                        continue;
                    }
                    if !control.claim(revision.revision, id)? {
                        break;
                    }
                    started.insert(id.to_owned());
                    let step = step.clone();
                    let accepted = prepared.clone();
                    let values = published.clone();
                    let token = child.clone();
                    pending.push(Box::pin(async move {
                        let execution = Execution {
                            runner: self,
                            inputs: &accepted.inputs,
                            bindings: &accepted.bindings,
                            scope,
                            cancellation: &token,
                            published: values,
                        };
                        let Step::Operation {
                            id,
                            operation,
                            inputs,
                        } = &step
                        else {
                            unreachable!("validated graph")
                        };
                        let result = execution
                            .operation(id, operation, inputs, &format!("/body/steps/{index}"))
                            .await
                            .map_err(|error| execution.failed(&step, error));
                        (id.clone(), result)
                    }));
                }
                if !revision.held
                    && revision
                        .dependencies
                        .keys()
                        .all(|id| published.contains_key(id))
                    && control.seal(revision.revision)?
                {
                    let mut outputs = Named::new();
                    for (name, output) in &prepared.workflow.outputs {
                        let value = evaluate(
                            &output.value,
                            &prepared.inputs,
                            &published,
                            &pointer("/outputs", name),
                        )?;
                        validate_value(&value, &output.ty, &pointer("/outputs", name))?;
                        outputs.insert(name.clone(), value);
                    }
                    self.emit(Event::Completed);
                    return Value::Object(Arc::new(outputs))
                        .to_json()
                        .map_err(Into::into);
                }
            }
            tokio::select! {
                _ = child.cancelled() => return Err(Failure::new("cancelled", "Execution cancelled")),
                result = pending.next(), if !pending.is_empty() => {
                    let (id, result) = result.expect("nonempty invocations");
                    let outputs = match result {
                        Ok(value) => value,
                        Err(error) => {
                            if !matches!(error.code.as_str(), "effect_uncertain" | "binding_panic") { control.fail()?; }
                            child.cancel(); return Err(error);
                        }
                    };
                    let json = Value::Object(Arc::new(outputs.clone())).to_json().ok();
                    control.publish(&id, json.as_ref())?;
                    published.insert(id.clone(), outputs);
                    self.emit(Event::Published { invocation: id });
                }
                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => (),
            }
        }
    }

    /// Validate a continuation template before its concrete input values exist.
    pub fn preflight_template(&self, workflow: &Workflow, scope: &Scope) -> Result<(), Failure> {
        validate_workflow(workflow, &self.catalogs)?;
        scope.check()?;
        if workflow.inputs.values().any(|input| !input.ty.json_only())
            || workflow
                .outputs
                .values()
                .any(|output| !output.ty.json_only())
        {
            return Err(Failure::new(
                "opaque_boundary",
                "Continuations require JSON interfaces",
            ));
        }
        for step in workflow.body.operations() {
            self.bindings.resolve(
                self.catalogs
                    .resolve(step.identity().expect("operation"))
                    .expect("validated contract"),
            )?;
        }
        Ok(())
    }

    /// Execute a validated flat operation graph in one resource scope. References
    /// must be covered by dependency ancestry; independent operations overlap.
    pub async fn run_graph_json(
        &self,
        workflow: &Workflow,
        supplied: serde_json::Value,
        dependencies: &Named<Vec<String>>,
        scope: &Scope,
        cancellation: CancellationToken,
        restored: serde_json::Value,
        publish: Arc<dyn Fn(&str, &serde_json::Value) -> Result<(), Failure> + Send + Sync>,
    ) -> Result<serde_json::Value, Failure> {
        use futures_util::{StreamExt, stream::FuturesUnordered};
        let prepared = self.prepare_json(workflow, &supplied, scope)?;
        self.validate_graph(workflow, dependencies)?;
        let mut published = Named::new();
        if let Some(saved) = restored.as_object() {
            for (id, outputs) in saved {
                let entry = prepared
                    .bindings
                    .get(id)
                    .ok_or_else(|| Failure::new("checkpoint", "Unknown saved operation"))?;
                let Value::Object(values) = Value::from_json(outputs)? else {
                    return Err(Failure::new("checkpoint", "Invalid saved outputs"));
                };
                validate_outputs(&values, &entry.definition, "/checkpoint")?;
                for value in values.values() {
                    scope.validate_value(value)?;
                }
                published.insert(id.clone(), values.as_ref().clone());
            }
        }
        let child = cancellation.child_token();
        let mut started: std::collections::BTreeSet<String> = published.keys().cloned().collect();
        let mut pending: FuturesUnordered<BoxFuture<'_, (String, Result<Named<Value>, Failure>)>> =
            FuturesUnordered::new();
        loop {
            if child.is_cancelled() {
                return Err(Failure::new("cancelled", "Execution cancelled"));
            }
            for (index, step) in prepared.workflow.body.steps().iter().enumerate() {
                let id = step.id();
                if started.contains(id)
                    || !dependencies[id]
                        .iter()
                        .all(|parent| published.contains_key(parent))
                {
                    continue;
                }
                started.insert(id.to_owned());
                let values = published.clone();
                let token = child.clone();
                let inputs = &prepared.inputs;
                let bindings = &prepared.bindings;
                pending.push(Box::pin(async move {
                    let execution = Execution {
                        runner: self,
                        inputs,
                        bindings,
                        scope,
                        cancellation: &token,
                        published: values,
                    };
                    let Step::Operation {
                        id,
                        operation,
                        inputs,
                    } = step
                    else {
                        unreachable!("validated flat graph")
                    };
                    let result = execution
                        .operation(id, operation, inputs, &format!("/body/steps/{index}"))
                        .await
                        .map_err(|error| execution.failed(step, error));
                    (id.clone(), result)
                }));
            }
            if published.len() == dependencies.len() {
                break;
            }
            let Some((id, result)) = pending.next().await else {
                return Err(Failure::new("graph", "Graph cannot make progress"));
            };
            let outputs = match result {
                Ok(value) => value,
                Err(error) => {
                    child.cancel();
                    return Err(error);
                }
            };
            // Opaque sessions are kept in this scope and never persisted as JSON.
            if let Ok(json) = Value::Object(Arc::new(outputs.clone())).to_json() {
                publish(&id, &json)?;
            }
            published.insert(id.clone(), outputs);
            self.emit(Event::Published { invocation: id });
        }
        let mut outputs = Named::new();
        for (name, output) in &prepared.workflow.outputs {
            let value = evaluate(
                &output.value,
                &prepared.inputs,
                &published,
                &pointer("/outputs", name),
            )?;
            validate_value(&value, &output.ty, &pointer("/outputs", name))?;
            outputs.insert(name.clone(), value);
        }
        self.emit(Event::Completed);
        Value::Object(Arc::new(outputs))
            .to_json()
            .map_err(Into::into)
    }

    pub fn validate_graph(
        &self,
        workflow: &Workflow,
        dependencies: &Named<Vec<String>>,
    ) -> Result<(), Failure> {
        use std::collections::BTreeSet;
        let ids: BTreeSet<_> = workflow
            .body
            .steps()
            .iter()
            .map(|step| step.id().to_owned())
            .collect();
        if ids.len() != dependencies.len() || dependencies.keys().any(|id| !ids.contains(id)) {
            return Err(Failure::new(
                "graph",
                "Dependencies must cover every operation",
            ));
        }
        let mut ancestors: Named<BTreeSet<String>> = Named::new();
        for step in workflow.body.steps() {
            let Step::Operation { id, inputs, .. } = step else {
                return Err(Failure::new("graph", "Graph operations must be flat"));
            };
            let mut parents = BTreeSet::new();
            for parent in &dependencies[id] {
                if !parents.insert(parent.clone()) || !ancestors.contains_key(parent) {
                    return Err(Failure::new(
                        "graph",
                        "Dependencies must be distinct earlier operations",
                    ));
                }
            }
            let mut all = parents.clone();
            for parent in parents {
                all.extend(ancestors[&parent].iter().cloned());
            }
            fn refs(value: &Expression, allowed: &BTreeSet<String>) -> bool {
                match value {
                    Expression::Ref(reference) => match reference {
                        Reference::Step { step, .. } => allowed.contains(step),
                        _ => true,
                    },
                    Expression::Object { fields } => {
                        fields.values().all(|value| refs(value, allowed))
                    }
                    Expression::Array { items } => items.iter().all(|value| refs(value, allowed)),
                    Expression::Compare { left, right, .. } => {
                        refs(left, allowed) && refs(right, allowed)
                    }
                    Expression::And { operands } | Expression::Or { operands } => {
                        operands.iter().all(|value| refs(value, allowed))
                    }
                    Expression::Not { operand } => refs(operand, allowed),
                    _ => true,
                }
            }
            if inputs.values().any(|value| !refs(value, &all)) {
                return Err(Failure::new(
                    "graph",
                    "A referenced output needs a dependency path",
                ));
            }
            ancestors.insert(id.clone(), all);
        }
        Ok(())
    }
    pub fn new(catalogs: CatalogRegistry, bindings: BindingRegistry) -> Self {
        Self {
            catalogs,
            bindings,
            observer: None,
        }
    }
    pub fn with_observer(mut self, observer: impl Fn(Event) + Send + Sync + 'static) -> Self {
        self.observer = Some(Arc::new(observer));
        self
    }
    fn emit(&self, event: Event) {
        if let Some(observer) = &self.observer {
            observer(event);
        }
    }

    fn prepare(
        &self,
        workflow: &Workflow,
        supplied: Named<Value>,
        scope: &Scope,
        mode: ExecutionMode,
    ) -> Result<Prepared, Failure> {
        let warnings = validate_workflow(workflow, &self.catalogs)?;
        scope.check()?;
        if mode == ExecutionMode::Json
            && (workflow.outputs.values().any(|v| !v.ty.json_only())
                || workflow.inputs.values().any(|v| !v.ty.json_only()))
        {
            return Err(Failure::new(
                "opaque_boundary",
                "Standalone JSON execution requires JSON-only workflow interface types",
            ));
        }
        // Resolve every binding before beginning any operation effects.
        let bindings = workflow
            .body
            .operations()
            .into_iter()
            .map(|step| {
                Ok((
                    step.id().to_owned(),
                    self.bindings.resolve(
                        self.catalogs
                            .resolve(step.identity().expect("operation"))
                            .expect("validated definition"),
                    )?,
                ))
            })
            .collect::<Result<Named<_>, Failure>>()?;
        for name in supplied.keys() {
            if !workflow.inputs.contains_key(name) {
                return Err(Failure::new(
                    "unknown_input",
                    format!("Unknown workflow input {name:?}"),
                ));
            }
        }
        let mut inputs = supplied
            .into_iter()
            .map(|(name, value)| Ok((name, value.normalized()?)))
            .collect::<Result<Named<Value>, ValidationError>>()?;
        for (name, input) in &workflow.inputs {
            if !inputs.contains_key(name) {
                let value = input.default.as_ref().ok_or_else(|| {
                    Failure::new(
                        "missing_input",
                        format!("Workflow input {name:?} is required"),
                    )
                })?;
                inputs.insert(name.clone(), Value::from_json(value)?);
            }
            validate_value(&inputs[name], &input.ty, &pointer("/inputs", name))?;
            scope.validate_value(&inputs[name])?;
        }
        self.emit(Event::Prepared { warnings });
        Ok(Prepared {
            workflow: workflow.clone(),
            inputs,
            bindings,
        })
    }

    /// Caller retains the scope and is responsible for closing it. Opaque results remain live.
    pub async fn run(
        &self,
        workflow: &Workflow,
        inputs: Named<Value>,
        scope: &Scope,
        cancellation: CancellationToken,
    ) -> Result<Named<Value>, Failure> {
        let prepared = self.prepare(workflow, inputs, scope, ExecutionMode::Embedded)?;
        self.execute(prepared, scope, cancellation).await
    }

    /// Validate a standalone invocation without invoking bindings or owning resources.
    /// The caller owns any resources installed in `scope` and must close it.
    pub fn preflight_json(
        &self,
        workflow: &Workflow,
        inputs: &serde_json::Value,
        scope: &Scope,
    ) -> Result<(), Failure> {
        self.prepare_json(workflow, inputs, scope).map(|_| ())
    }

    fn prepare_json(
        &self,
        workflow: &Workflow,
        inputs: &serde_json::Value,
        scope: &Scope,
    ) -> Result<Prepared, Failure> {
        let Value::Object(inputs) = Value::from_json(inputs)? else {
            return Err(Failure::new("inputs", "Workflow inputs must be an object"));
        };
        self.prepare(
            workflow,
            inputs.as_ref().clone(),
            scope,
            ExecutionMode::Json,
        )
    }

    /// Owns and closes the scope. A detached task ensures cleanup even if the caller drops this future.
    pub async fn run_json(
        &self,
        workflow: &Workflow,
        inputs: serde_json::Value,
        policy: CleanupPolicy,
        cancellation: CancellationToken,
    ) -> Result<serde_json::Value, Failure> {
        self.run_scoped_json(workflow, inputs, Scope::new(policy), cancellation)
            .await
    }

    /// Consume a scope configured with real SDK bindings; close it on preparation
    /// failure, execution failure, success, or caller cancellation.
    pub async fn run_scoped_json(
        &self,
        workflow: &Workflow,
        inputs: serde_json::Value,
        scope: Scope,
        cancellation: CancellationToken,
    ) -> Result<serde_json::Value, Failure> {
        let prepared = self.prepare_json(workflow, &inputs, &scope);
        let runner = self.clone();
        let child = cancellation.child_token();
        struct CancelOnDrop(CancellationToken);
        impl Drop for CancelOnDrop {
            fn drop(&mut self) {
                self.0.cancel();
            }
        }
        let _guard = CancelOnDrop(child.clone());
        let task = tokio::spawn(async move {
            let mut result = match prepared {
                Ok(prepared) => AssertUnwindSafe(runner.execute(prepared, &scope, child))
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| {
                        Err(Failure::new(
                            "runner_panic",
                            "Runner extension panicked; effects may have occurred",
                        ))
                    }),
                Err(error) => Err(error),
            };
            if let Err(cleanup) = scope.close().await {
                match &mut result {
                    Err(primary) => primary.cleanup_errors.push(cleanup),
                    Ok(_) => result = Err(cleanup),
                }
            }
            result.and_then(|v| Value::Object(Arc::new(v)).to_json().map_err(Into::into))
        });
        task.await
            .map_err(|e| Failure::new("runner_task", e.to_string()))?
    }

    async fn execute(
        &self,
        prepared: Prepared,
        scope: &Scope,
        cancellation: CancellationToken,
    ) -> Result<Named<Value>, Failure> {
        let mut execution = Execution {
            runner: self,
            inputs: &prepared.inputs,
            bindings: &prepared.bindings,
            scope,
            cancellation: &cancellation,
            published: Named::new(),
        };
        execution.sequence(&prepared.workflow.body, "/body").await?;
        scope.check()?;
        if cancellation.is_cancelled() {
            return Err(Failure::new("cancelled", "Execution cancelled"));
        }
        let mut outputs = Named::new();
        for (name, output) in &prepared.workflow.outputs {
            let location = pointer("/outputs", name);
            let value = evaluate(
                &output.value,
                &prepared.inputs,
                &execution.published,
                &pointer(&location, "value"),
            )?;
            validate_value(&value, &output.ty, &location)?;
            scope.validate_value(&value)?;
            outputs.insert(name.clone(), value);
        }
        self.emit(Event::Completed);
        Ok(outputs)
    }
}

/// A recursive sequential interpreter. Each branch executes in a lexical value
/// environment; owned resources retain the existing workflow-wide Scope policy.
struct Execution<'a> {
    runner: &'a Runner,
    inputs: &'a Named<Value>,
    bindings: &'a Named<crate::registry::Entry>,
    scope: &'a Scope,
    cancellation: &'a CancellationToken,
    published: Named<Named<Value>>,
}
impl Execution<'_> {
    fn check(&self) -> Result<(), Failure> {
        self.scope.check()?;
        if self.cancellation.is_cancelled() {
            return Err(Failure::new(
                "cancelled",
                "Execution cancelled; effects are not rolled back",
            ));
        }
        Ok(())
    }
    fn failed(&self, step: &Step, mut failure: Failure) -> Failure {
        if failure.invocation_id.is_none() {
            failure.invocation_id = Some(step.id().into());
        }
        if let Some(identity) = step.identity() {
            failure = failure.at(step.id(), identity);
        }
        self.runner.emit(Event::Failed {
            failure: failure.clone(),
        });
        failure
    }
    fn sequence<'a>(
        &'a mut self,
        sequence: &'a Sequence,
        path: &'a str,
    ) -> BoxFuture<'a, Result<(), Failure>> {
        Box::pin(async move {
            for (i, step) in sequence.steps().iter().enumerate() {
                self.check().map_err(|error| self.failed(step, error))?;
                let location = pointer(&pointer(path, "steps"), i);
                match step {
                    Step::Operation {
                        id,
                        operation,
                        inputs,
                    } => {
                        let outputs = self
                            .operation(id, operation, inputs, &location)
                            .await
                            .map_err(|error| self.failed(step, error))?;
                        self.published.insert(id.clone(), outputs);
                        self.runner.emit(Event::Published {
                            invocation: id.clone(),
                        });
                    }
                    Step::Branch {
                        id,
                        condition,
                        then,
                        otherwise,
                    } => {
                        let condition_path = pointer(&location, "condition");
                        // Exactly one evaluation. Pure and/or operands short-circuit.
                        let result =
                            evaluate(condition, self.inputs, &self.published, &condition_path)
                                .and_then(|value| require_boolean(&value, &condition_path))
                                .map_err(|error| self.failed(step, error.into()))?;
                        self.runner.emit(Event::BranchEvaluated {
                            invocation: id.clone(),
                            result,
                            selected: if result {
                                BranchArm::Then
                            } else {
                                BranchArm::Else
                            },
                        });
                        let parent = self.published.clone();
                        let result = if result {
                            self.sequence(then, &pointer(&location, "then")).await
                        } else if let Some(otherwise) = otherwise {
                            self.sequence(otherwise, &pointer(&location, "else")).await
                        } else {
                            Ok(())
                        };
                        self.published = parent;
                        result?; // A child failure has already emitted its original context.
                    }
                }
            }
            Ok(())
        })
    }
    async fn operation(
        &self,
        id: &str,
        operation: &OperationIdentity,
        expressions: &Named<Expression>,
        location: &str,
    ) -> Result<Named<Value>, Failure> {
        let entry = &self.bindings[id];
        let mut inputs = Named::new();
        for (name, expression) in expressions {
            inputs.insert(
                name.clone(),
                evaluate(
                    expression,
                    self.inputs,
                    &self.published,
                    &pointer(&pointer(location, "inputs"), name),
                )?,
            );
        }
        for (name, input) in &entry.definition.inputs {
            if !inputs.contains_key(name)
                && let Some(default) = &input.default
            {
                inputs.insert(name.clone(), Value::from_json(default)?);
            }
            if let Some(value) = inputs.get(name) {
                validate_value(
                    value,
                    &input.ty,
                    &pointer(&pointer(location, "inputs"), name),
                )?;
                self.scope.validate_value(value)?;
            }
        }
        self.runner.emit(Event::Started {
            invocation: id.into(),
            operation: operation.clone(),
        });
        let context = InvocationContext {
            scope: self.scope.clone(),
            cancellation: self.cancellation.clone(),
            invocation_id: id.into(),
            operation: operation.clone(),
        };
        let outputs = tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => return Err(Failure::new("cancelled", "Execution cancelled; effects are not rolled back")),
            failure = self.scope.failed() => return Err(failure),
            outputs = AssertUnwindSafe(entry.binding.invoke(context, inputs)).catch_unwind() =>
                outputs.map_err(|_| Failure::new("binding_panic", "Binding panicked; effects may have occurred"))??,
        };
        self.scope.check()?;
        let outputs = outputs
            .into_iter()
            .map(|(name, value)| Ok((name, value.normalized()?)))
            .collect::<Result<Named<Value>, ValidationError>>()?;
        validate_outputs(&outputs, &entry.definition, &pointer(location, "outputs"))?;
        for value in outputs.values() {
            self.scope.validate_value(value)?;
        }
        Ok(outputs)
    }
}
