//! Deterministic Rust bindings execute the same document used by the live host.
use aixand_ir::*;
use aixand_ir_aixand::{Config, install_catalog};
use aixand_ir_runner::*;
use async_trait::async_trait;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

const WORKFLOW: &str = include_str!("../../../examples/real-agent/workflow.json");
const CATALOG: &str = include_str!("../../../examples/real-agent/catalog.json");
const ORDER: [&str; 6] = [
    "spawn",
    "send_task",
    "wait_task",
    "send_summary",
    "wait_summary",
    "stop",
];

fn catalog() -> CatalogRegistry {
    CatalogRegistry::new([parse_catalog(CATALOG).unwrap()]).unwrap()
}

#[derive(Default)]
struct State {
    events: Vec<String>,
    agent: Option<Opaque>,
    receipts: Vec<Opaque>,
    texts: Vec<String>,
    running: bool,
    explicit_stops: usize,
    cleanup_stops: usize,
}
struct FakeAgent;
struct Receipt(Arc<FakeAgent>, usize);
struct Fake {
    state: Mutex<State>,
    native_agent: Arc<FakeAgent>,
    fail_at: Option<&'static str>,
    fail_cleanup: bool,
}
impl Fake {
    fn new(fail_at: Option<&'static str>, fail_cleanup: bool) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            native_agent: Arc::new(FakeAgent),
            fail_at,
            fail_cleanup,
        })
    }
}
fn opaque(value: &Value) -> &Opaque {
    let Value::Opaque(atom) = value else {
        panic!("expected opaque value")
    };
    atom
}

#[async_trait]
impl Binding for Fake {
    async fn invoke(
        &self,
        ctx: InvocationContext,
        inputs: Named<Value>,
    ) -> Result<Named<Value>, Failure> {
        self.state
            .lock()
            .unwrap()
            .events
            .push(format!("start:{}", ctx.invocation_id));
        tokio::task::yield_now().await;
        let mut state = self.state.lock().unwrap();
        if ctx.operation.id == "aixand.agents.spawn" {
            assert_eq!(inputs["provider"].as_str(), Some("codex"));
            assert_eq!(inputs["profile"].as_str(), Some("backup"));
            state.running = true; // The external effect can precede publication/failure.
            state.agent = Some(
                ctx.scope
                    .insert("aixand.agent", "1", self.native_agent.clone())?,
            );
        } else {
            let agent = opaque(&inputs["agent"]);
            assert!(state.agent.as_ref().unwrap().same_identity(agent));
            assert!(Arc::ptr_eq(
                &ctx.scope.get::<FakeAgent>(agent)?,
                &self.native_agent
            ));
        }
        if self.fail_at == Some(ctx.invocation_id.as_str()) {
            return Err(
                Failure::new("fake_failure", "operation failed after possible effects")
                    .with_details(json!({"effect_certainty":"unknown"})),
            );
        }
        let outputs = match ctx.operation.id.as_str() {
            "aixand.agents.spawn" => Named::from([
                (
                    "agent".into(),
                    Value::Opaque(state.agent.as_ref().unwrap().clone()),
                ),
                ("run_id".into(), Value::String("fake-run".into())),
                ("address".into(), Value::Null),
            ]),
            "aixand.agent.send" => {
                assert!(state.running);
                state
                    .texts
                    .push(inputs["text"].as_str().unwrap().to_owned());
                let receipt = ctx.scope.insert(
                    "aixand.input_receipt",
                    "1",
                    Arc::new(Receipt(self.native_agent.clone(), state.texts.len())),
                )?;
                state.receipts.push(receipt.clone());
                Named::from([("receipt".into(), Value::Opaque(receipt))])
            }
            "aixand.agent.wait" => {
                let turn = if ctx.invocation_id == "wait_task" {
                    1
                } else {
                    2
                };
                let after = opaque(&inputs["after"]);
                assert!(state.receipts[turn - 1].same_identity(after));
                let receipt = ctx.scope.get::<Receipt>(after)?;
                assert!(Arc::ptr_eq(&receipt.0, &self.native_agent));
                assert_eq!(receipt.1, turn);
                Named::from([(
                    "observation".into(),
                    Value::from_json(&json!({
                        "session_id":"fake-session", "name":"fake", "revision":turn + 1,
                        "lifecycle":"running", "execution":"running", "interaction":"available",
                        "constraint":"clear", "health":"healthy"
                    }))?,
                )])
            }
            "aixand.agent.stop" => {
                assert_eq!(inputs["force"], Value::Boolean(false));
                state.running = false;
                state.explicit_stops += 1;
                Named::new()
            }
            _ => panic!("unexpected operation"),
        };
        state.events.push(format!("end:{}", ctx.invocation_id));
        Ok(outputs)
    }
}
#[async_trait]
impl Cleanup for Fake {
    async fn close(&self, policy: CleanupPolicy) -> Result<(), Failure> {
        let mut state = self.state.lock().unwrap();
        state.events.push("cleanup".into());
        if policy == CleanupPolicy::StopOwned && state.running {
            state.cleanup_stops += 1;
            state.running = false;
        }
        if self.fail_cleanup {
            Err(Failure::new("cleanup_failed", "cleanup diagnostic"))
        } else {
            Ok(())
        }
    }
}
fn setup(fake: &Arc<Fake>, missing: Option<&str>) -> (Runner, Scope) {
    let catalog = catalog();
    let scope = Scope::new(CleanupPolicy::StopOwned);
    scope.register_cleanup(fake.clone()).unwrap();
    let mut bindings = BindingRegistry::default();
    for definition in catalog.definitions() {
        if Some(definition.id.as_str()) != missing {
            bindings.register(definition.clone(), fake.clone()).unwrap();
        }
    }
    (Runner::new(catalog, bindings), scope)
}

#[test]
fn four_contracts_match_existing_definitions_and_validate_hand_authored_ir() {
    let selected = catalog();
    let existing = CatalogRegistry::new([parse_catalog(AIXAND_CATALOG).unwrap()]).unwrap();
    assert_eq!(selected.definitions().count(), 4);
    for definition in selected.definitions() {
        assert_eq!(
            existing.resolve(&definition.identity()).unwrap(),
            definition
        );
    }
    let workflow = parse_workflow(WORKFLOW).unwrap();
    assert!(validate_workflow(&workflow, &selected).unwrap().is_empty());
    assert_eq!(
        workflow
            .body
            .steps()
            .iter()
            .map(Operation::id)
            .collect::<Vec<_>>(),
        ORDER
    );
}

#[tokio::test]
async fn opaque_agent_receipts_sequence_and_explicit_stop() {
    let fake = Fake::new(None, false);
    let (runner, scope) = setup(&fake, None);
    let result = runner
        .run_scoped_json(
            &parse_workflow(WORKFLOW).unwrap(),
            json!({"task":"chosen task"}),
            scope.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["run_id"], "fake-run");
    assert_eq!(result["task_observation"]["revision"], 2);
    assert_eq!(result["summary_observation"]["revision"], 3);
    let state = fake.state.lock().unwrap();
    assert_eq!(state.texts, ["chosen task", "Summarize your findings."]);
    let mut events = Vec::new();
    for step in ORDER {
        events.extend([format!("start:{step}"), format!("end:{step}")]);
    }
    events.push("cleanup".into());
    assert_eq!(state.events, events);
    assert_eq!((state.explicit_stops, state.cleanup_stops), (1, 0));
    assert!(!state.running);
    assert!(scope.is_closed());
}

#[tokio::test]
async fn missing_last_binding_fails_preparation_before_spawn() {
    let fake = Fake::new(None, false);
    let (runner, scope) = setup(&fake, Some("aixand.agent.stop"));
    let error = runner
        .run_scoped_json(
            &parse_workflow(WORKFLOW).unwrap(),
            json!({"task":"task"}),
            scope,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "missing_binding");
    assert_eq!(fake.state.lock().unwrap().events, ["cleanup"]);
}

#[tokio::test]
async fn failure_at_every_step_stops_sequence_and_cleans_partial_effects() {
    for (index, step) in ORDER.iter().enumerate() {
        let fake = Fake::new(Some(step), false);
        let (runner, scope) = setup(&fake, None);
        let error = runner
            .run_scoped_json(
                &parse_workflow(WORKFLOW).unwrap(),
                json!({"task":"task"}),
                scope.clone(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "fake_failure");
        assert_eq!(error.invocation_id.as_deref(), Some(*step));
        assert!(error.operation.is_some());
        assert_eq!(error.details.unwrap()["effect_certainty"], "unknown");
        let state = fake.state.lock().unwrap();
        assert_eq!(
            state
                .events
                .iter()
                .filter(|event| event.starts_with("start:"))
                .count(),
            index + 1
        );
        assert!(!state.events.contains(&format!("end:{step}")));
        assert_eq!((state.explicit_stops, state.cleanup_stops), (0, 1));
        assert!(!state.running);
        assert!(scope.is_closed());
    }
}

#[tokio::test]
async fn cleanup_failure_preserves_primary_operation_failure() {
    let fake = Fake::new(Some("send_summary"), true);
    let (runner, scope) = setup(&fake, None);
    let error = runner
        .run_scoped_json(
            &parse_workflow(WORKFLOW).unwrap(),
            json!({"task":"task"}),
            scope,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "fake_failure");
    assert_eq!(error.invocation_id.as_deref(), Some("send_summary"));
    assert_eq!(error.cleanup_errors.len(), 1);
}

#[tokio::test]
async fn sdk_catalog_resolution_rejects_unknown_versions_and_changed_contracts() {
    for (change_version, expected) in [(true, "missing_binding"), (false, "incompatible_binding")] {
        let mut selected = parse_catalog(CATALOG).unwrap();
        if change_version {
            selected.operations[0].version = "future".into();
        } else {
            selected.operations[0].outputs.remove("address");
        }
        let selected = CatalogRegistry::new([selected]).unwrap();
        let scope = Scope::default();
        let error = install_catalog(
            &scope,
            &mut BindingRegistry::default(),
            Config::default(),
            &selected,
        )
        .unwrap_err();
        assert_eq!(error.code, expected);
        scope.close().await.unwrap();
    }
}
