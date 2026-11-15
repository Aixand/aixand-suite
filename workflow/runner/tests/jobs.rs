use aixand_ir::{CatalogRegistry, Named, Value as IrValue, parse_catalog};
use aixand_ir_runner::{
    Binding, BindingRegistry, Cleanup, CleanupPolicy, Failure, InvocationContext,
};
use async_trait::async_trait;
use job_runner::{
    Service, Submission,
    client::Client,
    engine::{Engine, IrEngine},
    model::{Events, Job, JobState, Request},
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tempfile::TempDir;
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

fn verifier(key: &str) -> Submission {
    Submission {
        key: key.into(),
        workflow: serde_json::from_str(include_str!("../examples/verify.json")).unwrap(),
        inputs: json!({"title":"Design","body":"A workflow runs"}),
        metadata: json!({}),
    }
}

async fn submit(service: &Service, submission: Submission) -> Job {
    serde_json::from_value(
        service
            .handle(Request::Submit { submission })
            .await
            .unwrap()["job"]
            .clone(),
    )
    .unwrap()
}

async fn inspect(service: &Service, id: &str) -> Job {
    serde_json::from_value(
        service
            .handle(Request::Inspect { id: id.into() })
            .await
            .unwrap(),
    )
    .unwrap()
}

async fn wait(service: &Service, id: &str, state: JobState) -> Job {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let job = inspect(service, id).await;
            if job.state == state {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

fn service(dir: &TempDir) -> Arc<Service> {
    Service::open(dir.path(), Arc::new(IrEngine::verifier().unwrap())).unwrap()
}

#[tokio::test]
async fn submission_replays_conflicts_and_validation_precede_queueing() {
    let dir = TempDir::new().unwrap();
    let service = service(&dir);
    let first = submit(&service, verifier("one")).await;
    let replay = service
        .handle(Request::Submit {
            submission: verifier("one"),
        })
        .await
        .unwrap();
    assert_eq!(replay["job"]["id"], first.id);
    assert_eq!(replay["replayed"], true);
    let mut changed = verifier("one");
    changed.inputs["body"] = json!("changed");
    assert_eq!(
        service
            .handle(Request::Submit {
                submission: changed
            })
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
    let mut bad = verifier("bad");
    bad.inputs = json!({"title":7});
    assert!(
        service
            .handle(Request::Submit { submission: bad })
            .await
            .is_err()
    );
    let mut unbound = verifier("unbound");
    unbound.workflow =
        serde_json::from_str(include_str!("../examples/research-explicit.json")).unwrap();
    unbound.inputs = json!({"task":"test"});
    assert_eq!(
        service
            .handle(Request::Submit {
                submission: unbound
            })
            .await
            .unwrap_err()
            .code,
        "missing_binding"
    );
    assert_eq!(
        service
            .handle(Request::List {
                after: 0,
                limit: 100
            })
            .await
            .unwrap()["jobs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn concurrent_submissions_deduplicate_atomically() {
    let dir = TempDir::new().unwrap();
    let service = service(&dir);
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..12 {
        let service = service.clone();
        tasks.spawn(async move { submit(&service, verifier("same")).await.id });
    }
    let mut ids = std::collections::HashSet::new();
    while let Some(id) = tasks.join_next().await {
        ids.insert(id.unwrap());
    }
    assert_eq!(ids.len(), 1);
}

#[tokio::test]
async fn cancellation_by_key_blocks_late_acceptance_and_survives_restart() {
    struct PausedPreflight {
        inner: IrEngine,
        entered: Arc<Semaphore>,
        release: Arc<Semaphore>,
    }
    #[async_trait]
    impl Engine for PausedPreflight {
        fn fingerprint(&self) -> &str {
            self.inner.fingerprint()
        }
        async fn preflight(&self, submission: &Submission) -> job_runner::Result<()> {
            self.entered.add_permits(1);
            self.release.acquire().await.unwrap().forget();
            self.inner.preflight(submission).await
        }
        async fn execute(
            &self,
            submission: Submission,
            observer: job_runner::engine::Observer,
            cancellation: CancellationToken,
        ) -> std::result::Result<Value, Failure> {
            self.inner.execute(submission, observer, cancellation).await
        }
    }
    let dir = TempDir::new().unwrap();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let original = Service::open(
        dir.path(),
        Arc::new(PausedPreflight {
            inner: IrEngine::verifier().unwrap(),
            entered: entered.clone(),
            release: release.clone(),
        }),
    )
    .unwrap();
    let pending_service = original.clone();
    let pending = tokio::spawn(async move {
        pending_service
            .handle(Request::Submit {
                submission: verifier("late"),
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert!(
        original
            .handle(Request::CancelKey { key: "late".into() })
            .await
            .unwrap()
            .is_null()
    );
    release.add_permits(1);
    assert_eq!(pending.await.unwrap().unwrap_err().code, "cancelled");
    assert!(
        original
            .handle(Request::Lookup { key: "late".into() })
            .await
            .unwrap()
            .is_null()
    );
    drop(original);
    let reopened = service(&dir);
    assert_eq!(
        reopened
            .handle(Request::Submit {
                submission: verifier("late")
            })
            .await
            .unwrap_err()
            .code,
        "cancelled"
    );
    let accepted = submit(&reopened, verifier("accepted")).await;
    for _ in 0..2 {
        let cancelled = reopened
            .handle(Request::CancelKey {
                key: "accepted".into(),
            })
            .await
            .unwrap();
        assert_eq!(cancelled["id"], accepted.id);
        assert_eq!(cancelled["state"], "cancelled");
    }
    assert_eq!(
        submit(&reopened, verifier("accepted")).await.id,
        accepted.id
    );
}

#[tokio::test]
async fn cancelled_queued_job_has_no_attempt_and_cancellation_is_idempotent() {
    let dir = TempDir::new().unwrap();
    let service = service(&dir);
    let job = submit(&service, verifier("queued")).await;
    for _ in 0..2 {
        service
            .handle(Request::Cancel { id: job.id.clone() })
            .await
            .unwrap();
    }
    let cancelled = inspect(&service, &job.id).await;
    assert_eq!(cancelled.state, JobState::Cancelled);
    assert!(cancelled.attempt_id.is_none());
    let events = service
        .handle(Request::Events {
            id: job.id,
            after: 0,
            limit: 100,
        })
        .await
        .unwrap();
    assert_eq!(events["events"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn queued_work_survives_restart_and_application_failure_is_a_result() {
    let dir = TempDir::new().unwrap();
    let initial = service(&dir);
    let mut request = verifier("invalid-document");
    request.inputs["body"] = json!("missing the required term");
    let job = submit(&initial, request).await;
    drop(initial);
    let resumed = service(&dir);
    let shutdown = CancellationToken::new();
    let task = tokio::spawn(resumed.clone().serve(shutdown.clone()));
    let done = wait(&resumed, &job.id, JobState::Completed).await;
    assert_eq!(done.result.unwrap()["result"]["passed"], false);
    let mut after = 0;
    let mut events = vec![];
    loop {
        let page: Events = serde_json::from_value(
            resumed
                .handle(Request::Events {
                    id: job.id.clone(),
                    after,
                    limit: 1,
                })
                .await
                .unwrap(),
        )
        .unwrap();
        after = page.next_after;
        events.extend(page.events);
        if !page.has_more {
            break;
        }
    }
    assert!(events.iter().any(|e| e.data["event"] == "started"));
    assert_eq!(events.last().unwrap().data["state"], "completed");
    shutdown.cancel();
    task.await.unwrap().unwrap();
    drop(resumed);
    let reopened = service(&dir);
    assert_eq!(inspect(&reopened, &job.id).await.state, JobState::Completed);
}

struct Controlled {
    starts: mpsc::UnboundedSender<String>,
    permits: Arc<Semaphore>,
    cleanup_fails: bool,
}
struct BadCleanup;
#[async_trait]
impl Cleanup for BadCleanup {
    async fn close(&self, _: CleanupPolicy) -> std::result::Result<(), Failure> {
        Err(Failure::new(
            "cleanup_test",
            "Cleanup could not confirm its outcome",
        ))
    }
}

#[async_trait]
impl Binding for Controlled {
    async fn invoke(
        &self,
        context: InvocationContext,
        inputs: Named<IrValue>,
    ) -> std::result::Result<Named<IrValue>, Failure> {
        if self.cleanup_fails {
            context.scope.register_cleanup(Arc::new(BadCleanup))?;
        }
        self.starts
            .send(inputs["name"].as_str().unwrap().into())
            .unwrap();
        self.permits.acquire().await.unwrap().forget();
        Ok(Named::new())
    }
}

fn controlled(
    cleanup_fails: bool,
    version: &str,
) -> (
    Arc<dyn Engine>,
    mpsc::UnboundedReceiver<String>,
    Arc<Semaphore>,
) {
    let catalog = parse_catalog(&json!({"contract_version":"0.1","package":{"id":"test","version":"1"},"operations":[{
        "id":"test.wait","version":"1","inputs":{"name":{"type":{"kind":"string"},"required":true}},"outputs":{}
    }]}).to_string()).unwrap();
    let registry = CatalogRegistry::new([catalog]).unwrap();
    let (starts, receiver) = mpsc::unbounded_channel();
    let permits = Arc::new(Semaphore::new(0));
    let mut bindings = BindingRegistry::default();
    bindings
        .register(
            registry.definitions().next().unwrap().clone(),
            Arc::new(Controlled {
                starts,
                permits: permits.clone(),
                cleanup_fails,
            }),
        )
        .unwrap();
    (
        Arc::new(IrEngine::with_bindings(registry, bindings, version).unwrap()),
        receiver,
        permits,
    )
}

fn slow(key: &str) -> Submission {
    Submission {
        key: key.into(),
        inputs: json!({}),
        metadata: json!({}),
        workflow: json!({
            "ir_version":"0.1","inputs":{},"outputs":{},"body":{"kind":"sequence","steps":[{
                "kind":"operation","id":"work","operation":{"id":"test.wait","version":"1"},
                "inputs":{"name":{"kind":"literal","value":key}}
            }]}
        }),
    }
}

#[tokio::test]
async fn single_worker_runs_real_ir_bindings_and_cancels_an_active_attempt() {
    let dir = TempDir::new().unwrap();
    let (engine, mut starts, permits) = controlled(false, "1");
    let service = Service::open(dir.path(), engine).unwrap();
    let first = submit(&service, slow("first")).await;
    let second = submit(&service, slow("second")).await;
    assert!(
        starts.try_recv().is_err(),
        "Preflight must not invoke the operation"
    );
    let stop = CancellationToken::new();
    let task = tokio::spawn(service.clone().serve(stop.clone()));
    assert_eq!(starts.recv().await.unwrap(), "first");
    assert_eq!(inspect(&service, &second.id).await.state, JobState::Queued);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), starts.recv())
            .await
            .is_err()
    );
    permits.add_permits(1);
    assert_eq!(starts.recv().await.unwrap(), "second");
    assert_eq!(
        inspect(&service, &first.id).await.state,
        JobState::Completed
    );
    let response = service
        .handle(Request::Cancel {
            id: second.id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(response["cancel_requested"], true);
    assert_eq!(response["state"], "running");
    wait(&service, &second.id, JobState::Cancelled).await;
    stop.cancel();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn graceful_shutdown_cancels_and_retains_pending_work() {
    let dir = TempDir::new().unwrap();
    let (engine, mut starts, _) = controlled(false, "1");
    let service = Service::open(dir.path(), engine).unwrap();
    let first = submit(&service, slow("first")).await;
    let pending = submit(&service, slow("pending")).await;
    let stop = CancellationToken::new();
    let task = tokio::spawn(service.clone().serve(stop.clone()));
    starts.recv().await.unwrap();
    stop.cancel();
    task.await.unwrap().unwrap();
    assert_eq!(
        inspect(&service, &first.id).await.state,
        JobState::Cancelled
    );
    assert_eq!(inspect(&service, &pending.id).await.state, JobState::Queued);
}

#[tokio::test]
async fn worker_pool_bounds_concurrency_and_cancels_only_the_selected_job() {
    let dir = TempDir::new().unwrap();
    let (engine, mut starts, permits) = controlled(false, "pool-1");
    let service = Service::open_with_workers(dir.path(), engine, 2).unwrap();
    let first = submit(&service, slow("first")).await;
    let second = submit(&service, slow("second")).await;
    let third = submit(&service, slow("third")).await;
    let stop = CancellationToken::new();
    let task = tokio::spawn(service.clone().serve(stop.clone()));
    let mut initial = vec![starts.recv().await.unwrap(), starts.recv().await.unwrap()];
    initial.sort();
    assert_eq!(initial, ["first", "second"]);
    assert_eq!(inspect(&service, &third.id).await.state, JobState::Queued);
    service
        .handle(Request::Cancel {
            id: first.id.clone(),
        })
        .await
        .unwrap();
    wait(&service, &first.id, JobState::Cancelled).await;
    assert_eq!(starts.recv().await.unwrap(), "third");
    assert_eq!(inspect(&service, &second.id).await.state, JobState::Running);
    permits.add_permits(2);
    wait(&service, &second.id, JobState::Completed).await;
    wait(&service, &third.id, JobState::Completed).await;
    assert_eq!(service.handle(Request::Health).await.unwrap()["workers"], 2);
    stop.cancel();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn pool_shutdown_joins_every_active_attempt_and_retains_the_queue() {
    let dir = TempDir::new().unwrap();
    let (engine, mut starts, _) = controlled(false, "pool-1");
    assert!(Service::open_with_workers(dir.path(), engine.clone(), 0).is_err());
    let service = Service::open_with_workers(dir.path(), engine, 2).unwrap();
    let first = submit(&service, slow("first")).await;
    let second = submit(&service, slow("second")).await;
    let third = submit(&service, slow("third")).await;
    let stop = CancellationToken::new();
    let task = tokio::spawn(service.clone().serve(stop.clone()));
    starts.recv().await.unwrap();
    starts.recv().await.unwrap();
    stop.cancel();
    task.await.unwrap().unwrap();
    assert_eq!(
        inspect(&service, &first.id).await.state,
        JobState::Cancelled
    );
    assert_eq!(
        inspect(&service, &second.id).await.state,
        JobState::Cancelled
    );
    assert_eq!(inspect(&service, &third.id).await.state, JobState::Queued);
}

#[tokio::test]
async fn cleanup_failure_is_uncertain_and_runtime_changes_block_queued_work() {
    let dir = TempDir::new().unwrap();
    let (engine, mut starts, permits) = controlled(true, "1");
    let service = Service::open(dir.path(), engine).unwrap();
    let job = submit(&service, slow("cleanup")).await;
    let stop = CancellationToken::new();
    let task = tokio::spawn(service.clone().serve(stop.clone()));
    starts.recv().await.unwrap();
    permits.add_permits(1);
    wait(&service, &job.id, JobState::Uncertain).await;
    stop.cancel();
    task.await.unwrap().unwrap();
    let pending = submit(&service, slow("pending")).await;
    drop(service);
    let (engine, mut starts, _) = controlled(false, "2");
    let changed = Service::open(dir.path(), engine).unwrap();
    let replay = changed
        .handle(Request::Submit {
            submission: slow("pending"),
        })
        .await
        .unwrap();
    assert_eq!(replay["job"]["id"], pending.id);
    let stop = CancellationToken::new();
    let task = tokio::spawn(changed.clone().serve(stop.clone()));
    let blocked = wait(&changed, &pending.id, JobState::Blocked).await;
    assert_eq!(blocked.error.unwrap()["code"], "engine_changed");
    assert!(starts.try_recv().is_err());
    stop.cancel();
    task.await.unwrap().unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn ownership_socket_protocol_and_unknown_jobs_are_explicit() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::UnixStream,
    };
    let dir = TempDir::new().unwrap();
    let service = service(&dir);
    assert!(Service::open(dir.path(), Arc::new(IrEngine::verifier().unwrap())).is_err());
    let stop = CancellationToken::new();
    let task = tokio::spawn(service.clone().serve(stop.clone()));
    let client = Client::new(dir.path());
    tokio::time::timeout(Duration::from_secs(5), async {
        while client.request(Request::Health).await.is_err() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        client
            .request(Request::Inspect {
                id: "missing".into()
            })
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    assert!(
        client
            .request(Request::List { after: 0, limit: 0 })
            .await
            .is_err()
    );
    let mut socket = UnixStream::connect(service.socket()).await.unwrap();
    socket
        .write_all(b"{\"op\":\"health\",\"op\":\"list\"}\n")
        .await
        .unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).await.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&response).unwrap()["ok"],
        false
    );
    stop.cancel();
    task.await.unwrap().unwrap();
    assert!(!service.socket().exists());
}

#[tokio::test]
async fn agent_context_validation_and_identity_precede_queueing() {
    let dir = TempDir::new().unwrap();
    let service = service(&dir);
    for context in [
        json!({"metadata":{"nested":{}}}),
        json!({"labels":{"app":"é".repeat(129)}}),
        json!({"metadata":{"private":"secret\nvalue"}}),
        json!({"labels":{"agent_manager.run_id":"override"}}),
    ] {
        let mut request = verifier("invalid-context");
        request.metadata = json!({"agent_context":context});
        let error = service
            .handle(Request::Submit {
                submission: request,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, "agent_context");
        assert!(!error.message.contains("secret"));
    }
    let mut request = verifier("context");
    request.metadata = json!({"agent_context":{"labels":{"app":"pathspec"},"metadata":{"inputs.path":"/work/input.json"}}});
    let job = submit(&service, request.clone()).await;
    request.metadata["agent_context"]["metadata"]["inputs.path"] = json!("/work/other.json");
    assert_eq!(
        service
            .handle(Request::Submit {
                submission: request
            })
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(
        job.submission.metadata["agent_context"]["labels"]["app"],
        "pathspec"
    );
}
