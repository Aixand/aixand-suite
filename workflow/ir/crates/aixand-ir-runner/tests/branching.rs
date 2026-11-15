use aixand_ir::*;
use aixand_ir_runner::*;
use async_trait::async_trait;
use serde_json::{Value as Json, json};
use std::{
    future::Future,
    sync::{Arc, Mutex},
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
fn catalog() -> CatalogRegistry {
    CatalogRegistry::new([parse_catalog(&json!({"contract_version":"0.1","package":{"id":"test","version":"1"},"operations":[{"id":"test.effect","version":"1","inputs":{},"outputs":{"passed":{"type":{"kind":"boolean"}}}}]}).to_string()).unwrap()]).unwrap()
}
fn op(id: &str) -> Json {
    json!({"kind":"operation","id":id,"operation":{"id":"test.effect","version":"1"},"inputs":{}})
}
fn seq(steps: Vec<Json>) -> Json {
    json!({"kind":"sequence","steps":steps})
}
fn branch(id: &str, condition: Json, then: Vec<Json>, otherwise: Vec<Json>) -> Json {
    json!({"kind":"branch","id":id,"condition":condition,"then":seq(then),"else":seq(otherwise)})
}
fn literal(value: bool) -> Json {
    json!({"kind":"literal","value":value})
}
fn document(steps: Vec<Json>) -> Workflow {
    parse_workflow(
        &json!({"ir_version":"0.2","inputs":{},"body":seq(steps),"outputs":{}}).to_string(),
    )
    .unwrap()
}
fn fixture() -> Workflow {
    document(vec![
        op("check"),
        branch(
            "branch_1",
            json!({"kind":"ref","source":"step","step":"check","output":"passed"}),
            vec![op("yes"), op("yes_again")],
            vec![op("no")],
        ),
        op("after"),
    ])
}
fn output(value: bool) -> Named<Value> {
    Named::from([("passed".into(), Value::Boolean(value))])
}
fn runner<F, Fut>(f: F) -> Runner
where
    F: Fn(InvocationContext, Named<Value>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Named<Value>, Failure>> + Send + 'static,
{
    let catalog = catalog();
    let mut bindings = BindingRegistry::default();
    bindings
        .register(
            catalog.definitions().next().unwrap().clone(),
            Arc::new(Function(f)),
        )
        .unwrap();
    Runner::new(catalog, bindings)
}
#[tokio::test]
async fn evaluates_once_executes_only_selected_arm_in_order_and_emits_authoritative_events() {
    for result in [true, false] {
        let seen = Arc::new(Mutex::new(vec![]));
        let recorded = seen.clone();
        let events = Arc::new(Mutex::new(vec![]));
        let observed = events.clone();
        let r = runner(move |c, _| {
            let recorded = recorded.clone();
            async move {
                recorded
                    .lock()
                    .unwrap()
                    .push(format!("{} start", c.invocation_id));
                tokio::task::yield_now().await;
                recorded
                    .lock()
                    .unwrap()
                    .push(format!("{} end", c.invocation_id));
                Ok(output(result))
            }
        })
        .with_observer(move |e| observed.lock().unwrap().push(e));
        r.run_json(
            &fixture(),
            json!({}),
            CleanupPolicy::Detach,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let expected = if result {
            vec!["check", "yes", "yes_again", "after"]
        } else {
            vec!["check", "no", "after"]
        };
        assert_eq!(
            *seen.lock().unwrap(),
            expected
                .iter()
                .flat_map(|id| [format!("{id} start"), format!("{id} end")])
                .collect::<Vec<_>>()
        );
        let events = events.lock().unwrap();
        let branches = events
            .iter()
            .filter_map(|e| {
                if let Event::BranchEvaluated {
                    invocation,
                    result,
                    selected,
                } = e
                {
                    Some((invocation.as_str(), *result, *selected))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        assert_eq!(
            branches,
            [(
                "branch_1",
                result,
                if result {
                    BranchArm::Then
                } else {
                    BranchArm::Else
                }
            )]
        );
        assert!(matches!(events[0], Event::Prepared { .. }));
        assert!(matches!(events[3], Event::BranchEvaluated { .. }));
        assert!(matches!(events.last(), Some(Event::Completed)));
        assert_eq!(
            events
                .iter()
                .filter_map(|e| if let Event::Started { invocation, .. } = e {
                    Some(invocation.as_str())
                } else {
                    None
                })
                .collect::<Vec<_>>(),
            expected
        );
    }
}
#[tokio::test]
async fn nested_and_missing_else_execute_without_merging_values() {
    let mut optional = branch("optional", literal(false), vec![op("skipped")], vec![]);
    optional.as_object_mut().unwrap().remove("else");
    let w = document(vec![
        branch(
            "outer",
            literal(true),
            vec![branch(
                "inner",
                literal(false),
                vec![op("wrong")],
                vec![op("right")],
            )],
            vec![op("other")],
        ),
        optional,
        op("after"),
    ]);
    let seen = Arc::new(Mutex::new(vec![]));
    let recorded = seen.clone();
    runner(move |c, _| {
        recorded.lock().unwrap().push(c.invocation_id);
        async { Ok(output(true)) }
    })
    .run_json(
        &w,
        json!({}),
        CleanupPolicy::Detach,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(*seen.lock().unwrap(), ["right", "after"]);
}
struct Close(Arc<Mutex<Vec<String>>>, &'static str, bool);
#[async_trait]
impl Cleanup for Close {
    async fn close(&self, policy: CleanupPolicy) -> Result<(), Failure> {
        assert_eq!(policy, CleanupPolicy::StopOwned);
        self.0.lock().unwrap().push(self.1.into());
        if self.2 {
            Err(Failure::new("close_failure", "cleanup failed"))
        } else {
            Ok(())
        }
    }
}
#[tokio::test]
async fn selected_failure_stops_sequence_and_cleans_branch_owned_resources_once() {
    let closed = Arc::new(Mutex::new(vec![]));
    let records = closed.clone();
    let events = Arc::new(Mutex::new(vec![]));
    let observed = events.clone();
    let r = runner(move |c, _| {
        let records = records.clone();
        async move {
            match c.invocation_id.as_str() {
                "check" => c
                    .scope
                    .register_cleanup(Arc::new(Close(records, "before", false)))?,
                "yes" => {
                    c.scope
                        .register_cleanup(Arc::new(Close(records, "inside", true)))?;
                    return Err(Failure::new("operation_failed", "selected failure"));
                }
                _ => panic!("later or unselected operation executed"),
            }
            Ok(output(true))
        }
    })
    .with_observer(move |e| observed.lock().unwrap().push(e));
    let failure = r
        .run_json(
            &fixture(),
            json!({}),
            CleanupPolicy::StopOwned,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(failure.code, "operation_failed");
    assert_eq!(failure.invocation_id.as_deref(), Some("yes"));
    assert!(!failure.cleanup_errors.is_empty());
    assert_eq!(*closed.lock().unwrap(), ["inside", "before"]);
    let events = events.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, Event::Failed { .. }))
            .count(),
        1
    );
    assert!(!events.iter().any(|e| matches!(e, Event::Completed)));
}
#[tokio::test]
async fn cancellation_inside_selected_arm_joins_cleanup_and_skips_continuation() {
    let token = CancellationToken::new();
    let cancel = token.clone();
    let closed = Arc::new(Mutex::new(vec![]));
    let records = closed.clone();
    let r = runner(move |c, _| {
        let records = records.clone();
        let cancel = cancel.clone();
        async move {
            if c.invocation_id == "yes" {
                c.scope
                    .register_cleanup(Arc::new(Close(records, "inside", false)))?;
                cancel.cancel();
                std::future::pending::<()>().await;
            }
            assert_eq!(c.invocation_id, "check");
            Ok(output(true))
        }
    });
    let error = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        r.run_json(&fixture(), json!({}), CleanupPolicy::StopOwned, token),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert_eq!(error.invocation_id.as_deref(), Some("yes"));
    assert_eq!(*closed.lock().unwrap(), ["inside"]);
}
#[tokio::test]
async fn boolean_short_circuit_and_condition_failure_are_runtime_checked() {
    let mut w = document(vec![branch(
        "choice",
        json!({"kind":"or","operands":[literal(true),{"kind":"ref","source":"input","name":"flags","path":["optional"]}]}),
        vec![op("yes")],
        vec![op("no")],
    )]);
    w.inputs.insert(
        "flags".into(),
        WorkflowInput {
            ty: Type::Object {
                properties: Named::from([("optional".into(), boolean_type())]),
                required: vec![],
                additional: Additional::default(),
                nullable: false,
            },
            default: None,
            description: None,
        },
    );
    let r = runner(|c, _| async move {
        assert_eq!(c.invocation_id, "yes");
        Ok(output(true))
    });
    r.run_json(
        &w,
        json!({"flags":{}}),
        CleanupPolicy::Detach,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let Step::Branch {
        condition: Expression::Or { operands },
        ..
    } = &mut w.body.steps_mut()[0]
    else {
        panic!()
    };
    operands[0] = serde_json::from_value(literal(false)).unwrap();
    let e = r
        .run_json(
            &w,
            json!({"flags":{}}),
            CleanupPolicy::Detach,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(e.invocation_id.as_deref(), Some("choice"));
}
#[tokio::test]
async fn unselected_bindings_are_preflighted_before_any_effects() {
    let w = document(vec![branch(
        "choice",
        literal(false),
        vec![op("never")],
        vec![],
    )]);
    let error = Runner::new(catalog(), BindingRegistry::default())
        .run_json(
            &w,
            json!({}),
            CleanupPolicy::Detach,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "missing_binding");
}
