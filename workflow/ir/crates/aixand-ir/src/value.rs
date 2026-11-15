//! Immutable values. Opaque payload storage and resource ownership belong to runners.
use crate::{Diagnostic, Named, ValidationError};
use serde_json::Value as Json;
use std::sync::Arc;

#[derive(Debug)]
struct Atom {
    type_id: String,
    version: String,
}

/// Nominal identity token. Creating a token does not register it in any live scope.
#[derive(Clone, Debug)]
pub struct Opaque(Arc<Atom>);
impl Opaque {
    pub fn new(type_id: impl Into<String>, version: impl Into<String>) -> Self {
        Self(Arc::new(Atom {
            type_id: type_id.into(),
            version: version.into(),
        }))
    }
    pub fn type_id(&self) -> &str {
        &self.0.type_id
    }
    pub fn version(&self) -> &str {
        &self.0.version
    }
    pub fn same_identity(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl PartialEq for Opaque {
    fn eq(&self, other: &Self) -> bool {
        self.same_identity(other)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Boolean(bool),
    Integer(i64),
    Number(f64),
    String(Arc<str>),
    Array(Arc<[Value]>),
    Object(Arc<Named<Value>>),
    Opaque(Opaque),
}

impl Value {
    /// Normalize native publication values to the same domain as parsed JSON.
    /// In particular, integral binary64 values in the safe range are integers.
    pub fn normalized(&self) -> Result<Self, ValidationError> {
        match self {
            Self::Integer(i) if i.unsigned_abs() > crate::MAX_INTEGER as u64 => {
                Err(Diagnostic::error("number", "", "Integer exceeds portable safe range").into())
            }
            Self::Number(n) if !n.is_finite() => {
                Err(Diagnostic::error("number", "", "Nonfinite number").into())
            }
            Self::Number(n) if n.fract() == 0.0 && n.abs() <= crate::MAX_INTEGER as f64 => {
                Ok(Self::Integer(*n as i64))
            }
            Self::Array(items) => Ok(Self::Array(
                items
                    .iter()
                    .map(Self::normalized)
                    .collect::<Result<Vec<_>, _>>()?
                    .into(),
            )),
            Self::Object(fields) => Ok(Self::Object(Arc::new(
                fields
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), v.normalized()?)))
                    .collect::<Result<_, ValidationError>>()?,
            ))),
            _ => Ok(self.clone()),
        }
    }
    pub fn from_json(json: &Json) -> Result<Self, ValidationError> {
        crate::validate_json(json)?;
        Ok(match json {
            Json::Null => Self::Null,
            Json::Bool(b) => Self::Boolean(*b),
            Json::String(s) => Self::String(s.as_str().into()),
            Json::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Self::Integer(i)
                } else {
                    let f = n.as_f64().expect("JSON number");
                    if f.fract() == 0.0 && f.abs() <= crate::MAX_INTEGER as f64 {
                        Self::Integer(f as i64)
                    } else {
                        Self::Number(f)
                    }
                }
            }
            Json::Array(items) => Self::Array(
                items
                    .iter()
                    .map(Self::from_json)
                    .collect::<Result<Vec<_>, _>>()?
                    .into(),
            ),
            Json::Object(fields) => Self::Object(Arc::new(
                fields
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), Self::from_json(v)?)))
                    .collect::<Result<_, ValidationError>>()?,
            )),
        })
    }
    pub fn to_json(&self) -> Result<Json, ValidationError> {
        let value = match self {
            Self::Null => Json::Null,
            Self::Boolean(v) => (*v).into(),
            Self::Integer(v) => (*v).into(),
            Self::Number(v) if v.fract() == 0.0 && v.abs() <= crate::MAX_INTEGER as f64 => {
                (*v as i64).into()
            }
            Self::Number(v) => serde_json::Number::from_f64(*v)
                .map(Json::Number)
                .ok_or_else(|| Diagnostic::error("number", "", "Nonfinite number"))?,
            Self::String(v) => v.as_ref().into(),
            Self::Array(v) => Json::Array(v.iter().map(Self::to_json).collect::<Result<_, _>>()?),
            Self::Object(v) => Json::Object(
                v.iter()
                    .map(|(k, v)| Ok((k.clone(), v.to_json()?)))
                    .collect::<Result<_, ValidationError>>()?,
            ),
            Self::Opaque(_) => {
                return Err(Diagnostic::error(
                    "opaque_serialization",
                    "",
                    "Opaque values require an explicit package export operation",
                )
                .into());
            }
        };
        crate::validate_json(&value)?;
        Ok(value)
    }
    pub fn as_object(&self) -> Option<&Named<Value>> {
        if let Self::Object(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        if let Self::String(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn visit_opaque(
        &self,
        f: &mut impl FnMut(&Opaque) -> Result<(), ValidationError>,
    ) -> Result<(), ValidationError> {
        match self {
            Self::Opaque(v) => f(v)?,
            Self::Array(v) => {
                for item in v.iter() {
                    item.visit_opaque(f)?;
                }
            }
            Self::Object(v) => {
                for item in v.values() {
                    item.visit_opaque(f)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}
