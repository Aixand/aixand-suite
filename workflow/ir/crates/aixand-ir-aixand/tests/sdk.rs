#![cfg(feature = "sdk-tests")]
use aixand_ir::*;
use aixand_ir_aixand::{Config, install_connection, install_connection_catalog};
use aixand_ir_runner::*;
use pyo3::{prelude::*, types::PyModule};
use serde_json::{Value as Json, json};
use std::ffi::CString;
use tokio_util::sync::CancellationToken;

static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn terminal_observer_reports_exact_public_identity_before_send() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    let scope = Scope::new(CleanupPolicy::StopOwned);
    let mut bindings = BindingRegistry::default();
    let connection = Python::attach(|py| f.bind(py).getattr("connection").unwrap().unbind());
    let sessions = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = sessions.clone();
    aixand_ir_aixand::install_connection_with_session_observer(
        &scope,
        &mut bindings,
        connection,
        Config::default(),
        std::sync::Arc::new(move |session| observed.lock().unwrap().push(session)),
    )
    .unwrap();
    let catalogs = CatalogRegistry::new([parse_catalog(AIXAND_CATALOG).unwrap()]).unwrap();
    let before_send = sessions.clone();
    let runner = Runner::new(catalogs, bindings).with_observer(move |event| {
        if let Event::Started { invocation, .. } = event
            && invocation == "send"
        {
            assert_eq!(before_send.lock().unwrap().len(), 1);
        }
    });
    runner
        .run(
            &wf(vec![spawn(), send()], json!({})),
            Named::new(),
            &scope,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let identity = serde_json::to_value(&sessions.lock().unwrap()[0]).unwrap();
    assert_eq!(
        identity,
        json!({"invocation":"spawn", "run_id":"run1",
        "session_id":"session1", "provider":"codex"})
    );
    scope.close().await.unwrap();
    assert_eq!(
        read(&f, "connection.agents[0].labels['workflow.step_id']"),
        json!("spawn")
    );
    assert_eq!(
        read(&f, "connection.context"),
        json!({"labels":{}, "metadata":{}})
    );
    assert_eq!(read(&f, "runtime.inputs[0][0]"), json!("task"));
    assert_eq!(read(&f, "runtime.stops"), json!(["session1"]));
}

#[tokio::test]
async fn compiled_python_uses_existing_sdk_bindings_and_runner() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    let catalog = CatalogRegistry::new([parse_catalog(include_str!(
        "../../../examples/real-agent/catalog.json"
    ))
    .unwrap()])
    .unwrap();
    let workflow = aixand_ir_frontend::lower_python(
        include_str!("../../../examples/python/managed_codex_two_turns.py"),
        &catalog,
    )
    .unwrap();
    let scope = Scope::new(CleanupPolicy::StopOwned);
    let mut bindings = BindingRegistry::default();
    let connection = Python::attach(|py| f.bind(py).getattr("connection").unwrap().unbind());
    install_connection_catalog(
        &scope,
        &mut bindings,
        connection,
        Config::default(),
        &catalog,
    )
    .unwrap();
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = events.clone();
    let runner = Runner::new(catalog, bindings).with_observer(move |event| {
        if let Event::Started { invocation, .. } = event {
            observed.lock().unwrap().push(invocation);
        }
    });
    let result = runner
        .run(
            &workflow,
            Named::from([("task".into(), Value::String("compiled task".into()))]),
            &scope,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["run_id"].as_str(), Some("run1"));
    assert_eq!(result["task_observation"].to_json().unwrap()["revision"], 2);
    assert_eq!(
        result["summary_observation"].to_json().unwrap()["revision"],
        3
    );
    assert_eq!(
        *events.lock().unwrap(),
        ["spawn_1", "send_1", "wait_1", "send_2", "wait_2", "stop_1"]
    );
    assert_eq!(
        read(&f, "[text for text, _ in runtime.inputs]"),
        json!(["compiled task", "Summarize your findings."])
    );
    assert_eq!(
        read(&f, "[w['after_revision'] for w in runtime.waits]"),
        json!([null, 2, 2, 3])
    );
    assert_eq!(read(&f, "runtime.stops"), json!(["session1"]));
    assert_eq!(read(&f, "connection.agents[0]._stopped"), json!(true));
    scope.close().await.unwrap();
    assert_eq!(read(&f, "runtime.stops"), json!(["session1"]));
}
fn fixture() -> Py<PyModule> {
    Python::attach(|py| {
        if let Ok(path) = std::env::var("AIXAND_IR_SDK_SITE_PACKAGES")
            .or_else(|_| std::env::var("INTESSIO_IR_SDK_SITE_PACKAGES"))
        {
            py.import("site")
                .unwrap()
                .call_method1("addsitedir", (path,))
                .unwrap();
        }
        PyModule::from_code(
            py,
            &CString::new(include_str!("sdk_fixture.py")).unwrap(),
            c"sdk_fixture.py",
            c"ir_test_fixture",
        )
        .unwrap()
        .unbind()
    })
}
fn setup(f: &Py<PyModule>, policy: CleanupPolicy) -> (Scope, Runner) {
    let scope = Scope::new(policy);
    let mut bindings = BindingRegistry::default();
    let connection = Python::attach(|py| f.bind(py).getattr("connection").unwrap().unbind());
    install_connection(&scope, &mut bindings, connection, Config::default()).unwrap();
    let catalogs = CatalogRegistry::new([parse_catalog(AIXAND_CATALOG).unwrap()]).unwrap();
    (scope, Runner::new(catalogs, bindings))
}
fn wf(steps: Vec<Json>, outputs: Json) -> Workflow {
    parse_workflow(&json!({"ir_version":"0.1","inputs":{},"body":{"kind":"sequence","steps":steps},"outputs":outputs}).to_string()).unwrap()
}
fn step(id: &str, op: &str, inputs: Json) -> Json {
    json!({"kind":"operation","id":id,"operation":{"id":op,"version":"1.0.0"},"inputs":inputs})
}
fn lit(v: Json) -> Json {
    json!({"kind":"literal","value":v})
}
fn r(s: &str, o: &str) -> Json {
    json!({"kind":"ref","source":"step","step":s,"output":o})
}
fn spawn() -> Json {
    step("spawn", "aixand.agents.spawn", json!({}))
}
fn send() -> Json {
    step(
        "send",
        "aixand.agent.send",
        json!({"agent":r("spawn","agent"),"text":lit(json!("task"))}),
    )
}
fn read(f: &Py<PyModule>, expression: &str) -> Json {
    Python::attach(|py| {
        let v = py
            .eval(
                &CString::new(expression).unwrap(),
                Some(&f.bind(py).dict()),
                None,
            )
            .unwrap();
        let text: String = py
            .import("json")
            .unwrap()
            .call_method1("dumps", (v,))
            .unwrap()
            .extract()
            .unwrap();
        parse_json(&text).unwrap()
    })
}

#[tokio::test]
async fn hand_authored_workflow_uses_only_selected_sdk_bindings() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    let catalog = CatalogRegistry::new([parse_catalog(include_str!(
        "../../../examples/real-agent/catalog.json"
    ))
    .unwrap()])
    .unwrap();
    let scope = Scope::new(CleanupPolicy::StopOwned);
    let mut bindings = BindingRegistry::default();
    let connection = Python::attach(|py| f.bind(py).getattr("connection").unwrap().unbind());
    install_connection_catalog(
        &scope,
        &mut bindings,
        connection,
        Config::default(),
        &catalog,
    )
    .unwrap();
    let full = CatalogRegistry::new([parse_catalog(AIXAND_CATALOG).unwrap()]).unwrap();
    let unsupported = wf(
        vec![step(
            "get",
            "aixand.agents.get",
            json!({"run_id":lit(json!("run1"))}),
        )],
        json!({}),
    );
    let error = Runner::new(full, bindings.clone())
        .run(&unsupported, Named::new(), &scope, CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, "missing_binding");
    let workflow =
        parse_workflow(include_str!("../../../examples/real-agent/workflow.json")).unwrap();
    let result = Runner::new(catalog, bindings)
        .run(
            &workflow,
            Named::from([("task".into(), Value::String("fixture task".into()))]),
            &scope,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["run_id"].as_str(), Some("run1"));
    assert_eq!(result["task_observation"].to_json().unwrap()["revision"], 2);
    assert_eq!(
        result["summary_observation"].to_json().unwrap()["revision"],
        3
    );
    assert_eq!(
        read(&f, "[text for text, _ in runtime.inputs]"),
        json!(["fixture task", "Summarize your findings."])
    );
    // SDK send also checks readiness. The two explicit IR waits use 2 then 3.
    assert_eq!(
        read(&f, "[w['after_revision'] for w in runtime.waits]"),
        json!([null, 2, 2, 3])
    );
    assert_eq!(read(&f, "runtime.stops"), json!(["session1"]));
    // Check before scope cleanup so stop-owned cannot mask a missing IR stop.
    assert_eq!(read(&f, "connection.closed"), json!(false));
    assert_eq!(read(&f, "connection.agents[0]._stopped"), json!(true));
    scope.close().await.unwrap();
    assert_eq!(read(&f, "runtime.stops"), json!(["session1"]));
    assert_eq!(read(&f, "connection.closed"), json!(true));
}

#[tokio::test]
async fn real_sdk_wait_omission_null_explicit_and_screen_decoding() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    let (scope, runner) = setup(&f, CleanupPolicy::Detach);
    let steps = vec![
        spawn(),
        send(),
        step(
            "implicit",
            "aixand.agent.wait",
            json!({"agent":r("spawn","agent")}),
        ),
        step(
            "null",
            "aixand.agent.wait",
            json!({"agent":r("spawn","agent"),"after":lit(Json::Null)}),
        ),
        step(
            "explicit",
            "aixand.agent.wait",
            json!({"agent":r("spawn","agent"),"after":r("send","receipt")}),
        ),
        step(
            "screen",
            "aixand.agent.read_screen",
            json!({"agent":r("spawn","agent")}),
        ),
    ];
    let result = runner
        .run(
            &wf(
                steps,
                json!({"text":{"type":{"kind":"string"},"value":r("screen","text")}}),
            ),
            Named::new(),
            &scope,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["text"].as_str(), Some("hello�"));
    assert_eq!(
        read(&f, "[w['after_revision'] for w in runtime.waits]"),
        json!([null, 2, null, 2])
    );
    scope.close().await.unwrap();
    assert_eq!(read(&f, "runtime.stops"), json!([]));
}

#[tokio::test]
async fn real_carrier_delivery_between_direct_sends_preserves_wait_boundary() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    Python::attach(|py| {
        f.bind(py)
            .getattr("runtime")
            .unwrap()
            .setattr("inject_carrier", true)
            .unwrap()
    });
    let (scope, runner) = setup(&f, CleanupPolicy::Detach);
    let steps = vec![
        spawn(),
        send(),
        step(
            "carrier_delivery",
            "aixand.agent.inspect",
            json!({"agent":r("spawn","agent")}),
        ),
        step(
            "implicit",
            "aixand.agent.wait",
            json!({"agent":r("spawn","agent")}),
        ),
        step(
            "second",
            "aixand.agent.send",
            json!({"agent":r("spawn","agent"),"text":lit(json!("second direct"))}),
        ),
    ];
    runner
        .run(
            &wf(steps, json!({})),
            Named::new(),
            &scope,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        read(&f, "[w['after_revision'] for w in runtime.waits]"),
        json!([null, 2, 3, 2, 3])
    );
    assert_eq!(read(&f, "len(runtime.inputs)"), json!(3));
    scope.close().await.unwrap();
}

#[tokio::test]
async fn real_sdk_revisionless_receipts_and_foreign_sessions_fail() {
    let _lock = LOCK.lock().await;
    for foreign in [false, true] {
        let f = fixture();
        let (scope, runner) = setup(&f, CleanupPolicy::StopOwned);
        if !foreign {
            Python::attach(|py| {
                f.bind(py)
                    .getattr("runtime")
                    .unwrap()
                    .setattr("no_revision", true)
                    .unwrap()
            });
        }
        let mut steps = vec![spawn(), send()];
        if foreign {
            steps.push(step("other", "aixand.agents.spawn", json!({})));
        } else {
            steps.push(step(
                "implicit",
                "aixand.agent.wait",
                json!({"agent":r("spawn","agent")}),
            ));
        }
        steps.push(step("explicit","aixand.agent.wait",json!({"agent":r(if foreign {"other"}else{"spawn"},"agent"),"after":r("send","receipt")})));
        let error = runner
            .run(
                &wf(steps, json!({})),
                Named::new(),
                &scope,
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "ValueError");
        assert_eq!(error.invocation_id.as_deref(), Some("explicit"));
        scope.close().await.unwrap();
        assert_eq!(
            read(&f, "len(runtime.stops)"),
            json!(if foreign { 2 } else { 1 })
        );
    }
}

#[tokio::test]
async fn real_carrier_snapshots_are_immutable_and_ack_is_explicit() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    let (scope, runner) = setup(&f, CleanupPolicy::Detach);
    let mut path = r("answer", "snapshot");
    path["path"] = json!(["acknowledged_at"]);
    let steps = vec![
        step(
            "mailbox",
            "aixand.messaging.mailbox",
            json!({"address":lit(json!("coordinator"))}),
        ),
        step(
            "job",
            "carrier.message.send",
            json!({"mailbox":r("mailbox","mailbox"),"to":lit(json!("implementer")),"content":lit(json!("task"))}),
        ),
        step(
            "answer",
            "carrier.message.wait_for_reply",
            json!({"mailbox":r("mailbox","mailbox"),"message":r("job","message"),"sender":lit(json!("implementer"))}),
        ),
        step(
            "ack",
            "carrier.message.ack",
            json!({"message":r("answer","message")}),
        ),
        step(
            "inspect",
            "carrier.message.inspect",
            json!({"message":r("answer","message")}),
        ),
        step(
            "decode",
            "carrier.message.decode_json",
            json!({"message":r("answer","message")}),
        ),
    ];
    let mut fresh = r("inspect", "snapshot");
    fresh["path"] = json!(["acknowledged_at"]);
    let outputs = json!({"before":{"type":{"kind":"string","nullable":true},"value":path},"after":{"type":{"kind":"string","nullable":true},"value":fresh},"decoded":{"type":{"kind":"json"},"value":r("decode","data")}});
    let result = runner
        .run_scoped_json(
            &wf(steps, outputs),
            json!({}),
            scope,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"before":null,"after":"later","decoded":{"answer":"done"}})
    );
    assert_eq!(read(&f, "requests.count('/ack')"), json!(1));
}

#[tokio::test]
async fn real_carrier_wait_timeout_is_data_but_reply_timeout_is_failure() {
    let _lock = LOCK.lock().await;
    for reply in [false, true] {
        let f = fixture();
        Python::attach(|py| f.bind(py).setattr("mode", "timeout").unwrap());
        let (scope, runner) = setup(&f, CleanupPolicy::Detach);
        let mut steps = vec![step(
            "mailbox",
            "aixand.messaging.mailbox",
            json!({"address":lit(json!("coordinator"))}),
        )];
        let mut args = json!({"mailbox":r("mailbox","mailbox"),"timeout":lit(json!(0.01)),"poll_interval":lit(json!(0.001))});
        if reply {
            steps.push(step("job","carrier.message.send",json!({"mailbox":r("mailbox","mailbox"),"to":lit(json!("implementer")),"content":lit(json!("task"))})));
            args["message"] = r("job", "message");
        }
        steps.push(step(
            "wait",
            if reply {
                "carrier.message.wait_for_reply"
            } else {
                "carrier.mailbox.wait"
            },
            args,
        ));
        let outputs = if reply {
            json!({})
        } else {
            json!({"status":{"type":{"kind":"string"},"value":r("wait","status")}})
        };
        let result = runner
            .run_scoped_json(
                &wf(steps, outputs),
                json!({}),
                scope,
                CancellationToken::new(),
            )
            .await;
        if reply {
            assert_eq!(result.unwrap_err().code, "TimeoutError");
        } else {
            assert_eq!(result.unwrap(), json!({"status":"timeout"}));
        }
    }
}

#[tokio::test]
async fn real_sdk_uncertain_effect_details_and_owned_cleanup() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    Python::attach(|py| {
        f.bind(py)
            .getattr("runtime")
            .unwrap()
            .setattr("uncertain", true)
            .unwrap()
    });
    let (scope, runner) = setup(&f, CleanupPolicy::StopOwned);
    let steps = vec![
        step(
            "attached",
            "aixand.agents.get",
            json!({"run_id":lit(json!("external"))}),
        ),
        spawn(),
        send(),
    ];
    let failure = runner
        .run_scoped_json(
            &wf(steps, json!({})),
            json!({}),
            scope,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(failure.details.unwrap()["effect_certainty"], "unknown");
    assert_eq!(read(&f, "runtime.stops"), json!(["session1"]));
    assert_eq!(read(&f, "len(runtime.inputs)"), json!(1));
}

#[tokio::test]
async fn real_sdk_partial_setup_failure_retains_run_identity() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    Python::attach(|py| {
        f.bind(py)
            .getattr("runtime")
            .unwrap()
            .setattr("uncertain", true)
            .unwrap()
    });
    let (scope, runner) = setup(&f, CleanupPolicy::StopOwned);
    let steps = vec![step(
        "launch",
        "aixand.agents.spawn",
        json!({"instructions":lit(json!("setup"))}),
    )];
    let failure = runner
        .run_scoped_json(
            &wf(steps, json!({})),
            json!({}),
            scope,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(failure.code, "AgentSetupError");
    assert_eq!(failure.details.unwrap()["run_id"], "run1");
    assert_eq!(read(&f, "runtime.stops"), json!(["session1"]));
}

#[tokio::test]
async fn real_consumer_failure_interrupts_carrier_reply_wait() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    Python::attach(|py| f.bind(py).setattr("mode", "failure").unwrap());
    let (scope, runner) = setup(&f, CleanupPolicy::Detach);
    let steps = vec![
        spawn(),
        step(
            "mailbox",
            "aixand.messaging.mailbox",
            json!({"address":lit(json!("coordinator"))}),
        ),
        step(
            "job",
            "carrier.message.send",
            json!({"mailbox":r("mailbox","mailbox"),"to":lit(json!("implementer")),"content":lit(json!("task"))}),
        ),
        step(
            "answer",
            "carrier.message.wait_for_reply",
            json!({"mailbox":r("mailbox","mailbox"),"message":r("job","message")}),
        ),
    ];
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        runner.run_scoped_json(
            &wf(steps, json!({})),
            json!({}),
            scope,
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.unwrap_err().code, "ConsumerError");
}

#[tokio::test]
async fn repeated_get_retains_handle_state_and_explicit_stop_is_not_repeated() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    let (scope, runner) = setup(&f, CleanupPolicy::StopOwned);
    let steps = vec![
        spawn(),
        step(
            "same",
            "aixand.agents.get",
            json!({"run_id":r("spawn","run_id")}),
        ),
        step(
            "send",
            "aixand.agent.send",
            json!({"agent":r("same","agent"),"text":lit(json!("task"))}),
        ),
        step(
            "wait",
            "aixand.agent.wait",
            json!({"agent":r("spawn","agent")}),
        ),
        step(
            "stop",
            "aixand.agent.stop",
            json!({"agent":r("same","agent"),"force":lit(json!(true))}),
        ),
    ];
    runner
        .run_scoped_json(
            &wf(steps, json!({})),
            json!({}),
            scope,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(read(&f, "len(connection.agents)"), json!(1));
    assert_eq!(
        read(&f, "[w['after_revision'] for w in runtime.waits]"),
        json!([null, 2])
    );
    assert_eq!(read(&f, "runtime.stops"), json!(["session1"]));
}

#[tokio::test]
async fn revisionless_second_send_preserves_prior_eligible_receipt() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    Python::attach(|py| {
        f.bind(py)
            .getattr("runtime")
            .unwrap()
            .setattr("revisionless_second", true)
            .unwrap()
    });
    let (scope, runner) = setup(&f, CleanupPolicy::Detach);
    let steps = vec![
        spawn(),
        send(),
        step(
            "second",
            "aixand.agent.send",
            json!({"agent":r("spawn","agent"),"text":lit(json!("summary"))}),
        ),
        step(
            "wait",
            "aixand.agent.wait",
            json!({"agent":r("spawn","agent")}),
        ),
    ];
    runner
        .run_scoped_json(
            &wf(steps, json!({})),
            json!({}),
            scope,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        read(&f, "[w['after_revision'] for w in runtime.waits]"),
        json!([null, 2, 2])
    );
}

#[tokio::test]
async fn pending_sdk_io_is_cancelled_and_joined_before_scope_close() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    Python::attach(|py| f.bind(py).setattr("mode", "pending").unwrap());
    let (scope, runner) = setup(&f, CleanupPolicy::Detach);
    let cancel = CancellationToken::new();
    let copy = cancel.clone();
    let workflow = wf(
        vec![
            step(
                "mailbox",
                "aixand.messaging.mailbox",
                json!({"address":lit(json!("coordinator"))}),
            ),
            step(
                "pending",
                "carrier.mailbox.wait",
                json!({"mailbox":r("mailbox","mailbox")}),
            ),
        ],
        json!({}),
    );
    let task = tokio::spawn(async move {
        runner
            .run_scoped_json(&workflow, json!({}), scope, copy)
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while read(&f, "pending_entered.is_set()") != json!(true) {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .code,
        "cancelled"
    );
    assert_eq!(
        read(&f, "pending_cancelled.is_set() and connection.closed"),
        json!(true)
    );
}

#[tokio::test]
async fn mailbox_wait_publishes_capabilities_and_reply_is_correlated_without_ack() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    let (scope, runner) = setup(&f, CleanupPolicy::Detach);
    let mut message = r("wait", "messages");
    message["path"] = json!([0]);
    let steps = vec![
        step(
            "mailbox",
            "aixand.messaging.mailbox",
            json!({"address":lit(json!("coordinator"))}),
        ),
        step(
            "wait",
            "carrier.mailbox.wait",
            json!({"mailbox":r("mailbox","mailbox")}),
        ),
        step(
            "reply",
            "carrier.message.reply",
            json!({"message":message,"content":lit(json!("thanks"))}),
        ),
    ];
    runner
        .run_scoped_json(
            &wf(steps, json!({})),
            json!({}),
            scope,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(read(&f, "outgoing[0]['reply_to']"), json!(8));
    assert_eq!(read(&f, "outgoing[0]['to']"), json!("implementer"));
    assert_eq!(read(&f, "requests.count('/ack')"), json!(0));
}

#[tokio::test]
async fn application_execution_requires_host_installation_and_returns_json() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    let scope = Scope::new(CleanupPolicy::StopOwned);
    let mut bindings = BindingRegistry::default();
    let connection = Python::attach(|py| {
        py.import("sys")
            .unwrap()
            .getattr("modules")
            .unwrap()
            .set_item("ir_test_fixture", f.bind(py))
            .unwrap();
        f.bind(py).getattr("connection").unwrap().unbind()
    });
    let config = Config {
        applications: Named::from([(
            "test.plan".into(),
            "ir_test_fixture:installed_application".into(),
        )]),
        ..Config::default()
    };
    install_connection(&scope, &mut bindings, connection, config).unwrap();
    let runner = Runner::new(
        CatalogRegistry::new([parse_catalog(AIXAND_CATALOG).unwrap()]).unwrap(),
        bindings,
    );
    let workflow = wf(
        vec![step(
            "app",
            "aixand.application.run",
            json!({
                "name": lit(json!("test.plan")), "arguments": lit(json!({"generation": "one"}))
            }),
        )],
        json!({"outcome":{"type":{"kind":"json"},"value":r("app","result")}}),
    );
    let result = runner
        .run(&workflow, Named::new(), &scope, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        result["outcome"].to_json().unwrap(),
        json!({"observed":{"generation":"one"},"accepted":true})
    );
    assert_eq!(read(&f, "runtime.inputs"), json!([]));
    scope.close().await.unwrap();
}

#[tokio::test]
async fn portable_application_name_cannot_import_code() {
    let _lock = LOCK.lock().await;
    let f = fixture();
    let (scope, runner) = setup(&f, CleanupPolicy::StopOwned);
    let workflow = wf(
        vec![step(
            "app",
            "aixand.application.run",
            json!({
                "name": lit(json!("os:system")), "arguments": lit(json!({"command":"never run"}))
            }),
        )],
        json!({}),
    );
    let error = runner
        .run(&workflow, Named::new(), &scope, CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, "application_not_installed");
    assert_eq!(read(&f, "runtime.inputs"), json!([]));
    scope.close().await.unwrap();
}
