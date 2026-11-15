use aixand_ir::{AIXAND_CATALOG, CatalogRegistry, Named, Value, parse_catalog};
use aixand_ir_runner::{
    Binding, BindingRegistry, Cleanup, CleanupPolicy, Failure, InvocationContext,
};
use async_trait::async_trait;
use job_runner::{
    Submission,
    engine::{Engine, ExecutionJournal, IrEngine},
    graph,
};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Barrier;
use tokio_util::sync::CancellationToken;

struct NoEffects;
#[async_trait]
impl Binding for NoEffects {
    async fn invoke(&self, _: InvocationContext, _: Named<Value>) -> Result<Named<Value>, Failure> {
        panic!("compiler contract preflight must never invoke an effect")
    }
}

#[test]
#[ignore = "Generate current canvas programs with aixand-web npm run test:workflows:contract"]
fn compiled_canvas_programs_pass_authoritative_preflight() {
    let directory = std::env::var("RUNNER_CANVAS_FIXTURES").expect("compiler fixture directory");
    let catalogs = CatalogRegistry::new([
        parse_catalog(AIXAND_CATALOG).unwrap(),
        parse_catalog(aixand_ir::VERIFIER_CATALOG).unwrap(),
        graph::catalog().unwrap(),
    ])
    .unwrap();
    let mut bindings = BindingRegistry::default();
    for definition in catalogs.definitions() {
        bindings
            .register(definition.clone(), Arc::new(NoEffects))
            .unwrap();
    }
    let runner = aixand_ir_runner::Runner::new(catalogs, bindings);
    let mut checked = 0;
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        let value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let graph = graph::Graph::parse(&value).unwrap();
        if value["context"]["resourceCapture"] == "workflow" {
            let mut mutable = value.clone();
            mutable["context"]["profileRequirements"] = serde_json::Value::Null;
            assert!(graph::Graph::parse(&mutable).is_err());
        }
        runner
            .preflight_json(
                &graph.workflow,
                &json!({}),
                &aixand_ir_runner::Scope::default(),
            )
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        runner
            .validate_graph(&graph.workflow, &graph.dependencies)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        checked += 1;
    }
    assert_eq!(checked, 6);
}

fn submission(
    steps: serde_json::Value,
    dependencies: serde_json::Value,
    result: serde_json::Value,
) -> Submission {
    serde_json::from_value(json!({"key":"graph-test","workflow":{"format":"aixand.workflow-graph","version":1,"context":{},
        "workflow":{"ir_version":"0.1","name":"Graph","inputs":{},"body":{"kind":"sequence","steps":steps},
            "outputs":{"result":{"type":{"kind":"json"},"value":result}}},"dependencies":dependencies},"inputs":{},"metadata":{}})).unwrap()
}
fn operation(id: &str, name: &str, inputs: serde_json::Value) -> serde_json::Value {
    json!({"kind":"operation","id":id,"operation":{"id":name,"version":"1.0.0"},"inputs":inputs})
}
fn literal(value: serde_json::Value) -> serde_json::Value {
    json!({"kind":"literal","value":value})
}
fn reference(id: &str, name: &str) -> serde_json::Value {
    json!({"kind":"ref","source":"step","step":id,"output":name})
}
fn journal() -> ExecutionJournal {
    ExecutionJournal {
        job_id: "JOB-test".into(),
        checkpoint: json!({}),
        persist: Arc::new(|_| Ok(())),
        cancel_requested: Arc::new(|| false),
        control: None,
    }
}
struct Rendezvous {
    barrier: Arc<Barrier>,
    arrivals: Arc<Mutex<Vec<String>>>,
}
#[async_trait]
impl Binding for Rendezvous {
    async fn invoke(
        &self,
        context: InvocationContext,
        inputs: Named<Value>,
    ) -> Result<Named<Value>, Failure> {
        self.arrivals.lock().unwrap().push(context.invocation_id);
        self.barrier.wait().await;
        Ok(inputs)
    }
}
#[tokio::test]
async fn siblings_overlap_and_the_join_waits_for_both_outputs() {
    let extra = parse_catalog(&json!({"contract_version":"0.1","package":{"id":"test","version":"1.0.0"},"operations":[
        {"id":"test.rendezvous","version":"1.0.0","inputs":{"value":{"type":{"kind":"json"},"required":true}},"outputs":{"value":{"type":{"kind":"json"}}}}
    ]}).to_string()).unwrap();
    let catalogs = CatalogRegistry::new([graph::catalog().unwrap(), extra]).unwrap();
    let mut bindings = BindingRegistry::default();
    let arrivals = Arc::new(Mutex::new(Vec::new()));
    let definition = catalogs
        .definitions()
        .find(|definition| definition.id == "test.rendezvous")
        .unwrap()
        .clone();
    bindings
        .register(
            definition,
            Arc::new(Rendezvous {
                barrier: Arc::new(Barrier::new(2)),
                arrivals: arrivals.clone(),
            }),
        )
        .unwrap();
    let engine = IrEngine::with_bindings(catalogs, bindings, "graph-test").unwrap();
    let plan = submission(
        json!([
            operation(
                "left",
                "test.rendezvous",
                json!({"value":literal(json!("left report"))})
            ),
            operation(
                "right",
                "test.rendezvous",
                json!({"value":literal(json!("right report"))})
            ),
            operation(
                "join",
                "workflow.value",
                json!({"value":{"kind":"object","fields":{"left":reference("left","value"),"right":reference("right","value")}}})
            )
        ]),
        json!({"left":[],"right":[],"join":["left","right"]}),
        reference("join", "value"),
    );
    engine.preflight(&plan).await.unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        engine.execute_journaled(plan, Arc::new(|_| {}), CancellationToken::new(), journal()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        result["result"],
        json!({"left":"left report","right":"right report"})
    );
    assert_eq!(arrivals.lock().unwrap().len(), 2);
}

struct SessionBindings {
    closed: Arc<AtomicBool>,
}
struct CloseSession(Arc<AtomicBool>);
#[async_trait]
impl Cleanup for CloseSession {
    async fn close(&self, _policy: CleanupPolicy) -> Result<(), Failure> {
        self.0.store(true, Ordering::SeqCst);
        Ok(())
    }
}
#[async_trait]
impl Binding for SessionBindings {
    async fn invoke(
        &self,
        context: InvocationContext,
        inputs: Named<Value>,
    ) -> Result<Named<Value>, Failure> {
        assert!(!self.closed.load(Ordering::SeqCst));
        match context.operation.id.as_str() {
            "aixand.agents.spawn" => {
                context
                    .scope
                    .register_cleanup(Arc::new(CloseSession(self.closed.clone())))?;
                Ok(Named::from([
                    (
                        "agent".into(),
                        Value::Opaque(context.scope.insert(
                            "aixand.agent",
                            "1",
                            Arc::new("owned-session".to_owned()),
                        )?),
                    ),
                    ("run_id".into(), Value::from_json(&json!("run"))?),
                    ("address".into(), Value::Null),
                ]))
            }
            "aixand.agent.send" => {
                let Value::Opaque(atom) = &inputs["agent"] else {
                    panic!("agent")
                };
                assert_eq!(context.scope.get::<String>(atom)?.as_str(), "owned-session");
                Ok(Named::from([(
                    "receipt".into(),
                    Value::Opaque(context.scope.insert(
                        "aixand.input_receipt",
                        "1",
                        Arc::new("receipt".to_owned()),
                    )?),
                )]))
            }
            "aixand.agent.wait" => {
                let Value::Opaque(atom) = &inputs["agent"] else {
                    panic!("agent")
                };
                let Value::Opaque(receipt) = &inputs["after"] else {
                    panic!("receipt")
                };
                assert_eq!(context.scope.get::<String>(atom)?.as_str(), "owned-session");
                assert_eq!(context.scope.get::<String>(receipt)?.as_str(), "receipt");
                Ok(Named::from([(
                    "observation".into(),
                    Value::from_json(
                        &json!({"session_id":"owned-session","name":"Agent","revision":1,"lifecycle":"running","execution":"idle","interaction":"ready","constraint":"none","health":"healthy"}),
                    )?,
                )]))
            }
            _ => unreachable!(),
        }
    }
}
#[tokio::test]
async fn spawn_send_wait_keep_opaque_handles_in_one_scope_until_the_graph_finishes() {
    let catalogs = CatalogRegistry::new([
        parse_catalog(AIXAND_CATALOG).unwrap(),
        graph::catalog().unwrap(),
    ])
    .unwrap();
    let mut bindings = BindingRegistry::default();
    let closed = Arc::new(AtomicBool::new(false));
    for id in [
        "aixand.agents.spawn",
        "aixand.agent.send",
        "aixand.agent.wait",
    ] {
        let definition = catalogs
            .definitions()
            .find(|definition| definition.id == id && definition.version == "1.0.0")
            .unwrap()
            .clone();
        bindings
            .register(
                definition,
                Arc::new(SessionBindings {
                    closed: closed.clone(),
                }),
            )
            .unwrap();
    }
    let engine = IrEngine::with_bindings(catalogs, bindings, "fake-sdk").unwrap();
    let plan = submission(
        json!([
            operation("spawn", "aixand.agents.spawn", json!({})),
            operation(
                "send",
                "aixand.agent.send",
                json!({"agent":reference("spawn","agent"),"text":literal(json!("Audit"))})
            ),
            operation(
                "wait",
                "aixand.agent.wait",
                json!({"agent":reference("spawn","agent"),"after":reference("send","receipt")})
            ),
            operation(
                "collector",
                "workflow.value",
                json!({"value":reference("wait","observation")})
            ),
        ]),
        json!({"spawn":[],"send":["spawn"],"wait":["send"],"collector":["wait"]}),
        reference("collector", "value"),
    );
    assert!(!engine.resumable(&plan)); // live SDK handles cannot be replayed after a crash
    engine.preflight(&plan).await.unwrap();
    assert!(!closed.load(Ordering::SeqCst));
    let result = engine
        .execute_journaled(plan, Arc::new(|_| {}), CancellationToken::new(), journal())
        .await
        .unwrap();
    assert_eq!(result["result"]["session_id"], "owned-session");
    assert!(closed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn missing_dependency_paths_are_rejected_before_effects_and_json_outputs_restore_without_replay()
 {
    let engine = IrEngine::verifier().unwrap();
    let mut plan = submission(
        json!([
            operation(
                "first",
                "workflow.value",
                json!({"value":literal(json!("saved"))})
            ),
            operation(
                "second",
                "workflow.value",
                json!({"value":reference("first","value")})
            ),
        ]),
        json!({"first":[],"second":[]}),
        reference("second", "value"),
    );
    assert_eq!(engine.preflight(&plan).await.unwrap_err().code, "graph");
    plan.workflow["dependencies"]["second"] = json!(["first"]);
    engine.preflight(&plan).await.unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let mut saved = journal();
    saved.checkpoint = json!({"published":{"first":{"value":"saved"}}});
    let result = engine
        .execute_journaled(
            plan,
            Arc::new(move |event| sink.lock().unwrap().push(event)),
            CancellationToken::new(),
            saved,
        )
        .await
        .unwrap();
    assert_eq!(result["result"], "saved");
    assert!(
        !events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["event"] == "started" && event["invocation"] == "first")
    );
}
