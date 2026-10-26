//! Rust operation bindings over the existing Python SDKs using PyO3.
//! SDK imports, credentials, clients and the asyncio loop stay outside portable IR.
mod python;
use aixand_ir::*;
use aixand_ir_runner::*;
use async_trait::async_trait;
use pyo3::{prelude::*, types::PyDict};
use python::{PythonLoop, failure};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Runtime-only options. `connection` is passed to aixand.connect; carrier, if
/// present, is a CarrierConfig keyword object. Credential paths never enter IR.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub python_paths: Vec<String>,
    #[serde(default)]
    pub connection: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub mailbox_credentials: Named<String>,
    #[serde(default)]
    pub agent_credentials: Named<String>,
    #[serde(default)]
    pub receipt_credentials: Named<String>,
    /// Host-installed async entrypoints. Portable inputs select an allowlisted
    /// name and cannot choose a module, executable, or arbitrary Python code.
    #[serde(default)]
    pub applications: Named<String>,
}

impl Config {
    /// Overlay declared agent context without copying unrelated job metadata.
    pub fn with_context(&self, context: &serde_json::Value) -> Result<Self, Failure> {
        let mut config = self.clone();
        let object = context
            .as_object()
            .ok_or_else(|| Failure::new("agent_context", "Agent context must be an object"))?;
        if object
            .keys()
            .any(|key| key != "labels" && key != "metadata")
        {
            return Err(Failure::new(
                "agent_context",
                "Agent context accepts labels and metadata only",
            ));
        }
        for kind in ["labels", "metadata"] {
            let Some(layer) = object.get(kind) else {
                continue;
            };
            let entries: std::collections::BTreeMap<String, String> =
                serde_json::from_value(layer.clone()).map_err(|_| {
                    Failure::new("agent_context", "Agent attributes must be string mappings")
                })?;
            let inherited = config
                .connection
                .entry(kind)
                .or_insert_with(|| serde_json::json!({}));
            let inherited = inherited.as_object_mut().ok_or_else(|| {
                Failure::new(
                    "agent_context",
                    "Connection attributes must be string mappings",
                )
            })?;
            for (key, value) in entries {
                inherited.insert(key, serde_json::Value::String(value));
            }
        }
        Ok(config)
    }
}

fn application<'py>(py: Python<'py>, target: &str) -> PyResult<Bound<'py, PyAny>> {
    let (module, function) = target.split_once(':').ok_or_else(|| {
        pyo3::exceptions::PyValueError::new_err("Application target must be module:function")
    })?;
    let callable = py.import(module)?.getattr(function)?;
    if !py
        .import("inspect")?
        .call_method1("iscoroutinefunction", (&callable,))?
        .extract::<bool>()?
    {
        return Err(pyo3::exceptions::PyTypeError::new_err(
            "Application must be an async function",
        ));
    }
    Ok(callable)
}

struct PythonValue(Py<PyAny>);
struct Runtime {
    loop_: PythonLoop,
    connection: Py<PyAny>,
    config: Config,
    session_observer: Option<AgentSessionObserver>,
}

/// Public terminal identity only. Credentials and opaque handles stay in scope.
#[derive(Clone, Debug, Serialize)]
pub struct AgentSession {
    pub invocation: String,
    pub run_id: String,
    pub session_id: String,
    pub provider: String,
}
pub type AgentSessionObserver = Arc<dyn Fn(AgentSession) + Send + Sync>;

/// Host-only telemetry for associating a successful spawn with its terminal.
pub fn install_with_session_observer(
    scope: &Scope,
    registry: &mut BindingRegistry,
    config: Config,
    observer: AgentSessionObserver,
) -> Result<(), Failure> {
    install_catalog_observed(scope, registry, config, &builtin_catalog()?, Some(observer))
}

/// Install into a caller-owned scope before running a workflow. Construction
/// imports SDKs but performs no launch, network call or credential provisioning.
pub fn install(
    scope: &Scope,
    registry: &mut BindingRegistry,
    config: Config,
) -> Result<(), Failure> {
    install_catalog(scope, registry, config, &builtin_catalog()?)
}

/// Install only the selected portable contracts. Every definition must match
/// the adapter's immutable contract exactly; selection never loads code by ID.
/// Rejection happens before Python imports or runtime resource construction.
pub fn install_catalog(
    scope: &Scope,
    registry: &mut BindingRegistry,
    config: Config,
    catalog: &CatalogRegistry,
) -> Result<(), Failure> {
    install_catalog_observed(scope, registry, config, catalog, None)
}

fn install_catalog_observed(
    scope: &Scope,
    registry: &mut BindingRegistry,
    config: Config,
    catalog: &CatalogRegistry,
    observer: Option<AgentSessionObserver>,
) -> Result<(), Failure> {
    check_catalog(catalog)?;
    let connection = Python::attach(|py| -> PyResult<_> {
        for path in &config.python_paths {
            py.import("site")?.call_method1("addsitedir", (path,))?;
        }
        let sdk = py.import("aixand")?;
        for target in config.applications.values() {
            application(py, target)?;
        }
        let kwargs = json_object(py, &serde_json::Value::Object(config.connection.clone()))?;
        if let Some(carrier) = kwargs.get_item("carrier")? {
            let carrier = carrier.cast::<PyDict>()?;
            kwargs.set_item(
                "carrier",
                sdk.getattr("CarrierConfig")?.call((), Some(carrier))?,
            )?;
        }
        Ok(sdk.getattr("connect")?.call((), Some(&kwargs))?.unbind())
    })
    .map_err(failure)?;
    install_connection_catalog_observed(scope, registry, connection, config, catalog, observer)
}

fn builtin_catalog() -> Result<CatalogRegistry, Failure> {
    Ok(CatalogRegistry::new([parse_catalog(AIXAND_CATALOG)?])?)
}

fn check_catalog(catalog: &CatalogRegistry) -> Result<(), Failure> {
    let supported = builtin_catalog()?;
    for definition in catalog.definitions() {
        let identity = definition.identity();
        let known = supported.resolve(&identity).ok_or_else(|| {
            Failure::new(
                "missing_binding",
                format!("No SDK binding for {}@{}", identity.id, identity.version),
            )
        })?;
        if known != definition {
            return Err(Failure::new(
                "incompatible_binding",
                format!(
                    "SDK binding contract differs for {}@{}",
                    identity.id, identity.version
                ),
            ));
        }
    }
    Ok(())
}

/// Integration hook for an existing, not-yet-used SDK connection. This adapter
/// owns its loop and closes the connection using the IR scope cleanup policy.
pub fn install_connection(
    scope: &Scope,
    registry: &mut BindingRegistry,
    connection: Py<PyAny>,
    config: Config,
) -> Result<(), Failure> {
    install_connection_catalog(scope, registry, connection, config, &builtin_catalog()?)
}

/// Selected-contract variant for an existing SDK connection. The scope owns
/// connection cleanup, including cleanup after failed binding registration.
pub fn install_connection_catalog(
    scope: &Scope,
    registry: &mut BindingRegistry,
    connection: Py<PyAny>,
    config: Config,
    catalog: &CatalogRegistry,
) -> Result<(), Failure> {
    install_connection_catalog_observed(scope, registry, connection, config, catalog, None)
}

/// Existing-connection variant of the host-only terminal observer.
pub fn install_connection_with_session_observer(
    scope: &Scope,
    registry: &mut BindingRegistry,
    connection: Py<PyAny>,
    config: Config,
    observer: AgentSessionObserver,
) -> Result<(), Failure> {
    install_connection_catalog_observed(
        scope,
        registry,
        connection,
        config,
        &builtin_catalog()?,
        Some(observer),
    )
}

fn install_connection_catalog_observed(
    scope: &Scope,
    registry: &mut BindingRegistry,
    connection: Py<PyAny>,
    config: Config,
    catalog: &CatalogRegistry,
    observer: Option<AgentSessionObserver>,
) -> Result<(), Failure> {
    check_catalog(catalog)?;
    let runtime = Arc::new(Runtime {
        loop_: PythonLoop::start()?,
        connection,
        config,
        session_observer: observer,
    });
    scope.register_cleanup(runtime.clone())?;
    let marker = scope.insert("aixand.binding_scope", "1", runtime.clone())?;
    let mut staged = registry.clone();
    for definition in catalog.definitions() {
        staged.register(
            definition.clone(),
            Arc::new(SdkBinding {
                marker: marker.clone(),
            }),
        )?;
    }
    *registry = staged;
    Ok(())
}

#[async_trait]
impl Cleanup for Runtime {
    async fn close(&self, policy: CleanupPolicy) -> Result<(), Failure> {
        let args = Python::attach(|py| -> PyResult<_> {
            let kwargs = PyDict::new(py);
            kwargs.set_item("stop_agents", policy == CleanupPolicy::StopOwned)?;
            Ok((
                self.connection.bind(py).getattr("close")?.unbind(),
                kwargs.unbind(),
            ))
        })
        .map_err(failure);
        let mut result = match args {
            Ok((call, kwargs)) => self.loop_.call(call, kwargs, None).await.map(|_| ()),
            Err(error) => Err(error),
        };
        if let Err(error) = self.loop_.stop().await {
            match &mut result {
                Err(primary) => primary.cleanup_errors.push(error),
                Ok(_) => result = Err(error),
            }
        }
        result
    }
}

fn json_object<'py>(py: Python<'py>, value: &serde_json::Value) -> PyResult<Bound<'py, PyDict>> {
    py.import("json")?
        .call_method1("loads", (value.to_string(),))?
        .cast_into::<PyDict>()
        .map_err(Into::into)
}

fn to_python(py: Python<'_>, scope: &Scope, value: &Value) -> Result<Py<PyAny>, Failure> {
    if let Value::Opaque(atom) = value {
        return Ok(scope.get::<PythonValue>(atom)?.0.clone_ref(py));
    }
    // Catalog operations accept atoms only as whole ports or returned arrays;
    // ordinary arguments remain explicitly validated JSON.
    let json = value.to_json()?;
    py.import("json")
        .and_then(|m| m.call_method1("loads", (json.to_string(),)))
        .map(Bound::unbind)
        .map_err(failure)
}

fn selected(object: &Bound<'_, PyAny>, names: &[(&str, &str)]) -> Result<Value, Failure> {
    let py = object.py();
    let fields = PyDict::new(py);
    for (output, attribute) in names {
        fields
            .set_item(*output, object.getattr(*attribute).map_err(failure)?)
            .map_err(failure)?;
    }
    let text: String = py
        .import("json")
        .and_then(|m| m.call_method1("dumps", (fields,)))
        .and_then(|v| v.extract())
        .map_err(failure)?;
    Ok(Value::from_json(&parse_json(&text)?)?)
}

fn snapshot(object: &Bound<'_, PyAny>) -> Result<Value, Failure> {
    selected(
        object,
        &[
            ("id", "id"),
            ("sender", "sender"),
            ("recipient", "recipient"),
            ("content", "content"),
            ("created_at", "created_at"),
            ("idempotency_key", "idempotency_key"),
            ("reply_to", "reply_to"),
            ("acknowledged_at", "acknowledged_at"),
        ],
    )
}

fn observation(object: &Bound<'_, PyAny>) -> Result<Value, Failure> {
    selected(
        object,
        &[
            ("session_id", "id"),
            ("name", "name"),
            ("revision", "revision"),
            ("lifecycle", "lifecycle"),
            ("execution", "execution"),
            ("interaction", "interaction"),
            ("constraint", "constraint"),
            ("health", "health"),
        ],
    )
}

fn atom(scope: &Scope, id: &str, value: Py<PyAny>) -> Result<Value, Failure> {
    Ok(Value::Opaque(scope.insert(
        id,
        "1",
        Arc::new(PythonValue(value)),
    )?))
}

fn message_outputs(scope: &Scope, value: Py<PyAny>) -> Result<Named<Value>, Failure> {
    let snapshot = Python::attach(|py| snapshot(value.bind(py)))?;
    Ok(Named::from([
        ("snapshot".into(), snapshot),
        ("message".into(), atom(scope, "carrier.message", value)?),
    ]))
}

struct SdkBinding {
    marker: Opaque,
}
#[async_trait]
impl Binding for SdkBinding {
    async fn invoke(
        &self,
        context: InvocationContext,
        inputs: Named<Value>,
    ) -> Result<Named<Value>, Failure> {
        let runtime = context.scope.get::<Runtime>(&self.marker)?;
        let id = context.operation.id.as_str();
        let invocation_connection = Python::attach(|py| -> Result<Py<PyAny>, Failure> {
            if matches!(id, "aixand.agents.spawn" | "aixand.application.run") {
                let kwargs = PyDict::new(py);
                let labels = PyDict::new(py);
                labels
                    .set_item("workflow.step_id", &context.invocation_id)
                    .map_err(failure)?;
                kwargs.set_item("labels", labels).map_err(failure)?;
                Ok(runtime
                    .connection
                    .bind(py)
                    .call_method("with_context", (), Some(&kwargs))
                    .map_err(failure)?
                    .unbind())
            } else {
                Ok(runtime.connection.clone_ref(py))
            }
        })?;
        if matches!(
            id,
            "carrier.message.inspect" | "carrier.message.decode_json"
        ) {
            return Python::attach(|py| {
                let message = to_python(py, &context.scope, &inputs["message"])?;
                if id.ends_with("inspect") {
                    return Ok(Named::from([(
                        "snapshot".into(),
                        snapshot(message.bind(py))?,
                    )]));
                }
                let content: String = message
                    .bind(py)
                    .getattr("content")
                    .and_then(|v| v.extract())
                    .map_err(failure)?;
                Ok(Named::from([(
                    "data".into(),
                    Value::from_json(&parse_json(&content)?)?,
                )]))
            });
        }
        let (callable, kwargs) = Python::attach(|py| -> Result<_, Failure> {
            let mut fields = inputs.clone();
            if id == "aixand.application.run" {
                let name = inputs["name"]
                    .as_str()
                    .ok_or_else(|| Failure::new("input", "Missing application name"))?;
                let target = runtime.config.applications.get(name).ok_or_else(|| {
                    Failure::new(
                        "application_not_installed",
                        format!("Host has not installed application {name:?}"),
                    )
                })?;
                let kwargs = PyDict::new(py);
                kwargs
                    .set_item("connection", invocation_connection.bind(py))
                    .map_err(failure)?;
                kwargs
                    .set_item(
                        "arguments",
                        to_python(py, &context.scope, &inputs["arguments"])?,
                    )
                    .map_err(failure)?;
                return Ok((
                    application(py, target).map_err(failure)?.unbind(),
                    kwargs.unbind(),
                ));
            }
            // Receiver dispatch is binding metadata, never inferred from workflow strings.
            let (receiver, method) = match id {
                "aixand.agents.spawn" => (None, "spawn"),
                "aixand.agents.get" => (None, "get"),
                "aixand.messaging.mailbox" => (None, "mailbox"),
                "aixand.agent.send" => (Some("agent"), "send"),
                "aixand.agent.wait" => (Some("agent"), "wait"),
                "aixand.agent.stop" => (Some("agent"), "stop"),
                "aixand.agent.inspect" => (Some("agent"), "inspect"),
                "aixand.agent.read_screen" => (Some("agent"), "read_screen"),
                "carrier.message.send" => (Some("mailbox"), "send"),
                "carrier.message.wait_for_reply" => (Some("mailbox"), "wait_for_reply"),
                "carrier.mailbox.wait" => (Some("mailbox"), "wait"),
                "carrier.message.reply" => (Some("message"), "reply"),
                "carrier.message.ack" => (Some("message"), "ack"),
                _ => return Err(Failure::new("binding", "Unsupported binding operation")),
            };
            let callable = if let Some(receiver) = receiver {
                let value = fields
                    .remove(receiver)
                    .ok_or_else(|| Failure::new("input", "Missing capability"))?;
                to_python(py, &context.scope, &value)?
                    .bind(py)
                    .getattr(method)
                    .map_err(failure)?
                    .unbind()
            } else {
                let sdk = py.import("aixand").map_err(failure)?;
                let namespace = if method == "mailbox" {
                    "messaging"
                } else {
                    "agents"
                };
                sdk.getattr(namespace)
                    .and_then(|v| v.getattr(method))
                    .map_err(failure)?
                    .unbind()
            };
            fields.remove("sender"); // Explicit postcondition on correlated reply.
            let kwargs = PyDict::new(py);
            for (key, value) in &fields {
                kwargs
                    .set_item(key, to_python(py, &context.scope, value)?)
                    .map_err(failure)?;
            }
            if receiver.is_none() {
                kwargs
                    .set_item("connection", invocation_connection.bind(py))
                    .map_err(failure)?;
            }
            if let Some(address) = fields.get("address").and_then(Value::as_str) {
                let credentials = if method == "mailbox" {
                    &runtime.config.mailbox_credentials
                } else {
                    &runtime.config.agent_credentials
                };
                if let Some(path) = credentials.get(address) {
                    kwargs.set_item("credentials", path).map_err(failure)?;
                }
                if method == "spawn"
                    && let Some(path) = runtime.config.receipt_credentials.get(address)
                {
                    kwargs
                        .set_item("receipt_credentials", path)
                        .map_err(failure)?;
                }
            }
            Ok((callable, kwargs.unbind()))
        })?;
        // Wrapping every SDK await observes managed consumer failures even during
        // a Carrier reply wait. The SDK cancels and joins the underlying awaitable.
        let connection = Python::attach(|py| invocation_connection.clone_ref(py));
        let result = runtime
            .loop_
            .call(callable, kwargs, Some(connection))
            .await?;
        if matches!(id, "aixand.agents.spawn" | "aixand.agents.get")
            && let Some(observer) = &runtime.session_observer
        {
            let session = Python::attach(|py| -> PyResult<AgentSession> {
                let agent = result.bind(py);
                Ok(AgentSession {
                    invocation: context.invocation_id.clone(),
                    run_id: agent.getattr("run_id")?.extract()?,
                    session_id: agent.getattr("session_id")?.extract()?,
                    provider: agent.getattr("provider")?.extract()?,
                })
            });
            // Optional telemetry must never turn a successful launch into a failure.
            if let Ok(session) = session {
                observer(session);
            }
        }
        match id {
            "aixand.application.run" => Python::attach(|py| {
                let kwargs = PyDict::new(py);
                kwargs.set_item("allow_nan", false).map_err(failure)?;
                let text: String = py
                    .import("json")
                    .and_then(|json| json.getattr("dumps"))
                    .and_then(|dumps| dumps.call((result.bind(py),), Some(&kwargs)))
                    .and_then(|value| value.extract())
                    .map_err(failure)?;
                Ok(Named::from([(
                    "result".into(),
                    Value::from_json(&parse_json(&text)?)?,
                )]))
            }),
            "aixand.agents.spawn" | "aixand.agents.get" => Python::attach(|py| {
                let data = selected(
                    result.bind(py),
                    &[("run_id", "run_id"), ("address", "address")],
                )?;
                let mut outputs = data.as_object().expect("selected object").clone();
                outputs.insert(
                    "agent".into(),
                    atom(&context.scope, "aixand.agent", result)?,
                );
                Ok(outputs)
            }),
            "aixand.agent.send" => Ok(Named::from([(
                "receipt".into(),
                atom(&context.scope, "aixand.input_receipt", result)?,
            )])),
            "aixand.agent.wait" | "aixand.agent.inspect" => Python::attach(|py| {
                Ok(Named::from([(
                    "observation".into(),
                    observation(result.bind(py))?,
                )]))
            }),
            "aixand.agent.stop" => Ok(Named::new()),
            "aixand.agent.read_screen" => Python::attach(|py| {
                let text: String = result
                    .bind(py)
                    .call_method1("decode", ("utf-8", "replace"))
                    .and_then(|v| v.extract())
                    .map_err(failure)?;
                Ok(Named::from([("text".into(), Value::String(text.into()))]))
            }),
            "aixand.messaging.mailbox" => Python::attach(|py| {
                let address: String = result
                    .bind(py)
                    .getattr("address")
                    .and_then(|v| v.extract())
                    .map_err(failure)?;
                Ok(Named::from([
                    ("address".into(), Value::String(address.into())),
                    (
                        "mailbox".into(),
                        atom(&context.scope, "carrier.mailbox", result)?,
                    ),
                ]))
            }),
            "carrier.message.send" | "carrier.message.reply" => {
                message_outputs(&context.scope, result)
            }
            "carrier.message.wait_for_reply" => {
                if let Some(sender) = inputs.get("sender").and_then(Value::as_str) {
                    let actual = Python::attach(|py| {
                        result
                            .bind(py)
                            .getattr("sender")
                            .and_then(|v| v.extract::<String>())
                    })
                    .map_err(failure)?;
                    if actual != sender {
                        return Err(Failure::new(
                            "reply_sender",
                            format!(
                                "Expected reply from {sender:?}, received {actual:?}; reply remains unacknowledged"
                            ),
                        ));
                    }
                }
                message_outputs(&context.scope, result)
            }
            "carrier.message.ack" => Python::attach(|py| {
                let message = to_python(py, &context.scope, &inputs["message"])?;
                let acknowledgment = selected(
                    message.bind(py),
                    &[("message_id", "id"), ("acknowledged_at", "acknowledged_at")],
                )?;
                Ok(Named::from([("acknowledgment".into(), acknowledgment)]))
            }),
            "carrier.mailbox.wait" => Python::attach(|py| {
                let result = result.bind(py);
                let base = selected(
                    result,
                    &[("status", "status"), ("next_after", "next_after")],
                )?;
                let mut outputs = base.as_object().expect("selected object").clone();
                let mut messages = vec![];
                let mut snapshots = vec![];
                for message in result
                    .getattr("messages")
                    .and_then(|v| v.try_iter())
                    .map_err(failure)?
                {
                    let message = message.map_err(failure)?;
                    snapshots.push(snapshot(&message)?);
                    messages.push(atom(&context.scope, "carrier.message", message.unbind())?);
                }
                outputs.insert("messages".into(), Value::Array(messages.into()));
                outputs.insert("snapshots".into(), Value::Array(snapshots.into()));
                Ok(outputs)
            }),
            _ => Err(Failure::new("binding", "Operation produced no mapping")),
        }
    }
}
