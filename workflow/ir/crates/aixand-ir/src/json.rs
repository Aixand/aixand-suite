//! Strict portable JSON parsing, including duplicates at every nesting level.
use crate::{Diagnostic, ValidationError};
use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Number, Value};
use std::fmt;

pub const MAX_INTEGER: i64 = 9_007_199_254_740_991;
struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Strict;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("portable JSON")
            }
            fn visit_unit<E: de::Error>(self) -> Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Strict, E> {
                if v.unsigned_abs() > MAX_INTEGER as u64 {
                    return Err(E::custom("integer exceeds portable safe range"));
                }
                Ok(Strict(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Strict, E> {
                if v > MAX_INTEGER as u64 {
                    return Err(E::custom("integer exceeds portable safe range"));
                }
                Ok(Strict(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Strict, E> {
                if v.fract() == 0.0 && v.abs() <= MAX_INTEGER as f64 {
                    return self.visit_i64(v as i64);
                }
                Number::from_f64(v)
                    .map(|v| Strict(Value::Number(v)))
                    .ok_or_else(|| E::custom("nonfinite number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Strict, A::Error> {
                let mut values = Vec::new();
                while let Some(Strict(v)) = a.next_element()? {
                    values.push(v);
                }
                Ok(Strict(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Strict, A::Error> {
                let mut values = Map::new();
                while let Some(key) = a.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom(format!("duplicate JSON key {key:?}")));
                    }
                    let Strict(v) = a.next_value()?;
                    values.insert(key, v);
                }
                Ok(Strict(Value::Object(values)))
            }
        }
        d.deserialize_any(V)
    }
}

pub fn parse_json(text: &str) -> Result<Value, ValidationError> {
    // serde_json would convert integer tokens exceeding u64 into floating point.
    // Inspect number tokens first so those cannot silently lose exact precision.
    let bytes = text.as_bytes();
    let (mut i, mut quoted, mut escaped) = (0, false, false);
    while i < bytes.len() {
        let b = bytes[i];
        if quoted {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                quoted = false;
            }
            i += 1;
        } else if b == b'"' {
            quoted = true;
            i += 1;
        } else if b == b'-' || b.is_ascii_digit() {
            let start = i;
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || b".eE+-".contains(&bytes[i])) {
                i += 1;
            }
            let token = &text[start..i];
            if !token.contains(['.', 'e', 'E'])
                && token
                    .parse::<i64>()
                    .map_or(true, |n| n.unsigned_abs() > MAX_INTEGER as u64)
            {
                return Err(Diagnostic::error(
                    "number",
                    "",
                    "Integer literal exceeds portable safe range",
                )
                .into());
            }
        } else {
            i += 1;
        }
    }
    serde_json::from_str::<Strict>(text)
        .map(|s| s.0)
        .map_err(|e| Diagnostic::error("json", "", e.to_string()).into())
}

pub fn validate_json(value: &Value) -> Result<(), ValidationError> {
    fn visit(value: &Value, path: &str) -> Result<(), ValidationError> {
        match value {
            Value::Number(n) if n.is_i64() || n.is_u64() => {
                if n.as_i64()
                    .is_none_or(|n| n.unsigned_abs() > MAX_INTEGER as u64)
                {
                    return Err(Diagnostic::error(
                        "number",
                        path,
                        "Integer exceeds portable safe range",
                    )
                    .into());
                }
            }
            Value::Array(v) => {
                for (i, v) in v.iter().enumerate() {
                    visit(v, &crate::pointer(path, i))?;
                }
            }
            Value::Object(v) => {
                for (k, v) in v {
                    visit(v, &crate::pointer(path, k))?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    visit(value, "")
}

pub fn canonicalize(value: &Value) -> Result<Vec<u8>, ValidationError> {
    validate_json(value)?;
    serde_json_canonicalizer::to_vec(value)
        .map_err(|e| Diagnostic::error("canonicalization", "", e.to_string()).into())
}

pub fn to_json<T: serde::Serialize>(value: &T) -> Result<Value, ValidationError> {
    let v = serde_json::to_value(value)
        .map_err(|e| Diagnostic::error("serialization", "", e.to_string()))?;
    validate_json(&v)?;
    Ok(v)
}
