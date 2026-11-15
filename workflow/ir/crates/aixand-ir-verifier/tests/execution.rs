use aixand_ir::*;
use aixand_ir_runner::*;
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn independent_package_accepts_constructed_payload_and_returns_typed_result() {
    let workflow = parse_workflow(include_str!("../../../examples/verifier.json")).unwrap();
    let catalogs = CatalogRegistry::new([parse_catalog(VERIFIER_CATALOG).unwrap()]).unwrap();
    let mut bindings = BindingRegistry::default();
    aixand_ir_verifier::register(&mut bindings).unwrap();
    let runner = Runner::new(catalogs, bindings);
    for (body, passed) in [("A workflow", true), ("No term", false)] {
        let result = runner
            .run_json(
                &workflow,
                json!({"title":"Review","body":body,"label":"custom"}),
                CleanupPolicy::Detach,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result["result"]["passed"], passed);
        assert_eq!(
            result["result"]["issues"].as_array().unwrap().is_empty(),
            passed
        );
    }
}
