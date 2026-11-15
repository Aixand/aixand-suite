use crate::{Additional, Diagnostic, Type, ValidationError, Value, pointer};

impl Type {
    pub fn nullable(&self) -> bool {
        match self {
            Self::Null | Self::Json => true,
            Self::Boolean { nullable }
            | Self::Integer { nullable }
            | Self::Number { nullable }
            | Self::String { nullable }
            | Self::Array { nullable, .. }
            | Self::Object { nullable, .. }
            | Self::Opaque { nullable, .. } => *nullable,
        }
    }
    pub fn non_null(&self) -> Self {
        let mut t = self.clone();
        match &mut t {
            Self::Boolean { nullable }
            | Self::Integer { nullable }
            | Self::Number { nullable }
            | Self::String { nullable }
            | Self::Array { nullable, .. }
            | Self::Object { nullable, .. }
            | Self::Opaque { nullable, .. } => *nullable = false,
            _ => {}
        }
        t
    }
    pub fn json_only(&self) -> bool {
        match self {
            Self::Opaque { .. } => false,
            Self::Array { items, .. } => items.json_only(),
            Self::Object {
                properties,
                additional,
                ..
            } => {
                properties.values().all(Self::json_only)
                    && additional.ty().is_none_or(Self::json_only)
            }
            _ => true,
        }
    }
}

/// Directional compatibility: every value of `source` is accepted by `target`.
pub fn compatible(source: &Type, target: &Type) -> bool {
    if matches!(target, Type::Json) {
        return source.json_only();
    }
    if matches!(source, Type::Null) {
        return target.nullable();
    }
    if source.nullable() && !target.nullable() {
        return false;
    }
    match (source, target) {
        (Type::Integer { .. }, Type::Number { .. }) => true,
        (Type::Boolean { .. }, Type::Boolean { .. })
        | (Type::Integer { .. }, Type::Integer { .. })
        | (Type::Number { .. }, Type::Number { .. })
        | (Type::String { .. }, Type::String { .. }) => true,
        (
            Type::Opaque {
                id: a, version: av, ..
            },
            Type::Opaque {
                id: b, version: bv, ..
            },
        ) => a == b && av == bv,
        (Type::Array { items: a, .. }, Type::Array { items: b, .. }) => compatible(a, b),
        (
            Type::Object {
                properties: sp,
                required: sr,
                additional: sa,
                ..
            },
            Type::Object {
                properties: tp,
                required: tr,
                additional: ta,
                ..
            },
        ) => {
            tr.iter().all(|k| sr.contains(k))
                && sp.iter().all(|(k, s)| {
                    tp.get(k)
                        .or_else(|| ta.ty())
                        .is_some_and(|t| compatible(s, t))
                })
                && tp
                    .iter()
                    .all(|(k, t)| sp.contains_key(k) || sa.ty().is_none_or(|s| compatible(s, t)))
                && sa
                    .ty()
                    .is_none_or(|s| ta.ty().is_some_and(|t| compatible(s, t)))
        }
        _ => false,
    }
}

pub fn validate_type(ty: &Type, location: &str) -> Result<(), ValidationError> {
    match ty {
        Type::Object {
            properties,
            required,
            additional,
            ..
        } => {
            let mut seen = std::collections::BTreeSet::new();
            for k in required {
                if !properties.contains_key(k) || !seen.insert(k) {
                    return Err(Diagnostic::error(
                        "type_descriptor",
                        location,
                        format!("Required property {k:?} is undeclared or repeated"),
                    )
                    .into());
                }
            }
            for (k, t) in properties {
                validate_type(t, &pointer(&pointer(location, "properties"), k))?;
            }
            match additional {
                Additional::Closed(true) => {
                    return Err(Diagnostic::error(
                        "type_descriptor",
                        location,
                        "additional must be false or a type",
                    )
                    .into());
                }
                Additional::Typed(t) => validate_type(t, &pointer(location, "additional"))?,
                _ => {}
            }
        }
        Type::Array { items, .. } => validate_type(items, &pointer(location, "items"))?,
        _ => {}
    }
    Ok(())
}

pub fn validate_value(value: &Value, ty: &Type, location: &str) -> Result<(), ValidationError> {
    // Reject unportable native values even when a broad type would accept them.
    match value {
        Value::Integer(i) if i.unsigned_abs() > crate::MAX_INTEGER as u64 => {
            return Err(Diagnostic::error(
                "number",
                location,
                "Integer exceeds portable safe range",
            )
            .into());
        }
        Value::Number(n) if !n.is_finite() => {
            return Err(Diagnostic::error("number", location, "Nonfinite number").into());
        }
        _ => {}
    }
    if matches!(value, Value::Null) && ty.nullable() {
        return Ok(());
    }
    let valid = match (value, ty) {
        (_, Type::Json) => {
            value.to_json()?;
            true
        }
        (Value::Boolean(_), Type::Boolean { .. })
        | (Value::Integer(_), Type::Integer { .. })
        | (Value::Integer(_), Type::Number { .. })
        | (Value::Number(_), Type::Number { .. })
        | (Value::String(_), Type::String { .. }) => true,
        (Value::Number(n), Type::Integer { .. }) => {
            n.fract() == 0.0 && n.abs() <= crate::MAX_INTEGER as f64
        }
        (Value::Opaque(v), Type::Opaque { id, version, .. }) => {
            v.type_id() == id && v.version() == version
        }
        (Value::Array(v), Type::Array { items, .. }) => {
            for (i, v) in v.iter().enumerate() {
                validate_value(v, items, &pointer(location, i))?;
            }
            true
        }
        (
            Value::Object(v),
            Type::Object {
                properties,
                required,
                additional,
                ..
            },
        ) => {
            for k in required {
                if !v.contains_key(k) {
                    return Err(Diagnostic::error(
                        "type",
                        location,
                        format!("Missing required property {k:?}"),
                    )
                    .into());
                }
            }
            for (k, v) in v.iter() {
                let t = properties
                    .get(k)
                    .or_else(|| additional.ty())
                    .ok_or_else(|| {
                        Diagnostic::error("type", &pointer(location, k), "Unexpected property")
                    })?;
                validate_value(v, t, &pointer(location, k))?;
            }
            true
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(Diagnostic::error(
            "type",
            location,
            format!("Expected {ty:?}, received {value:?}"),
        )
        .into())
    }
}
