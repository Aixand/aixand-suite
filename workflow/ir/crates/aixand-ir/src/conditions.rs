//! Strict, pure boolean expressions. No truthiness, coercion, user callbacks or I/O.
use crate::{Comparison, Diagnostic, Type, ValidationError, Value};

pub fn boolean_type() -> Type {
    Type::Boolean { nullable: false }
}

fn family(ty: &Type) -> &'static str {
    match ty {
        Type::Null => "null",
        Type::Boolean { .. } => "boolean",
        Type::Integer { .. } | Type::Number { .. } => "number",
        Type::String { .. } => "string",
        _ => "unsupported",
    }
}

pub fn validate_comparison_types(
    operator: Comparison,
    left: &Type,
    right: &Type,
    location: &str,
) -> Result<(), ValidationError> {
    let (a, b) = (family(left), family(right));
    let valid = match operator {
        Comparison::Eq | Comparison::Ne => {
            a != "unsupported" && b != "unsupported" && (a == b || a == "null" || b == "null")
        }
        _ => a == "number" && b == "number" && !left.nullable() && !right.nullable(),
    };
    if valid {
        Ok(())
    } else {
        Err(Diagnostic::error("comparison_type", location,
            format!("{operator:?} cannot compare {left:?} and {right:?}; equality requires matching scalar types (or null), ordering requires non-null numbers")).into())
    }
}

/// Type sufficient for scalar comparison checks; containers cannot be compared.
pub(crate) fn scalar_type(value: &Value) -> Type {
    match value {
        Value::Null => Type::Null,
        Value::Boolean(_) => boolean_type(),
        Value::Integer(_) => Type::Integer { nullable: false },
        Value::Number(_) => Type::Number { nullable: false },
        Value::String(_) => Type::String { nullable: false },
        _ => Type::Json,
    }
}

pub(crate) fn compare_values(
    operator: Comparison,
    left: &Value,
    right: &Value,
    location: &str,
) -> Result<bool, ValidationError> {
    validate_comparison_types(operator, &scalar_type(left), &scalar_type(right), location)?;
    let number = |v: &Value| match v {
        Value::Integer(n) => Some(*n as f64),
        Value::Number(n) => Some(*n),
        _ => None,
    };
    let ordering =
        if let (Some(a), Some(b)) = (number(left), number(right)) {
            Some(a.partial_cmp(&b).ok_or_else(|| {
                Diagnostic::error("number", location, "Nonfinite comparison operand")
            })?)
        } else {
            None
        };
    let equal = ordering.map_or_else(|| left == right, |o| o.is_eq());
    Ok(match operator {
        Comparison::Eq => equal,
        Comparison::Ne => !equal,
        Comparison::Lt => ordering.is_some_and(|o| o.is_lt()),
        Comparison::Le => ordering.is_some_and(|o| o.is_le()),
        Comparison::Gt => ordering.is_some_and(|o| o.is_gt()),
        Comparison::Ge => ordering.is_some_and(|o| o.is_ge()),
    })
}

pub fn require_boolean(value: &Value, location: &str) -> Result<bool, ValidationError> {
    if let Value::Boolean(value) = value {
        Ok(*value)
    } else {
        Err(Diagnostic::error(
            "condition_type",
            location,
            "Condition must evaluate to boolean; truthiness is not supported",
        )
        .into())
    }
}
