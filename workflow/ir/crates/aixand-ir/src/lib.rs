//! Aixand IR v0.1/v0.2: portable documents and structured sequential semantics.
//! This crate has no runtime, provider, SDK or resource-management dependency.
mod catalog;
mod conditions;
mod diagnostic;
mod json;
mod model;
mod schema;
mod types;
mod validation;
mod value;

pub use catalog::*;
pub use conditions::*;
pub use diagnostic::*;
pub use json::*;
pub use model::*;
pub use schema::*;
pub use types::*;
pub use validation::*;
pub use value::*;
