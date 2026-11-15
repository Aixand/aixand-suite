use aixand_ir::*;
use aixand_ir_runner::*;
use async_trait::async_trait;
use serde_json::{Value as Json, json};
use std::{
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

struct Function<F>(F);
#[async_trait]
impl<F, Fut> Binding for Function<F>
where
    F: Fn(InvocationContext, Named<Value>) -> Fut + Send + Sync,
    Fut: Future<Output = Result<Named<Value>, Failure>> + Send,
{
    async fn invoke(&self, c: InvocationContext, i: Named<Value>) -> Result<Named<Value>, Failure> {
        (self.0)(c, i).await
    }
}
fn catalog(inputs: Json, outputs: Json) -> CatalogRegistry {
    CatalogRegistry::new([parse_catalog(&json!({"contract_version":"0.1","package":{"id":"test","version":"1"},"operations":[{"id":"test.effect","version":"1","inputs":inputs,"outputs":outputs}]}).to_string()).unwrap()]).unwrap()
}
fn workflow(steps: Json, inputs: Json, outputs: Json) -> Workflow {
    parse_workflow(&json!({"ir_version":"0.1","inputs":inputs,"body":{"kind":"sequence","steps":steps},"outputs":outputs}).to_string()).unwrap()
}
fn step(id: &str, inputs: Json) -> Json {
    json!({"kind":"operation","id":id,"operation":{"id":"test.effect","version":"1"},"inputs":inputs})
}
fn make_runner<F, Fut>(catalog: CatalogRegistry, f: F) -> Runner
where
    F: Fn(InvocationContext, Named<Value>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Named<Value>, Failure>> + Send + 'static,
{
    let mut bindings = BindingRegistry::default();
    bindings
        .register(
            catalog.definitions().next().unwrap().clone(),
            Arc::new(Function(f)),
        )
        .unwrap();
    Runner::new(catalog, bindings)
}
async fn json_run(r: &Runner, w: &Workflow) -> Result<Json, Failure> {
    r.run_json(
        w,
        json!({}),
        CleanupPolicy::Detach,
        CancellationToken::new(),
    )
    .await
}

#[tokio::test]
async fn sequence_retains_unused_effects_and_awaits_each_operation() {
    let seen = Arc::new(Mutex::new(vec![]));
    let copy = seen.clone();
    let runner = make_runner(catalog(json!({}), json!({})), move |ctx, _| {
        let copy = copy.clone();
        async move {
            copy.lock()
                .unwrap()
                .push(format!("{} start", ctx.invocation_id));
            tokio::task::yield_now().await;
            copy.lock()
                .unwrap()
                .push(format!("{} end", ctx.invocation_id));
            Ok(Named::new())
        }
    });
    let w = workflow(
        json!([step("one", json!({})), step("two", json!({}))]),
        json!({}),
        json!({}),
    );
    assert_eq!(json_run(&runner, &w).await.unwrap(), json!({}));
    assert_eq!(
        *seen.lock().unwrap(),
        ["one start", "one end", "two start", "two end"]
    );
}

#[tokio::test]
async fn defaults_null_and_omission_are_distinct_and_inputs_are_checked() {
    let seen = Arc::new(Mutex::new(vec![]));
    let copy = seen.clone();
    let runner = make_runner(
        catalog(
            json!({"after":{"type":{"kind":"json"},"required":false},"defaulted":{"type":{"kind":"json"},"required":false,"default":null}}),
            json!({}),
        ),
        move |_, inputs| {
            copy.lock().unwrap().push(inputs);
            async { Ok(Named::new()) }
        },
    );
    let w = workflow(
        json!([
            step("absent", json!({})),
            step("null", json!({"after":{"kind":"literal","value":null}}))
        ]),
        json!({"x":{"type":{"kind":"string"},"default":"default"}}),
        json!({"x":{"type":{"kind":"string"},"value":{"kind":"ref","source":"input","name":"x"}}}),
    );
    assert_eq!(json_run(&runner, &w).await.unwrap(), json!({"x":"default"}));
    {
        let values = seen.lock().unwrap();
        assert!(!values[0].contains_key("after"));
        assert_eq!(values[1]["after"], Value::Null);
        assert_eq!(values[0]["defaulted"], Value::Null);
    }
    for inputs in [json!({"x":1}), json!({"unknown":2})] {
        assert!(
            runner
                .run_json(&w, inputs, CleanupPolicy::Detach, CancellationToken::new())
                .await
                .is_err()
        );
    }
    let required = workflow(
        json!([]),
        json!({"x":{"type":{"kind":"string"}}}),
        json!({}),
    );
    assert!(json_run(&runner, &required).await.is_err());
}

#[tokio::test]
async fn all_bindings_are_prepared_before_effects_and_conflicts_fail() {
    let count = Arc::new(AtomicUsize::new(0));
    let copy = count.clone();
    let cat = catalog(json!({}), json!({}));
    let mut bindings = BindingRegistry::default();
    let definition = cat.definitions().next().unwrap().clone();
    let binding = Arc::new(Function(move |_, _| {
        copy.fetch_add(1, Ordering::SeqCst);
        async { Ok(Named::new()) }
    }));
    bindings
        .register(definition.clone(), binding.clone())
        .unwrap();
    assert!(
        bindings
            .register(definition.clone(), binding.clone())
            .is_err()
    );
    let mut changed = definition.as_ref().clone();
    changed.description = Some("Different contract".into());
    let mut wrong = BindingRegistry::default();
    wrong.register(Arc::new(changed), binding).unwrap();
    let w = workflow(json!([step("one", json!({}))]), json!({}), json!({}));
    assert_eq!(
        json_run(&Runner::new(cat.clone(), wrong), &w)
            .await
            .unwrap_err()
            .code,
        "incompatible_binding"
    );
    assert_eq!(
        json_run(&Runner::new(cat, BindingRegistry::default()), &w)
            .await
            .unwrap_err()
            .code,
        "missing_binding"
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn invalid_outputs_are_never_published_and_stop_later_steps() {
    for outputs in [
        Named::new(),
        Named::from([("value".into(), Value::Boolean(true))]),
        Named::from([
            ("value".into(), Value::Integer(1)),
            ("extra".into(), Value::Null),
        ]),
    ] {
        let count = Arc::new(AtomicUsize::new(0));
        let copy = count.clone();
        let events = Arc::new(Mutex::new(vec![]));
        let ec = events.clone();
        let runner = make_runner(
            catalog(json!({}), json!({"value":{"type":{"kind":"integer"}}})),
            move |_, _| {
                copy.fetch_add(1, Ordering::SeqCst);
                let outputs = outputs.clone();
                async move { Ok(outputs) }
            },
        )
        .with_observer(move |e| ec.lock().unwrap().push(e));
        let w = workflow(
            json!([step("one", json!({})), step("two", json!({}))]),
            json!({}),
            json!({}),
        );
        let failure = json_run(&runner, &w).await.unwrap_err();
        assert_eq!(failure.invocation_id.as_deref(), Some("one"));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, Event::Published { .. }))
        );
    }
}

#[tokio::test]
async fn uncertain_failure_keeps_domain_details_and_is_not_retried() {
    let count = Arc::new(AtomicUsize::new(0));
    let copy = count.clone();
    let runner = make_runner(catalog(json!({}), json!({})), move |_, _| {
        copy.fetch_add(1, Ordering::SeqCst);
        async {
            Err(Failure::new("delivery_uncertain", "Connection lost")
                .with_details(json!({"run_id":"r1","effect_certainty":"unknown"})))
        }
    });
    let w = workflow(
        json!([step("one", json!({})), step("two", json!({}))]),
        json!({}),
        json!({}),
    );
    let error = json_run(&runner, &w).await.unwrap_err();
    assert_eq!(error.details.unwrap()["run_id"], "r1");
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

struct Close {
    count: Arc<AtomicUsize>,
    fail: bool,
}
#[async_trait]
impl Cleanup for Close {
    async fn close(&self, _: CleanupPolicy) -> Result<(), Failure> {
        self.count.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            Err(Failure::new("close", "close failed"))
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn cleanup_preserves_primary_failure_and_runs_once() {
    let count = Arc::new(AtomicUsize::new(0));
    let scope = Scope::default();
    scope
        .register_cleanup(Arc::new(Close {
            count: count.clone(),
            fail: true,
        }))
        .unwrap();
    let runner = make_runner(catalog(json!({}), json!({})), |_, _| async {
        Err(Failure::new("primary", "failed effect"))
    });
    let w = workflow(json!([step("one", json!({}))]), json!({}), json!({}));
    let error = runner
        .run_scoped_json(&w, json!({}), scope.clone(), CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, "primary");
    assert_eq!(error.cleanup_errors.len(), 1);
    assert!(scope.is_closed());
    scope.close().await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn opaque_values_require_registered_live_scope_and_cannot_escape_json() {
    let opaque = json!({"kind":"opaque","id":"test.token","version":"1"});
    let cat = catalog(json!({}), json!({"handle":{"type":opaque}}));
    let count = Arc::new(AtomicUsize::new(0));
    let copy = count.clone();
    let runner = make_runner(cat, move |ctx, _| {
        copy.fetch_add(1, Ordering::SeqCst);
        async move {
            Ok(Named::from([(
                "handle".into(),
                Value::Opaque(ctx.scope.insert("test.token", "1", Arc::new(42))?),
            )]))
        }
    });
    let w = workflow(
        json!([step("one", json!({}))]),
        json!({}),
        json!({"handle":{"type":opaque,"value":{"kind":"ref","source":"step","step":"one","output":"handle"}}}),
    );
    assert_eq!(
        json_run(&runner, &w).await.unwrap_err().code,
        "opaque_boundary"
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let scope = Scope::default();
    let results = runner
        .run(&w, Named::new(), &scope, CancellationToken::new())
        .await
        .unwrap();
    let Value::Opaque(atom) = &results["handle"] else {
        panic!()
    };
    assert_eq!(*scope.get::<i32>(atom).unwrap(), 42);
    assert!(Scope::default().validate_value(&results["handle"]).is_err());
    assert!(
        scope
            .validate_value(&Value::Opaque(Opaque::new("test.token", "1")))
            .is_err()
    );
    scope.close().await.unwrap();
    assert!(scope.get::<i32>(atom).is_err());
}

#[tokio::test]
async fn fabricated_binding_output_is_rejected_even_with_correct_nominal_type() {
    let opaque = json!({"kind":"opaque","id":"test.token","version":"1"});
    let runner = make_runner(
        catalog(json!({}), json!({"handle":{"type":opaque}})),
        |_, _| async {
            Ok(Named::from([(
                "handle".into(),
                Value::Opaque(Opaque::new("test.token", "1")),
            )]))
        },
    );
    let w = workflow(json!([step("one", json!({}))]), json!({}), json!({}));
    assert!(json_run(&runner, &w).await.is_err());
}

#[tokio::test]
async fn background_failure_interrupts_pending_execution() {
    let entered = Arc::new(tokio::sync::Notify::new());
    let copy = entered.clone();
    let runner = make_runner(catalog(json!({}), json!({})), move |_, _| {
        let copy = copy.clone();
        async move {
            copy.notify_one();
            std::future::pending().await
        }
    });
    let scope = Scope::default();
    let sc = scope.clone();
    let w = workflow(json!([step("one", json!({}))]), json!({}), json!({}));
    let task = tokio::spawn(async move {
        runner
            .run(&w, Named::new(), &sc, CancellationToken::new())
            .await
    });
    entered.notified().await;
    scope.report_failure(Failure::new("consumer", "Inbox died"));
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .code,
        "consumer"
    );
    scope.close().await.unwrap();
}

#[tokio::test]
async fn token_cancellation_and_dropped_caller_both_cleanup() {
    for abort in [false, true] {
        let entered = Arc::new(tokio::sync::Notify::new());
        let copy = entered.clone();
        let count = Arc::new(AtomicUsize::new(0));
        let cc = count.clone();
        let runner = make_runner(catalog(json!({}), json!({})), move |ctx, _| {
            let copy = copy.clone();
            let cc = cc.clone();
            async move {
                ctx.scope.register_cleanup(Arc::new(Close {
                    count: cc,
                    fail: false,
                }))?;
                copy.notify_one();
                std::future::pending().await
            }
        });
        let w = workflow(json!([step("one", json!({}))]), json!({}), json!({}));
        let cancel = CancellationToken::new();
        let copy = cancel.clone();
        let task = tokio::spawn(async move {
            runner
                .run_json(&w, json!({}), CleanupPolicy::Detach, copy)
                .await
        });
        entered.notified().await;
        if abort {
            task.abort();
        } else {
            cancel.cancel();
            assert_eq!(task.await.unwrap().unwrap_err().code, "cancelled");
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while count.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn output_paths_are_evaluated_only_after_body_and_enforce_presence() {
    let count = Arc::new(AtomicUsize::new(0));
    let copy = count.clone();
    let runner = make_runner(
        catalog(
            json!({}),
            json!({"items":{"type":{"kind":"array","items":{"kind":"string"}}}}),
        ),
        move |_, _| {
            copy.fetch_add(1, Ordering::SeqCst);
            async { Ok(Named::from([("items".into(), Value::Array(vec![].into()))])) }
        },
    );
    let w = workflow(
        json!([step("one", json!({})), step("two", json!({}))]),
        json!({}),
        json!({"x":{"type":{"kind":"string"},"value":{"kind":"ref","source":"step","step":"one","output":"items","path":[0]}}}),
    );
    assert!(json_run(&runner, &w).await.is_err());
    assert_eq!(count.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn missing_later_binding_is_detected_before_first_effect() {
    let mut catalog=parse_catalog(&json!({"contract_version":"0.1","package":{"id":"test","version":"1"},"operations":[{"id":"test.effect","version":"1","inputs":{},"outputs":{}},{"id":"test.later","version":"1","inputs":{},"outputs":{}}]}).to_string()).unwrap();
    let first = Arc::new(catalog.operations.remove(0));
    catalog.operations.insert(0, first.as_ref().clone());
    let mut bindings = BindingRegistry::default();
    bindings
        .register(
            first,
            Arc::new(Function(|_, _| async {
                panic!("preflight must prevent execution")
            })),
        )
        .unwrap();
    let runner = Runner::new(CatalogRegistry::new([catalog]).unwrap(), bindings);
    let mut later = step("later", json!({}));
    later["operation"]["id"] = json!("test.later");
    let w = workflow(
        json!([step("first", json!({})), later]),
        json!({}),
        json!({}),
    );
    assert_eq!(
        json_run(&runner, &w).await.unwrap_err().code,
        "missing_binding"
    );
}

#[tokio::test]
async fn binding_panics_still_cleanup_and_preserve_invocation_context() {
    let count = Arc::new(AtomicUsize::new(0));
    let copy = count.clone();
    let runner = make_runner(catalog(json!({}), json!({})), move |ctx, _| {
        let copy = copy.clone();
        async move {
            ctx.scope.register_cleanup(Arc::new(Close {
                count: copy,
                fail: false,
            }))?;
            panic!("broken binding")
        }
    });
    let w = workflow(json!([step("one", json!({}))]), json!({}), json!({}));
    let error = json_run(&runner, &w).await.unwrap_err();
    assert_eq!(error.code, "binding_panic");
    assert_eq!(error.invocation_id.as_deref(), Some("one"));
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn preparation_failure_closes_an_already_configured_scope() {
    let count = Arc::new(AtomicUsize::new(0));
    let scope = Scope::default();
    scope
        .register_cleanup(Arc::new(Close {
            count: count.clone(),
            fail: false,
        }))
        .unwrap();
    let runner = Runner::new(catalog(json!({}), json!({})), BindingRegistry::default());
    let w = workflow(json!([step("one", json!({}))]), json!({}), json!({}));
    assert_eq!(
        runner
            .run_scoped_json(&w, json!({}), scope, CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        "missing_binding"
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn native_integral_floats_use_the_same_integer_representation_between_bindings() {
    let runner = make_runner(
        catalog(
            json!({"input":{"type":{"kind":"integer"},"required":false}}),
            json!({"value":{"type":{"kind":"integer"}}}),
        ),
        |ctx, inputs| async move {
            if ctx.invocation_id == "second" {
                assert_eq!(inputs["input"], Value::Integer(1));
            }
            Ok(Named::from([("value".into(), Value::Number(1.0))]))
        },
    );
    let w = workflow(
        json!([
            step(
                "first",
                json!({"input":{"kind":"ref","source":"input","name":"native"}})
            ),
            step(
                "second",
                json!({"input":{"kind":"ref","source":"step","step":"first","output":"value"}})
            )
        ]),
        json!({"native":{"type":{"kind":"integer"}}}),
        json!({"result":{"type":{"kind":"integer"},"value":{"kind":"ref","source":"step","step":"second","output":"value"}}}),
    );
    let scope = Scope::default();
    let result = runner
        .run(
            &w,
            Named::from([("native".into(), Value::Number(1.0))]),
            &scope,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result["result"], Value::Integer(1));
    assert_eq!(Value::Number(1.0).to_json().unwrap(), json!(1));
    scope.close().await.unwrap();
}
