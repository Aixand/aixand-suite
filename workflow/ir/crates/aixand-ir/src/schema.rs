use crate::{Diagnostic, ValidationError};
use serde_json::Value;
use std::sync::OnceLock;

pub const WORKFLOW_SCHEMA: &str = include_str!("../schemas/workflow.schema.json");
pub const CATALOG_SCHEMA: &str = include_str!("../schemas/catalog.schema.json");
pub const SHARED_SCHEMA: &str = include_str!("../schemas/shared.schema.json");
pub const WORKFLOW_V02_SCHEMA: &str = include_str!("../schemas/workflow-0.2.schema.json");
pub const SHARED_V02_SCHEMA: &str = include_str!("../schemas/shared-0.2.schema.json");

#[derive(Clone, Copy)]
pub enum DocumentKind {
    Workflow,
    Catalog,
}

pub fn validate_structure(value: &Value, kind: DocumentKind) -> Result<(), ValidationError> {
    crate::validate_json(value)?;
    static WORKFLOW: OnceLock<jsonschema::Validator> = OnceLock::new();
    static WORKFLOW_V02: OnceLock<jsonschema::Validator> = OnceLock::new();
    static CATALOG: OnceLock<jsonschema::Validator> = OnceLock::new();
    let (cell, schema) = match kind {
        DocumentKind::Workflow if value["ir_version"] == "0.2" => {
            (&WORKFLOW_V02, WORKFLOW_V02_SCHEMA)
        }
        DocumentKind::Workflow => (&WORKFLOW, WORKFLOW_SCHEMA),
        DocumentKind::Catalog => (&CATALOG, CATALOG_SCHEMA),
    };
    let validator = cell.get_or_init(|| {
        jsonschema::draft202012::new(
            &serde_json::from_str::<Value>(schema).expect("embedded JSON schema"),
        )
        .expect("valid embedded schema")
    });
    let errors: Vec<_> = validator
        .iter_errors(value)
        .map(|e| Diagnostic::error("schema", &e.instance_path().to_string(), e.to_string()))
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(ValidationError(errors))
    }
}

pub fn parse_workflow(text: &str) -> Result<crate::Workflow, ValidationError> {
    let value = crate::parse_json(text)?;
    validate_structure(&value, DocumentKind::Workflow)?;
    serde_json::from_value(value).map_err(|e| Diagnostic::error("schema", "", e.to_string()).into())
}

pub fn parse_catalog(text: &str) -> Result<crate::Catalog, ValidationError> {
    let value = crate::parse_json(text)?;
    validate_structure(&value, DocumentKind::Catalog)?;
    serde_json::from_value(value).map_err(|e| Diagnostic::error("schema", "", e.to_string()).into())
}
