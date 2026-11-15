use aixand_ir::{CatalogRegistry, Named, Value, parse_catalog, parse_workflow};
use aixand_ir_runner::{
    Binding, BindingRegistry, CleanupPolicy, Failure, InvocationContext, Runner, Scope,
};
use async_trait::async_trait;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

struct Effect(Arc<AtomicUsize>);
#[async_trait]
impl Binding for Effect {
    async fn invoke(&self, _: InvocationContext, _: Named<Value>) -> Result<Named<Value>, Failure> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Named::new())
    }
}

#[tokio::test]
async fn preflight_uses_runtime_validation_without_invoking_bindings() {
    let catalog = parse_catalog(&json!({"contract_version":"0.1","package":{"id":"test","version":"1"},"operations":[{
        "id":"test.effect","version":"1","inputs":{"name":{"type":{"kind":"string"},"required":true}},"outputs":{}
    }]}).to_string()).unwrap();
    let catalogs = CatalogRegistry::new([catalog]).unwrap();
    let workflow = parse_workflow(&json!({"ir_version":"0.1","inputs":{"name":{"type":{"kind":"string"}}},"outputs":{},"body":{"kind":"sequence","steps":[{
        "kind":"operation","id":"effect","operation":{"id":"test.effect","version":"1"},"inputs":{"name":{"kind":"ref","source":"input","name":"name"}}
    }]}}).to_string()).unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let mut bindings = BindingRegistry::default();
    bindings
        .register(
            catalogs.definitions().next().unwrap().clone(),
            Arc::new(Effect(count.clone())),
        )
        .unwrap();
    let runner = Runner::new(catalogs.clone(), bindings);
    let scope = Scope::new(CleanupPolicy::Detach);
    runner
        .preflight_json(&workflow, &json!({"name":"valid"}), &scope)
        .unwrap();
    for inputs in [
        json!({}),
        json!({"name":7}),
        json!({"name":"valid","extra":true}),
        json!([]),
    ] {
        assert!(runner.preflight_json(&workflow, &inputs, &scope).is_err());
    }
    let missing = Runner::new(catalogs, BindingRegistry::default());
    assert_eq!(
        missing
            .preflight_json(&workflow, &json!({"name":"valid"}), &scope)
            .unwrap_err()
            .code,
        "missing_binding"
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
    scope.close().await.unwrap();
}
