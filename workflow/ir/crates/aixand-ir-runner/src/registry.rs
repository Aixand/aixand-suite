use crate::{Failure, Scope};
use aixand_ir::{Named, OperationDefinition, OperationIdentity, Value};
use async_trait::async_trait;
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct InvocationContext {
    pub scope: Scope,
    pub cancellation: CancellationToken,
    pub invocation_id: String,
    pub operation: OperationIdentity,
}

#[async_trait]
pub trait Binding: Send + Sync {
    async fn invoke(
        &self,
        context: InvocationContext,
        inputs: Named<Value>,
    ) -> Result<Named<Value>, Failure>;
}

#[derive(Clone)]
pub(crate) struct Entry {
    pub definition: Arc<OperationDefinition>,
    pub binding: Arc<dyn Binding>,
}

#[derive(Clone, Default)]
pub struct BindingRegistry {
    entries: BTreeMap<OperationIdentity, Entry>,
}
impl BindingRegistry {
    pub fn register(
        &mut self,
        definition: Arc<OperationDefinition>,
        binding: Arc<dyn Binding>,
    ) -> Result<(), Failure> {
        let identity = definition.identity();
        if self.entries.contains_key(&identity) {
            return Err(Failure::new(
                "binding_conflict",
                format!(
                    "Binding already registered for {}@{}",
                    identity.id, identity.version
                ),
            ));
        }
        self.entries.insert(
            identity,
            Entry {
                definition,
                binding,
            },
        );
        Ok(())
    }
    pub(crate) fn resolve(&self, definition: &OperationDefinition) -> Result<Entry, Failure> {
        let entry = self.entries.get(&definition.identity()).ok_or_else(|| {
            Failure::new(
                "missing_binding",
                format!("No binding for {}@{}", definition.id, definition.version),
            )
        })?;
        if entry.definition.as_ref() != definition {
            return Err(Failure::new(
                "incompatible_binding",
                format!(
                    "Binding contract differs for {}@{}",
                    definition.id, definition.version
                ),
            ));
        }
        Ok(entry.clone())
    }
}
