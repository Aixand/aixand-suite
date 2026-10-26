//! Python spellings and binding conventions, separate from portable contracts
//! and runtime implementations. No imports or executable handlers live here.
use aixand_ir::*;
use serde::{Deserialize, Serialize};

pub const PYTHON_MAPPINGS: &str = include_str!("../mappings/aixand.json");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receiver {
    pub port: String,
    pub id: String,
    pub version: String,
}
impl Receiver {
    pub fn ty(&self) -> Type {
        Type::Opaque {
            id: self.id.clone(),
            version: self.version.clone(),
            nullable: false,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublishedProperty {
    pub output: String,
    #[serde(default)]
    pub path: Vec<PathSegment>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationMapping {
    /// Qualified function spelling, or a simple method name with a receiver.
    pub python: String,
    pub operation: OperationIdentity,
    /// Select an exact newer contract when a named keyword is supplied.
    /// Calls omitting that keyword retain the original published contract.
    #[serde(default, skip_serializing_if = "Named::is_empty")]
    pub keyword_operations: Named<OperationIdentity>,
    #[serde(default)]
    pub receiver: Option<Receiver>,
    /// Ordered Python positional ports. Other catalog ports are keyword-only.
    #[serde(default)]
    pub positional: Vec<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub properties: Named<PublishedProperty>,
}

#[derive(Clone, Debug)]
pub struct MappingRegistry(pub(crate) Vec<OperationMapping>);
impl MappingRegistry {
    pub fn from_json(text: &str) -> Result<Self, ValidationError> {
        let mappings: Vec<OperationMapping> = serde_json::from_value(parse_json(text)?)
            .map_err(|e| Diagnostic::error("frontend_metadata", "", e.to_string()))?;
        let mut seen = std::collections::BTreeSet::new();
        for mapping in &mappings {
            let key = (
                mapping.python.clone(),
                mapping
                    .receiver
                    .as_ref()
                    .map(|r| (r.id.clone(), r.version.clone())),
            );
            if !seen.insert(key) {
                return Err(Diagnostic::error(
                    "frontend_metadata",
                    "",
                    "Duplicate Python API mapping",
                )
                .into());
            }
        }
        Ok(Self(mappings))
    }
    pub fn aixand() -> Self {
        Self::from_json(PYTHON_MAPPINGS).expect("bundled frontend metadata")
    }
    pub(crate) fn reserves(&self, name: &str) -> bool {
        (name == "aixand" || name == "intessio")
            || self
                .0
                .iter()
                .any(|m| m.receiver.is_none() && m.python.split('.').next() == Some(name))
    }
}

impl OperationMapping {
    pub(crate) fn validate(&self, definition: &OperationDefinition) -> Result<(), String> {
        let mut seen = std::collections::BTreeSet::new();
        if let Some(receiver) = &self.receiver {
            let port = definition
                .inputs
                .get(&receiver.port)
                .ok_or("Receiver port is missing")?;
            if port.ty != receiver.ty() || !port.required {
                return Err("Receiver must match a required nominal opaque catalog input".into());
            }
            seen.insert(&receiver.port);
        }
        for port in &self.positional {
            if !definition.inputs.contains_key(port) || !seen.insert(port) {
                return Err(format!("Invalid or repeated positional port {port:?}"));
            }
        }
        if let Some(result) = &self.result {
            if !definition.outputs.contains_key(result) {
                return Err(format!("Unknown result output {result:?}"));
            }
        } else if !self.properties.is_empty() {
            return Err("Properties require an assignable result".into());
        }
        for property in self.properties.values() {
            property.ty(definition)?;
        }
        Ok(())
    }
}
impl PublishedProperty {
    pub(crate) fn ty(&self, definition: &OperationDefinition) -> Result<Type, String> {
        let mut ty = &definition
            .outputs
            .get(&self.output)
            .ok_or_else(|| format!("Unknown property output {:?}", self.output))?
            .ty;
        for segment in &self.path {
            match (ty, segment) {
                (Type::Object { properties, required, nullable: false, .. }, PathSegment::Key(key)) if required.contains(key) => {
                    ty = properties.get(key).ok_or("Unknown property path")?;
                }
                _ => return Err("Published properties must follow guaranteed object fields; opaque traversal is forbidden".into()),
            }
        }
        Ok(ty.clone())
    }
}
