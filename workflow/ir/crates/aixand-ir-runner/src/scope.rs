use crate::Failure;
use aixand_ir::{Diagnostic, Opaque, ValidationError, Value};
use async_trait::async_trait;
use futures_util::FutureExt;
use std::panic::AssertUnwindSafe;
use std::{
    any::Any,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CleanupPolicy {
    #[default]
    Detach,
    StopOwned,
}

/// Register before resource setup begins so partially initialized resources clean up.
/// Implementations distinguish owned and attached resources; atoms imply no ownership.
#[async_trait]
pub trait Cleanup: Send + Sync {
    async fn close(&self, policy: CleanupPolicy) -> Result<(), Failure>;
}

struct Stored {
    atom: Opaque,
    payload: Arc<dyn Any + Send + Sync>,
}
struct State {
    atoms: Vec<Stored>,
    cleanup: Vec<Arc<dyn Cleanup>>,
    failure: Option<Failure>,
}
struct Inner {
    closed: AtomicBool,
    state: Mutex<State>,
    failure: CancellationToken,
    close_lock: tokio::sync::Mutex<()>,
    policy: CleanupPolicy,
}

#[derive(Clone)]
pub struct Scope(Arc<Inner>);
impl Default for Scope {
    fn default() -> Self {
        Self::new(CleanupPolicy::Detach)
    }
}
impl Scope {
    pub fn new(policy: CleanupPolicy) -> Self {
        Self(Arc::new(Inner {
            closed: AtomicBool::new(false),
            state: Mutex::new(State {
                atoms: vec![],
                cleanup: vec![],
                failure: None,
            }),
            failure: CancellationToken::new(),
            close_lock: tokio::sync::Mutex::new(()),
            policy,
        }))
    }
    pub fn is_closed(&self) -> bool {
        self.0.closed.load(Ordering::Acquire)
    }
    pub fn check(&self) -> Result<(), Failure> {
        if self.is_closed() {
            return Err(Failure::new("scope_closed", "Execution scope is closed"));
        }
        if let Some(error) = self.0.state.lock().expect("scope lock").failure.clone() {
            return Err(error);
        }
        Ok(())
    }
    pub fn register_cleanup(&self, cleanup: Arc<dyn Cleanup>) -> Result<(), Failure> {
        let mut state = self.0.state.lock().expect("scope lock");
        if self.is_closed() {
            return Err(Failure::new(
                "scope_closed",
                "Cannot register cleanup after scope close",
            ));
        }
        state.cleanup.push(cleanup);
        Ok(())
    }
    pub fn insert<T: Any + Send + Sync>(
        &self,
        type_id: &str,
        version: &str,
        payload: Arc<T>,
    ) -> Result<Opaque, Failure> {
        let mut state = self.0.state.lock().expect("scope lock");
        if self.is_closed() {
            return Err(Failure::new(
                "scope_closed",
                "Cannot publish a value after scope close",
            ));
        }
        let atom = Opaque::new(type_id, version);
        state.atoms.push(Stored {
            atom: atom.clone(),
            payload,
        });
        Ok(atom)
    }
    pub fn get<T: Any + Send + Sync>(&self, atom: &Opaque) -> Result<Arc<T>, Failure> {
        self.check()?;
        let state = self.0.state.lock().expect("scope lock");
        let stored = state
            .atoms
            .iter()
            .find(|s| s.atom.same_identity(atom))
            .ok_or_else(|| {
                Failure::new(
                    "opaque_scope",
                    "Opaque atom is foreign, expired, or fabricated",
                )
            })?;
        stored.payload.clone().downcast::<T>().map_err(|_| {
            Failure::new(
                "opaque_adapter",
                "Binding does not accept this atom's runtime representation",
            )
        })
    }
    pub fn validate_value(&self, value: &Value) -> Result<(), ValidationError> {
        value.visit_opaque(&mut |atom| {
            let state = self.0.state.lock().expect("scope lock");
            if self.is_closed() || !state.atoms.iter().any(|s| s.atom.same_identity(atom)) {
                Err(Diagnostic::error(
                    "opaque_scope",
                    "",
                    "Opaque atom is foreign, expired, or fabricated",
                )
                .into())
            } else {
                Ok(())
            }
        })
    }
    pub fn report_failure(&self, error: Failure) {
        let mut state = self.0.state.lock().expect("scope lock");
        if state.failure.is_none() {
            state.failure = Some(error);
        }
        self.0.failure.cancel();
    }
    pub async fn failed(&self) -> Failure {
        self.0.failure.cancelled().await;
        self.0
            .state
            .lock()
            .expect("scope lock")
            .failure
            .clone()
            .unwrap_or_else(|| {
                Failure::new("scope_closed", "Execution scope closed during operation")
            })
    }
    /// Cleanup is reverse registration order and idempotent. Primary errors are merged by Runner.
    pub async fn close(&self) -> Result<(), Failure> {
        let _lock = self.0.close_lock.lock().await;
        if self.0.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.0.failure.cancel();
        let cleanups = std::mem::take(&mut self.0.state.lock().expect("scope lock").cleanup);
        let mut errors = Vec::new();
        for cleanup in cleanups.into_iter().rev() {
            if let Err(error) = AssertUnwindSafe(cleanup.close(self.0.policy))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err(Failure::new("cleanup_panic", "Resource cleanup panicked")))
            {
                errors.push(error);
            }
        }
        self.0.state.lock().expect("scope lock").atoms.clear();
        if errors.is_empty() {
            Ok(())
        } else {
            let mut failure = Failure::new("cleanup", "Execution scope cleanup failed");
            failure.cleanup_errors = errors;
            Err(failure)
        }
    }
}
