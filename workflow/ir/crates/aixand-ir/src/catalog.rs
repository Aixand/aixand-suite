use crate::*;
use std::collections::BTreeMap;
use std::sync::Arc;

pub const AIXAND_CATALOG: &str = include_str!("../catalogs/aixand.json");
pub const VERIFIER_CATALOG: &str = include_str!("../catalogs/verifier.json");

#[derive(Clone, Debug, Default)]
pub struct CatalogRegistry {
    definitions: BTreeMap<OperationIdentity, Arc<OperationDefinition>>,
}

impl CatalogRegistry {
    pub fn new(catalogs: impl IntoIterator<Item = Catalog>) -> Result<Self, ValidationError> {
        let mut registry = Self::default();
        for catalog in catalogs {
            registry.add(catalog)?;
        }
        Ok(registry)
    }
    pub fn add(&mut self, catalog: Catalog) -> Result<(), ValidationError> {
        validate_structure(&to_json(&catalog)?, DocumentKind::Catalog)?;
        let mut staged = BTreeMap::new();
        for (i, definition) in catalog.operations.into_iter().enumerate() {
            let location = format!("/operations/{i}");
            validate_definition(&definition, &location)?;
            let identity = definition.identity();
            if self.definitions.contains_key(&identity) || staged.contains_key(&identity) {
                return Err(Diagnostic::error(
                    "duplicate_operation",
                    &location,
                    format!("Conflicting operation {}@{}", identity.id, identity.version),
                )
                .into());
            }
            staged.insert(identity, Arc::new(definition));
        }
        self.definitions.extend(staged);
        Ok(())
    }
    pub fn resolve(&self, identity: &OperationIdentity) -> Option<&Arc<OperationDefinition>> {
        self.definitions.get(identity)
    }
    pub fn definitions(&self) -> impl Iterator<Item = &Arc<OperationDefinition>> {
        self.definitions.values()
    }
}

pub fn validate_definition(
    definition: &OperationDefinition,
    location: &str,
) -> Result<(), ValidationError> {
    for (name, input) in &definition.inputs {
        let path = pointer(&pointer(location, "inputs"), name);
        validate_type(&input.ty, &pointer(&path, "type"))?;
        if let Some(default) = &input.default {
            if input.required {
                return Err(Diagnostic::error(
                    "default",
                    &path,
                    "Required operation inputs cannot have defaults",
                )
                .into());
            }
            validate_value(
                &Value::from_json(default)?,
                &input.ty,
                &pointer(&path, "default"),
            )?;
        }
    }
    for (name, output) in &definition.outputs {
        validate_type(&output.ty, &pointer(&pointer(location, "outputs"), name))?;
    }
    Ok(())
}
