//! Host-owned admission for revisioned graphs. This module has no storage dependency.
use crate::Failure;
use aixand_ir::{Named, Workflow};
use serde_json::Value;

pub struct GraphRevision {
    pub revision: u64,
    pub workflow: Workflow,
    pub dependencies: Named<Vec<String>>,
    pub held: bool,
    /// Previously admitted operations may reconcile while new admission is held.
    pub claimed: std::collections::BTreeSet<String>,
}

pub trait GraphControl: Send + Sync {
    fn current(&self) -> Result<GraphRevision, Failure>;
    /// False means admission changed; reload before considering another operation.
    fn claim(&self, revision: u64, invocation: &str) -> Result<bool, Failure>;
    /// JSON values are checkpointed; opaque values remain in the caller's live scope.
    fn publish(&self, invocation: &str, outputs: Option<&Value>) -> Result<(), Failure>;
    fn seal(&self, revision: u64) -> Result<bool, Failure>;
    fn fail(&self) -> Result<(), Failure>;
}
