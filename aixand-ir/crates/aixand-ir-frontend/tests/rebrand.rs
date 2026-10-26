use aixand_ir::*;
use aixand_ir_frontend::lower_python;

#[test]
fn old_python_workflows_compile_without_changing_literal_content() {
    let catalogs = CatalogRegistry::new([parse_catalog(AIXAND_CATALOG).unwrap()]).unwrap();
    let source = "import intessio\n@intessio.workflow\nasync def f() -> str:\n    agent = await intessio.agents.spawn()\n    return 'intessio.agents.spawn'\n";
    let workflow = lower_python(source, &catalogs).unwrap();
    assert_eq!(
        workflow.body.operations()[0].identity().unwrap().id,
        "aixand.agents.spawn"
    );
    assert_eq!(
        workflow.outputs["result"].value,
        Expression::Literal {
            value: serde_json::json!("intessio.agents.spawn")
        }
    );
}
