use aixand_ir::*;
use serde_json::json;

#[test]
fn legacy_contracts_migrate_without_rewriting_user_data() {
    let source = json!({
        "ir_version": "0.1", "name": "intessio.my-workflow",
        "inputs": {"task": {"type": {"kind": "string"}, "default": "intessio.agents.spawn"}},
        "body": {"kind": "sequence", "steps": [{
            "kind": "operation", "id": "intessio_step",
            "operation": {"id": "intessio.agents.spawn", "version": "1.0.0"},
            "inputs": {"instructions": {"kind": "literal", "value": {"id": "intessio.agent"}}}
        }]},
        "outputs": {"agent": {"type": {"kind": "opaque", "id": "intessio.agent", "version": "1"},
            "value": {"kind": "ref", "source": "step", "step": "intessio_step", "output": "agent"}}}
    });
    let workflow = parse_workflow(&source.to_string()).unwrap();
    let migrated = serde_json::to_value(workflow).unwrap();
    assert_eq!(
        migrated["body"]["steps"][0]["operation"]["id"],
        "aixand.agents.spawn"
    );
    assert_eq!(migrated["outputs"]["agent"]["type"]["id"], "aixand.agent");
    assert_eq!(migrated["name"], source["name"]);
    assert_eq!(migrated["inputs"], source["inputs"]);
    assert_eq!(migrated["body"]["steps"][0]["id"], "intessio_step");
    assert_eq!(
        migrated["body"]["steps"][0]["inputs"],
        source["body"]["steps"][0]["inputs"]
    );
    assert_eq!(
        migrated["outputs"]["agent"]["value"],
        source["outputs"]["agent"]["value"]
    );
}

#[test]
fn legacy_catalog_resolves_to_current_contracts() {
    let legacy = AIXAND_CATALOG.replace("aixand", "intessio");
    let catalog = parse_catalog(&legacy).unwrap();
    assert_eq!(catalog.package.id, "aixand");
    let registry = CatalogRegistry::new([catalog]).unwrap();
    assert!(
        registry
            .resolve(&OperationIdentity {
                id: "aixand.agents.spawn".into(),
                version: "1.0.0".into()
            })
            .is_some()
    );
}
