use aixand_ir::*;
use aixand_ir_frontend::*;
use aixand_ir_runner::*;
use serde_json::json;
use tokio_util::sync::CancellationToken;
fn catalog() -> CatalogRegistry {
    CatalogRegistry::new([
        parse_catalog(VERIFIER_CATALOG).unwrap(),
        parse_catalog(AIXAND_CATALOG).unwrap(),
    ])
    .unwrap()
}
fn compile(body: &str) -> Result<Workflow, CompilerError> {
    compile_python(
        &format!("@aixand.workflow\nasync def f(flag: bool, score: float, status: str):\n{body}"),
        "branch.py",
        &catalog(),
        &MappingRegistry::aixand(),
    )
}
#[tokio::test]
async fn hand_authored_python_and_generated_fixtures_agree_and_run_both_paths() {
    let w = compile_python(
        include_str!("../../../examples/branching/workflow.py"),
        "workflow.py",
        &catalog(),
        &MappingRegistry::aixand(),
    )
    .unwrap();
    for source in [
        include_str!("../../../examples/branching/workflow.json"),
        include_str!("../../../examples/branching/generated.json"),
    ] {
        assert_eq!(w, parse_workflow(source).unwrap());
    }
    for (task, expected) in [("a workflow", true), ("a project", false)] {
        let mut bindings = BindingRegistry::default();
        aixand_ir_verifier::register(&mut bindings).unwrap();
        let result = Runner::new(catalog(), bindings)
            .run_json(
                &w,
                json!({"task":task}),
                CleanupPolicy::StopOwned,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result["passed"], expected);
    }
}
#[test]
fn native_if_elif_else_nesting_and_deterministic_ids() {
    let source = "    if flag:\n        await aixand.agents.spawn()\n    elif score >= 0.8:\n        await aixand.agents.spawn()\n    else:\n        await aixand.agents.spawn()\n    await aixand.agents.spawn()\n";
    let w = compile(source).unwrap();
    assert_eq!(w, compile(source).unwrap());
    assert_eq!(w.ir_version, "0.2");
    assert_eq!(
        w.body
            .operations()
            .iter()
            .map(|s| s.id())
            .collect::<Vec<_>>(),
        ["spawn_1", "spawn_2", "spawn_3", "spawn_4"]
    );
    let Step::Branch {
        id,
        otherwise: Some(else_arm),
        ..
    } = &w.body.steps()[0]
    else {
        panic!()
    };
    assert_eq!(id, "branch_1");
    assert!(matches!(&else_arm.steps()[0],Step::Branch{id,..} if id=="branch_2"));
    let simple = compile("    if True:\n        pass\n").unwrap();
    assert!(matches!(
        &simple.body.steps()[0],
        Step::Branch {
            otherwise: None,
            ..
        }
    ));
}
#[test]
fn explicit_condition_syntax_and_properties() {
    for c in [
        "flag",
        "score >= 0.8",
        "score < 2",
        "score <= 2",
        "score > 0",
        "status == 'passed'",
        "status != 'failed'",
        "not flag",
        "flag and score >= 0.8",
        "flag or (not flag and status == 'ok')",
    ] {
        compile(&format!("    if {c}:\n        pass\n")).unwrap();
    }
    let w=compile("    result = await aixand.verifier.verify({'title': 'x', 'body': status, 'labels': []})\n    if result.passed:\n        await aixand.verifier.verify({'title': result.summary, 'body': status, 'labels': []})\n").unwrap();
    assert!(
        matches!(&w.body.steps()[1],Step::Branch{condition:Expression::Ref(Reference::Step{path,..}),..} if path==&vec![PathSegment::Key("passed".into())])
    );
}
#[test]
fn branch_local_values_can_be_used_inside_but_never_implicitly_merged() {
    compile("    if flag:\n        agent = await aixand.agents.spawn()\n        await agent.stop()\n    else:\n        agent = await aixand.agents.spawn()\n        await agent.stop()\n").unwrap();
    for body in [
        "    if flag:\n        agent = await aixand.agents.spawn()\n    await agent.stop()\n",
        "    if flag:\n        value = 'a'\n    else:\n        value = 'b'\n    return value\n",
        "    value = 'before'\n    if flag:\n        value = 'after'\n    return value\n",
        "    if flag:\n        agent = await aixand.agents.spawn()\n    else:\n        await agent.stop()\n",
    ] {
        let e = compile(body).unwrap_err();
        assert!(
            e.diagnostics
                .iter()
                .any(|d| matches!(d.code.as_str(), "branch_result" | "unavailable_value")),
            "{e}"
        );
    }
    compile("    if flag:\n        value = 'local'\n    value = 'fresh'\n    return value\n")
        .unwrap();
}
#[test]
fn unsupported_conditions_and_control_flow_are_source_located() {
    for c in [
        "score",
        "status",
        "flag and status",
        "score + 1 > 0",
        "0 < score < 1",
        "score is None",
        "status in ['x']",
        "bool(status)",
        "(lambda: True)()",
        "await aixand.agents.spawn()",
        "flag.failed",
        "score == 'one'",
    ] {
        let e = compile(&format!("    if {c}:\n        pass\n")).unwrap_err();
        assert_eq!(e.diagnostics[0].source.line, 3, "{e}");
        assert!(e.diagnostics[0].source.column >= 5, "{e}");
        assert!(e.to_string().contains("branch.py:3:"), "{e}");
    }
    for body in [
        "    while flag:\n        pass\n",
        "    for x in []:\n        pass\n",
        "    if flag:\n        return 'early'\n",
        "    try:\n        pass\n    except:\n        pass\n",
    ] {
        assert_eq!(
            compile(body).unwrap_err().diagnostics[0].code,
            "unsupported_statement"
        );
    }
    let e = compile("    if later:\n        pass\n    later = True\n").unwrap_err();
    assert_eq!(e.diagnostics[0].code, "unavailable_value");
}
#[test]
fn literal_conditions_are_not_folded_or_executed_during_compilation() {
    let w = compile("    if False:\n        await aixand.agents.spawn()\n").unwrap();
    assert_eq!(w.body.operations().len(), 1);
    assert!(compile("    if False:\n        print('must still reject this')\n").is_err());
    let source = "@aixand.workflow\nasync def f(flag: bool = (1 == 1)):\n    pass\n";
    assert_eq!(
        lower_python(source, &catalog()).unwrap_err().diagnostics[0].code,
        "default"
    );
}
