//! Closed portable records. SDK types and executable handler locations never occur here.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type Named<T> = BTreeMap<String, T>;

fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

// Normalize only contract identifiers. User literals, step names, descriptions,
// and JSON defaults are data and must survive migration byte-for-byte.
fn contract_name<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let name = String::deserialize(d)?;
    Ok(if name == "intessio" {
        "aixand".to_owned()
    } else if let Some(suffix) = name.strip_prefix("intessio.") {
        format!("aixand.{suffix}")
    } else {
        name
    })
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationIdentity {
    #[serde(deserialize_with = "contract_name")]
    pub id: String,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workflow {
    pub ir_version: String,
    pub inputs: Named<WorkflowInput>,
    pub body: Sequence,
    pub outputs: Named<WorkflowOutput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Sequence {
    Sequence { steps: Vec<Step> },
}
impl Sequence {
    pub fn steps(&self) -> &[Step] {
        let Self::Sequence { steps } = self;
        steps
    }
    pub fn steps_mut(&mut self) -> &mut Vec<Step> {
        let Self::Sequence { steps } = self;
        steps
    }
    /// All operations in document order, including unselected arms, for preparation.
    pub fn operations(&self) -> Vec<&Step> {
        let mut result = vec![];
        for step in self.steps() {
            match step {
                Step::Operation { .. } => result.push(step),
                Step::Branch {
                    then, otherwise, ..
                } => {
                    result.extend(then.operations());
                    if let Some(otherwise) = otherwise {
                        result.extend(otherwise.operations());
                    }
                }
            }
        }
        result
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    Operation {
        id: String,
        operation: OperationIdentity,
        inputs: Named<Expression>,
    },
    Branch {
        id: String,
        condition: Expression,
        then: Sequence,
        #[serde(rename = "else", default, skip_serializing_if = "Option::is_none")]
        otherwise: Option<Sequence>,
    },
}
/// Legacy Rust name; serialized operation documents are unchanged.
pub type Operation = Step;
impl Step {
    pub fn id(&self) -> &str {
        match self {
            Self::Operation { id, .. } | Self::Branch { id, .. } => id,
        }
    }
    pub fn identity(&self) -> Option<&OperationIdentity> {
        match self {
            Self::Operation { operation, .. } => Some(operation),
            Self::Branch { .. } => None,
        }
    }
    pub fn inputs(&self) -> Option<&Named<Expression>> {
        match self {
            Self::Operation { inputs, .. } => Some(inputs),
            Self::Branch { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Expression {
    Literal {
        value: Value,
    },
    Ref(Reference),
    Object {
        fields: Named<Expression>,
    },
    Array {
        items: Vec<Expression>,
    },
    Compare {
        operator: Comparison,
        left: Box<Expression>,
        right: Box<Expression>,
    },
    And {
        operands: Vec<Expression>,
    },
    Or {
        operands: Vec<Expression>,
    },
    Not {
        operand: Box<Expression>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Comparison {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reference {
    Input {
        name: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        path: Vec<PathSegment>,
    },
    Step {
        step: String,
        output: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        path: Vec<PathSegment>,
    },
}
impl Reference {
    pub fn path(&self) -> &[PathSegment] {
        match self {
            Self::Input { path, .. } | Self::Step { path, .. } => path,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PathSegment {
    Key(String),
    Index(u64),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowInput {
    #[serde(rename = "type")]
    pub ty: Type,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowOutput {
    #[serde(rename = "type")]
    pub ty: Type,
    pub value: Expression,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationDefinition {
    #[serde(deserialize_with = "contract_name")]
    pub id: String,
    pub version: String,
    pub inputs: Named<OperationInput>,
    pub outputs: Named<OperationOutput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}
impl OperationDefinition {
    pub fn identity(&self) -> OperationIdentity {
        OperationIdentity {
            id: self.id.clone(),
            version: self.version.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationInput {
    #[serde(rename = "type")]
    pub ty: Type,
    pub required: bool,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationOutput {
    #[serde(rename = "type")]
    pub ty: Type,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    pub contract_version: String,
    pub package: Package,
    pub operations: Vec<OperationDefinition>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Package {
    #[serde(deserialize_with = "contract_name")]
    pub id: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Type {
    Null,
    Json,
    Boolean {
        #[serde(default, skip_serializing_if = "is_false")]
        nullable: bool,
    },
    Integer {
        #[serde(default, skip_serializing_if = "is_false")]
        nullable: bool,
    },
    Number {
        #[serde(default, skip_serializing_if = "is_false")]
        nullable: bool,
    },
    String {
        #[serde(default, skip_serializing_if = "is_false")]
        nullable: bool,
    },
    Array {
        items: Box<Type>,
        #[serde(default, skip_serializing_if = "is_false")]
        nullable: bool,
    },
    Object {
        properties: Named<Type>,
        required: Vec<String>,
        #[serde(default, skip_serializing_if = "Additional::is_closed")]
        additional: Additional,
        #[serde(default, skip_serializing_if = "is_false")]
        nullable: bool,
    },
    Opaque {
        #[serde(deserialize_with = "contract_name")]
        id: String,
        version: String,
        #[serde(default, skip_serializing_if = "is_false")]
        nullable: bool,
    },
}
fn is_false(b: &bool) -> bool {
    !b
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Additional {
    Closed(bool),
    Typed(Box<Type>),
}
impl Default for Additional {
    fn default() -> Self {
        Self::Closed(false)
    }
}
impl Additional {
    pub fn is_closed(&self) -> bool {
        matches!(self, Self::Closed(false))
    }
    pub fn ty(&self) -> Option<&Type> {
        match self {
            Self::Typed(t) => Some(t),
            _ => None,
        }
    }
}
