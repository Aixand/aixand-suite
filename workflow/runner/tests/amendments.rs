use aixand_ir::{CatalogRegistry, Named, Value, parse_catalog};
use aixand_ir_runner::{
    Binding, BindingRegistry, Cleanup, CleanupPolicy, Failure, InvocationContext,
};
use async_trait::async_trait;
use job_runner::{Request, Service, Submission, engine::IrEngine};
use serde_json::{Value as Json, json};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::{collections::BTreeMap, sync::Arc};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

struct ResourceBinding {
    closed: Arc<AtomicBool>,
    seen: Arc<Mutex<Vec<String>>>,
}
struct CloseResource(Arc<AtomicBool>);
#[async_trait]
impl Cleanup for CloseResource {
    async fn close(&self, _: CleanupPolicy) -> Result<(), Failure> {
        self.0.store(true, Ordering::SeqCst);
        Ok(())
    }
}
#[async_trait]
impl Binding for ResourceBinding {
    async fn invoke(
        &self,
        context: InvocationContext,
        inputs: Named<Value>,
    ) -> Result<Named<Value>, Failure> {
        assert!(!self.closed.load(Ordering::SeqCst));
        if context.operation.id == "test.resource.create" {
            context
                .scope
                .register_cleanup(Arc::new(CloseResource(self.closed.clone())))?;
            return Ok(Named::from([(
                "resource".into(),
                Value::Opaque(context.scope.insert(
                    "test.resource",
                    "1",
                    Arc::new("original resource".to_owned()),
                )?),
            )]));
        }
        let Value::Opaque(atom) = &inputs["resource"] else {
            panic!("resource");
        };
        assert_eq!(
            context.scope.get::<String>(atom)?.as_str(),
            "original resource"
        );
        let text = inputs["text"].to_json()?;
        self.seen
            .lock()
            .unwrap()
            .push(text.as_str().unwrap().into());
        Ok(Named::from([("value".into(), Value::from_json(&text)?)]))
    }
}

#[tokio::test]
async fn amendments_keep_opaque_resources_live_until_all_new_work_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let closed = Arc::new(AtomicBool::new(false));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let catalog=parse_catalog(&json!({"contract_version":"0.1","package":{"id":"test","version":"1.0.0"},"operations":[
        {"id":"test.gate","version":"1.0.0","inputs":{"value":{"type":{"kind":"json"},"required":true}},"outputs":{"value":{"type":{"kind":"json"}}}},
        {"id":"test.resource.create","version":"1.0.0","inputs":{},"outputs":{"resource":{"type":{"kind":"opaque","id":"test.resource","version":"1"}}}},
        {"id":"test.resource.read","version":"1.0.0","inputs":{"resource":{"type":{"kind":"opaque","id":"test.resource","version":"1"},"required":true},"text":{"type":{"kind":"string"},"required":true}},"outputs":{"value":{"type":{"kind":"json"}}}}
    ]}).to_string()).unwrap();
    let catalogs = CatalogRegistry::new([catalog, job_runner::graph::catalog().unwrap()]).unwrap();
    let mut bindings = BindingRegistry::default();
    for definition in catalogs
        .definitions()
        .filter(|definition| definition.id.starts_with("test."))
    {
        let binding: Arc<dyn Binding> = if definition.id == "test.gate" {
            Arc::new(Gate {
                entered: entered.clone(),
                release: release.clone(),
            })
        } else {
            Arc::new(ResourceBinding {
                closed: closed.clone(),
                seen: seen.clone(),
            })
        };
        bindings.register(definition.clone(), binding).unwrap();
    }
    let service = Service::open(
        dir.path(),
        Arc::new(IrEngine::with_bindings(catalogs, bindings, "resources").unwrap()),
    )
    .unwrap();
    let mut submission = graph("resource");
    let read = |id: &str, text: &str| json!({"kind":"operation","id":id,"operation":{"id":"test.resource.read","version":"1.0.0"},"inputs":{"resource":{"kind":"ref","source":"step","step":"create","output":"resource"},"text":{"kind":"literal","value":text}}});
    submission.workflow["workflow"]["body"]["steps"] = json!([
        {"kind":"operation","id":"create","operation":{"id":"test.resource.create","version":"1.0.0"},"inputs":{}},op("gate","test.gate",json!("waiting")),read("read","old")]);
    submission.workflow["groups"] = json!({"create":["create"],"gate":["gate"],"read":["read"]});
    submission.workflow["dependencies"] = json!({"create":[],"gate":["create"],"read":["gate"]});
    submission.workflow["workflow"]["outputs"]["result"]["value"]["step"] = json!("read");
    let id = submit(&service, submission.clone()).await;
    let stop = CancellationToken::new();
    let running = tokio::spawn(service.clone().serve(stop.clone()));
    entered.acquire().await.unwrap().forget();
    assert!(!closed.load(Ordering::SeqCst));
    let mut revised = submission.workflow;
    revised["workflow"]["body"]["steps"][2] = read("read", "revised");
    revised["workflow"]["body"]["steps"]
        .as_array_mut()
        .unwrap()
        .push(read("extra", "appended"));
    revised["groups"]["extra"] = json!(["extra"]);
    revised["dependencies"]["extra"] = json!(["read"]);
    revised["workflow"]["outputs"]["result"]["value"]["step"] = json!("extra");
    service
        .handle(Request::Amend {
            id: id.clone(),
            key: "resource-edit".into(),
            expected_revision: 1,
            workflow: revised,
            authoring: None,
        })
        .await
        .unwrap();
    release.add_permits(1);
    assert_eq!(result(&service, &id).await["result"]["result"], "appended");
    assert_eq!(*seen.lock().unwrap(), vec!["revised", "appended"]);
    assert!(closed.load(Ordering::SeqCst));
    stop.cancel();
    running.await.unwrap().unwrap();
}

struct Gate {
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
}
#[async_trait]
impl Binding for Gate {
    async fn invoke(
        &self,
        _: InvocationContext,
        inputs: Named<Value>,
    ) -> Result<Named<Value>, Failure> {
        self.entered.add_permits(1);
        self.release.acquire().await.unwrap().forget();
        Ok(inputs)
    }
}
fn op(id: &str, operation: &str, value: Json) -> Json {
    json!({"kind":"operation","id":id,"operation":{"id":operation,"version":"1.0.0"},"inputs":{"value":{"kind":"literal","value":value}}})
}
fn graph(key: &str) -> Submission {
    Submission {
        key: key.into(),
        inputs: json!({}),
        metadata: json!({}),
        workflow: json!({"format":"aixand.workflow-graph","version":2,"context":{},
        "groups":{"audit":["audit"],"plan":["plan"]},"dependencies":{"audit":[],"plan":["audit"]},
        "workflow":{"ir_version":"0.1","name":"Mutable","inputs":{},"body":{"kind":"sequence","steps":[op("audit","test.gate",json!("original")),op("plan","workflow.value",json!("old instructions"))]},
        "outputs":{"result":{"type":{"kind":"json"},"value":{"kind":"ref","source":"step","step":"plan","output":"value"}}}}}),
    }
}
fn service(
    home: &std::path::Path,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
) -> Arc<Service> {
    let extra=parse_catalog(&json!({"contract_version":"0.1","package":{"id":"test","version":"1.0.0"},"operations":[{"id":"test.gate","version":"1.0.0","inputs":{"value":{"type":{"kind":"json"},"required":true}},"outputs":{"value":{"type":{"kind":"json"}}}}]}).to_string()).unwrap();
    let catalogs = CatalogRegistry::new([extra, job_runner::graph::catalog().unwrap()]).unwrap();
    let mut bindings = BindingRegistry::default();
    let definition = catalogs
        .definitions()
        .find(|definition| definition.id == "test.gate")
        .unwrap()
        .clone();
    bindings
        .register(definition, Arc::new(Gate { entered, release }))
        .unwrap();
    Service::open(
        home,
        Arc::new(IrEngine::with_bindings(catalogs, bindings, "test-mutable").unwrap()),
    )
    .unwrap()
}
async fn submit(service: &Service, submission: Submission) -> String {
    service
        .handle(Request::Submit { submission })
        .await
        .unwrap()["job"]["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn result(service: &Service, id: &str) -> Json {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let result = service
                .handle(Request::Result { id: id.into() })
                .await
                .unwrap();
            if result["state"] == "completed" {
                return result;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn revises_pending_work_preserves_started_work_and_original_submission_identity() {
    let dir = tempfile::tempdir().unwrap();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let service = service(dir.path(), entered.clone(), release.clone());
    let original = graph("first");
    let id = submit(&service, original.clone()).await;
    let stop = CancellationToken::new();
    let running = tokio::spawn(service.clone().serve(stop.clone()));
    entered.acquire().await.unwrap().forget();
    let mut candidate = original.workflow.clone();
    candidate["workflow"]["body"]["steps"][1]["inputs"]["value"]["value"] =
        json!("revised instructions");
    let request = || Request::Amend {
        id: id.clone(),
        key: "edit-one".into(),
        expected_revision: 1,
        workflow: candidate.clone(),
        authoring: None,
    };
    assert_eq!(service.handle(request()).await.unwrap()["revision"], 2);
    assert_eq!(service.handle(request()).await.unwrap()["replayed"], true);
    let mut forbidden = candidate.clone();
    forbidden["workflow"]["body"]["steps"][0]["inputs"]["value"]["value"] =
        json!("rewrite active work");
    assert_eq!(
        service
            .handle(Request::Amend {
                id: id.clone(),
                key: "edit-active".into(),
                expected_revision: 2,
                workflow: forbidden,
                authoring: None
            })
            .await
            .unwrap_err()
            .code,
        "step_locked"
    );
    assert_eq!(
        service
            .handle(Request::Submit {
                submission: original
            })
            .await
            .unwrap()["job"]["id"],
        id
    );
    release.add_permits(1);
    assert_eq!(
        result(&service, &id).await["result"]["result"],
        "revised instructions"
    );
    assert_eq!(entered.available_permits(), 0);
    stop.cancel();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn hold_keeps_a_finished_run_open_for_append_and_finalization_rejects_late_edits() {
    let dir = tempfile::tempdir().unwrap();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let service = service(dir.path(), entered.clone(), release.clone());
    let original = graph("hold");
    let id = submit(&service, original.clone()).await;
    service
        .handle(Request::Hold { id: id.clone() })
        .await
        .unwrap();
    let stop = CancellationToken::new();
    let running = tokio::spawn(service.clone().serve(stop.clone()));
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_eq!(entered.available_permits(), 0);
    service
        .handle(Request::Release { id: id.clone() })
        .await
        .unwrap();
    entered.acquire().await.unwrap().forget();
    service
        .handle(Request::Hold { id: id.clone() })
        .await
        .unwrap();
    release.add_permits(1);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let mut candidate = original.workflow;
    candidate["workflow"]["body"]["steps"]
        .as_array_mut()
        .unwrap()
        .insert(1, op("review", "workflow.value", json!("review")));
    candidate["groups"]["review"] = json!(["review"]);
    candidate["dependencies"]["review"] = json!(["audit"]);
    candidate["dependencies"]["plan"] = json!(["review"]);
    assert_eq!(
        service
            .handle(Request::Amend {
                id: id.clone(),
                key: "append".into(),
                expected_revision: 1,
                workflow: candidate.clone(),
                authoring: None
            })
            .await
            .unwrap()["revision"],
        2
    );
    service
        .handle(Request::Release { id: id.clone() })
        .await
        .unwrap();
    result(&service, &id).await;
    assert_eq!(
        service
            .handle(Request::Amend {
                id: id.clone(),
                key: "late".into(),
                expected_revision: 2,
                workflow: candidate,
                authoring: None
            })
            .await
            .unwrap_err()
            .code,
        "run_finalizing"
    );
    stop.cancel();
    running.await.unwrap().unwrap();
}

fn child() -> Submission {
    let mut target = graph("ignored");
    target.workflow["workflow"]["body"]["steps"] =
        json!([op("receive", "workflow.value", Json::Null)]);
    target.workflow["workflow"]["body"]["steps"][0]["inputs"]["value"] =
        json!({"kind":"ref","source":"input","name":"previous_result"});
    target.workflow["workflow"]["inputs"] = json!({"previous_result":{"type":{"kind":"json"}}});
    target.workflow["groups"] = json!({"receive":["receive"]});
    target.workflow["dependencies"] = json!({"receive":[]});
    target.workflow["workflow"]["outputs"]["result"]["value"]["step"] = json!("receive");
    target
}

#[tokio::test]
async fn continuation_registered_during_and_after_completion_passes_full_result_once() {
    let dir = tempfile::tempdir().unwrap();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let service = service(dir.path(), entered.clone(), release.clone());
    let parent = submit(&service, graph("parent")).await;
    let register = |key: &str| Request::Continue {
        id: parent.clone(),
        key: key.into(),
        target: child(),
        input_map: BTreeMap::from([("previous_result".into(), "/result".into())]),
    };
    let first = service.handle(register("first")).await.unwrap();
    assert_eq!(first["state"], "waiting");
    let stop = CancellationToken::new();
    let running = tokio::spawn(service.clone().serve(stop.clone()));
    entered.acquire().await.unwrap().forget();
    release.add_permits(1);
    result(&service, &parent).await;
    let first_child = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let rows = service
                .handle(Request::Continuations { id: parent.clone() })
                .await
                .unwrap();
            if let Some(id) = rows["continuations"][0]["child_id"].as_str() {
                break id.to_owned();
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        result(&service, &first_child).await["result"]["result"],
        "old instructions"
    );
    let replay = service.handle(register("first")).await.unwrap();
    assert_eq!(replay["child_id"], first_child);
    let late = service.handle(register("late")).await.unwrap();
    assert_eq!(late["state"], "ready");
    let cancelled = service
        .handle(Request::CancelContinuation {
            id: late["id"].as_str().unwrap().into(),
        })
        .await
        .unwrap();
    assert_eq!(cancelled["state"], "cancelled");
    stop.cancel();
    running.await.unwrap().unwrap();
    let durable = service.handle(register("restart")).await.unwrap();
    assert_eq!(durable["state"], "ready");
    drop(service);
    let service = self::service(dir.path(), entered, release);
    assert_eq!(
        service.handle(register("restart")).await.unwrap()["id"],
        durable["id"]
    );
    let stop = CancellationToken::new();
    let running = tokio::spawn(service.clone().serve(stop.clone()));
    let child = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let link = service.handle(register("restart")).await.unwrap();
            if let Some(id) = link["child_id"].as_str() {
                break id.to_owned();
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        result(&service, &child).await["result"]["result"],
        "old instructions"
    );
    assert_eq!(
        service.handle(register("restart")).await.unwrap()["child_id"],
        child
    );
    stop.cancel();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn legacy_nonresumable_graph_adopts_before_dispatch_and_keeps_started_scopes_fixed() {
    let dir = tempfile::tempdir().unwrap();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let service = service(dir.path(), entered.clone(), release.clone());
    let mut original = graph("legacy");
    original.workflow["version"] = json!(1);
    original.workflow.as_object_mut().unwrap().remove("groups");
    let queued = submit(&service, original.clone()).await;
    let adoption = |id: &str| Request::EnableEdits {
        id: id.into(),
        key: "enable".into(),
        authoring: None,
        groups: BTreeMap::new(),
        identities: BTreeMap::new(),
    };
    let plan = service.handle(adoption(&queued)).await.unwrap();
    assert_eq!(plan["workflow"]["version"], 2);
    assert_eq!(plan["held"], true);
    assert_eq!(submit(&service, original.clone()).await, queued);
    let stop = CancellationToken::new();
    let running = tokio::spawn(service.clone().serve(stop.clone()));
    service
        .handle(Request::Release { id: queued.clone() })
        .await
        .unwrap();
    entered.acquire().await.unwrap().forget();
    release.add_permits(1);
    result(&service, &queued).await;
    original.key = "started-legacy".into();
    let started = submit(&service, original).await;
    entered.acquire().await.unwrap().forget();
    assert_eq!(
        service.handle(adoption(&started)).await.unwrap_err().code,
        "opaque_resources"
    );
    release.add_permits(1);
    result(&service, &started).await;
    stop.cancel();
    running.await.unwrap().unwrap();
}
