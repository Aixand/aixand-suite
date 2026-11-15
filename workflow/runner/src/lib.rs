//! Durable local jobs around the existing Aixand IR execution engine.
//! Application semantics stay in IR bindings; local IPC has native OS adapters.
pub mod client;
pub mod engine;
pub mod error;
pub mod graph;
pub mod model;
pub mod native;
pub mod permissions;
pub mod plans;
pub mod profiles;
pub mod service;
mod store;
pub mod transport;

pub use error::{Error, Result};
pub use model::{Job, JobState, Request, Submission};
pub use service::Service;
