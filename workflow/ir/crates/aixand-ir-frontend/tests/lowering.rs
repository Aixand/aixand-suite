use aixand_ir::*;
use aixand_ir_frontend::lower_python;
fn catalogs() -> CatalogRegistry {
    CatalogRegistry::new([parse_catalog(AIXAND_CATALOG).unwrap()]).unwrap()
}
const SOURCE: &str = "import aixand\n@aixand.workflow\nasync def research(task: str):\n    agent = await aixand.agents.spawn(provider=\"codex\", profile=\"research\")\n    await agent.send(task)\n    await agent.wait()\n    await agent.send(\"Summarize your findings\")\n    await agent.wait()\n";

#[test]
fn faithful_implicit_lowering_matches_hand_authored_document() {
    let mut lowered = lower_python(SOURCE, &catalogs()).unwrap();
    let expected =
        parse_workflow(include_str!("../../../examples/research-implicit.json")).unwrap();
    lowered.name = expected.name.clone();
    assert_eq!(lowered, expected);
    assert!(lowered.outputs.is_empty());
    for step in lowered.body.steps() {
        if step.identity().unwrap().id == "aixand.agent.wait" {
            assert!(!step.inputs().unwrap().contains_key("after"));
        }
    }
}

#[test]
fn explicit_receipts_null_and_stable_public_outputs_are_lowered() {
    let source = "import aixand\n@aixand.workflow\nasync def research(task: str) -> str:\n    agent = await aixand.agents.spawn()\n    receipt = await agent.send(task)\n    await agent.wait(after=receipt)\n    await agent.wait(after=None)\n    return agent.run_id\n";
    let w = lower_python(source, &catalogs()).unwrap();
    assert!(matches!(
        w.body.steps()[2].inputs().unwrap()["after"],
        Expression::Ref(_)
    ));
    assert!(matches!(
        w.body.steps()[3].inputs().unwrap()["after"],
        Expression::Literal {
            value: serde_json::Value::Null
        }
    ));
    assert!(
        matches!(&w.outputs["result"].value,Expression::Ref(Reference::Step { output,.. }) if output=="run_id")
    );
}

#[test]
fn unsupported_code_and_cleanup_scopes_are_rejected_without_execution() {
    for source in [
        "import os\nos.remove('file')",
        "import aixand\n@aixand.workflow\nasync def f(task: str):\n    if task:\n        await aixand.agents.spawn()",
        "import aixand\n@aixand.workflow\nasync def f(task: str):\n    async with aixand.connect():\n        await aixand.agents.spawn()",
        "import aixand\n@aixand.workflow\nasync def f(task: str):\n    agent = aixand.agents.spawn()",
        "import aixand\n@aixand.workflow\nasync def f(task: str):\n    return task\n    await aixand.agents.spawn()",
        "import aixand\n@aixand.workflow\nasync def f(task: str):\n    agent = await aixand.agents.spawn(connection=task)",
    ] {
        assert!(lower_python(source, &catalogs()).is_err(), "{source}");
    }
}
