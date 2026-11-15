use aixand_ir::{Named, VERIFIER_CATALOG, Value, parse_catalog};
use aixand_ir_runner::{Binding, BindingRegistry, Failure, InvocationContext};
use async_trait::async_trait;
use std::sync::Arc;

pub fn register(registry: &mut BindingRegistry) -> Result<(), Failure> {
    let catalog = parse_catalog(VERIFIER_CATALOG)?;
    for definition in catalog.operations {
        registry.register(Arc::new(definition), Arc::new(Verifier))?;
    }
    Ok(())
}

struct Verifier;
#[async_trait]
impl Binding for Verifier {
    async fn invoke(
        &self,
        _: InvocationContext,
        inputs: Named<Value>,
    ) -> Result<Named<Value>, Failure> {
        let doc = inputs["document"]
            .as_object()
            .ok_or_else(|| Failure::new("document", "Expected document object"))?;
        let title = doc["title"]
            .as_str()
            .ok_or_else(|| Failure::new("title", "Expected string"))?;
        let body = doc["body"]
            .as_str()
            .ok_or_else(|| Failure::new("body", "Expected string"))?;
        let mut issues = vec![];
        if title.trim().is_empty() {
            issues.push("Document title is empty".to_string());
        }
        if let Some(Value::Array(terms)) = inputs.get("required_terms") {
            for term in terms.iter() {
                let term = term
                    .as_str()
                    .ok_or_else(|| Failure::new("term", "Expected string"))?;
                if !body.contains(term) {
                    issues.push(format!("Missing required term: {term}"));
                }
            }
        }
        let result = serde_json::json!({"passed":issues.is_empty(),"summary":if issues.is_empty() { "Verification passed" } else { "Verification failed" },"issues":issues});
        Ok(Named::from([("result".into(), Value::from_json(&result)?)]))
    }
}
