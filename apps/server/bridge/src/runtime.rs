//! Bounded bridge scheduling and browser-consumed delivery accounting.
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    io::{self, Write},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant},
};
use undercurrent_sdk::{ProductClientError, ResilientClientError};

pub const REQUEST_BUDGET: Duration = Duration::from_secs(12);
pub const LONG_BUDGET: Duration = Duration::from_secs(60);
const PANE_WINDOW: usize = 256 * 1024;
const TOTAL_WINDOW: usize = 512 * 1024;
const ACK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub struct BridgeError {
    pub code: String,
    pub message: String,
    pub submission: &'static str,
    pub retryable: bool,
    pub effect: Option<undercurrent_protocol::EffectCertaintyDto>,
    pub resource: Option<String>,
    pub limit: Option<u64>,
}
impl From<String> for BridgeError {
    fn from(message: String) -> Self {
        Self {
            code: "operation_failed".into(),
            message,
            submission: "not_sent",
            retryable: false,
            effect: None,
            resource: None,
            limit: None,
        }
    }
}
impl From<&str> for BridgeError {
    fn from(value: &str) -> Self {
        value.to_owned().into()
    }
}
impl BridgeError {
    pub fn sdk(error: ProductClientError, admitted: bool) -> Self {
        let recovering = matches!(
            &error,
            ProductClientError::Client(ResilientClientError::Recovering)
        );
        let effect = match &error {
            ProductClientError::Server(value) => value.effect_certainty,
            _ => None,
        };
        let overload = match &error {
            ProductClientError::Client(ResilientClientError::Client(error)) => error.overload(),
            _ => None,
        };
        let resource = overload
            .map(|value| value.resource().to_owned())
            .or_else(|| {
                matches!(
                    error,
                    ProductClientError::Subscription(
                        undercurrent_sdk::ResilientSubscriptionError::Overloaded
                    )
                )
                .then(|| "client_stream_mailbox".to_owned())
            });
        Self {
            code: if recovering {
                "backend_recovering".into()
            } else {
                error.category().as_str().into()
            },
            message: if recovering {
                "Reconnecting to the terminal backend.".into()
            } else {
                error.to_string()
            },
            submission: if admitted { "admitted" } else { "not_sent" },
            retryable: recovering
                || matches!(
                    error.category(),
                    undercurrent_sdk::ProductClientErrorCategory::Unavailable
                        | undercurrent_sdk::ProductClientErrorCategory::Overloaded
                        | undercurrent_sdk::ProductClientErrorCategory::Timeout
                ),
            effect,
            resource,
            limit: overload.and_then(|value| value.limit()),
        }
    }
    pub fn cli(error: undercurrent_cli::CliError) -> Self {
        // Group operations can perform several effects before their final SDK call.
        // A pre-admission error in that call says nothing about earlier steps.
        let mut result = Self::from(error.to_string());
        result.submission = "unknown";
        result
    }
    pub fn value(self, id: &str, operation: &str) -> Value {
        let mut message = self.message;
        if is_mutation(operation)
            && self.submission != "not_sent"
            && self.effect != Some(undercurrent_protocol::EffectCertaintyDto::KnownAbsent)
        {
            message.push_str(" Delivery may be uncertain; the action was not retried.");
        }
        json!({"type":"error", "id":id, "operation":operation, "code":self.code,
            "submission":self.submission, "retryable":self.retryable, "effectCertainty":self.effect,
            "resource":self.resource, "limit":self.limit, "message":message})
    }
}
pub fn is_mutation(op: &str) -> bool {
    matches!(
        op,
        "input" | "resize" | "create" | "stop" | "restart" | "remove" | "clean" | "set-my-terminal"
    ) || op.starts_with("group-")
}

/// A writer owns stdout. Workers never hold a stream-registry lock during IO.
#[derive(Clone)]
pub struct Output(Arc<(Mutex<OutputQueue>, Condvar)>);
#[derive(Default)]
struct OutputQueue {
    control: VecDeque<Vec<u8>>,
    bulk: VecDeque<Vec<u8>>,
    bytes: usize,
    closed: bool,
    writing: bool,
}
impl Output {
    pub fn new() -> Self {
        let output = Self(Arc::new((
            Mutex::new(OutputQueue::default()),
            Condvar::new(),
        )));
        let worker = output.clone();
        std::thread::spawn(move || {
            loop {
                let (lock, changed) = &*worker.0;
                let mut queue = lock.lock().unwrap();
                while queue.control.is_empty() && queue.bulk.is_empty() && !queue.closed {
                    queue = changed.wait(queue).unwrap();
                }
                let frame = queue.control.pop_front().or_else(|| queue.bulk.pop_front());
                let Some(frame) = frame else {
                    return;
                };
                queue.bytes -= frame.len();
                queue.writing = true;
                changed.notify_all();
                drop(queue);
                let mut stdout = io::stdout().lock();
                if stdout
                    .write_all(&frame)
                    .and_then(|_| stdout.flush())
                    .is_err()
                {
                    std::process::exit(0);
                }
                drop(stdout);
                let mut queue = lock.lock().unwrap();
                queue.writing = false;
                changed.notify_all();
            }
        });
        output
    }
    pub fn emit(&self, value: Value) {
        let bulk = value["stream"].is_string();
        let mut frame = serde_json::to_vec(&value).unwrap();
        frame.push(b'\n');
        let (lock, changed) = &*self.0;
        let mut queue = lock.lock().unwrap();
        while queue.bytes + frame.len() > 8 * 1024 * 1024 && !queue.closed {
            queue = changed.wait(queue).unwrap();
        }
        if queue.closed {
            return;
        }
        queue.bytes += frame.len();
        if bulk {
            queue.bulk.push_back(frame);
        } else {
            queue.control.push_back(frame);
        }
        changed.notify_all();
    }
    pub fn flush(&self) {
        let (lock, changed) = &*self.0;
        let mut queue = lock.lock().unwrap();
        while queue.bytes > 0 || queue.writing {
            queue = changed.wait(queue).unwrap();
        }
    }
    pub fn close(&self) {
        let (lock, changed) = &*self.0;
        lock.lock().unwrap().closed = true;
        changed.notify_all();
    }
}

/// Payloads remain owned here until xterm acknowledges parsing them. SDK receive
/// checkpoints alone do not prove the browser consumed the corresponding bytes.
#[derive(Default)]
pub struct DeliveryWindow {
    state: Mutex<WindowState>,
    changed: Condvar,
}
#[derive(Default)]
struct WindowState {
    streams: BTreeMap<String, VecDeque<Delivery>>,
    bytes: usize,
    waiters: VecDeque<(String, usize)>,
}
struct Delivery {
    sequence: u64,
    bytes: usize,
    _payload: Value,
    sent: Instant,
}
impl DeliveryWindow {
    pub fn register(&self, stream: &str) {
        self.state
            .lock()
            .unwrap()
            .streams
            .insert(stream.into(), VecDeque::new());
    }
    pub fn cancel(&self, stream: &str) {
        let mut state = self.state.lock().unwrap();
        if let Some(deliveries) = state.streams.remove(stream) {
            state.bytes -= deliveries.iter().map(|d| d.bytes).sum::<usize>();
        }
        state.waiters.retain(|(id, _)| id != stream);
        self.changed.notify_all();
    }
    pub fn ack(&self, stream: &str, sequence: u64) {
        let mut state = self.state.lock().unwrap();
        let Some(deliveries) = state.streams.get_mut(stream) else {
            return;
        };
        // Ignore duplicates, stale IDs and acknowledgements beyond emitted data.
        let Some(index) = deliveries.iter().position(|d| d.sequence == sequence) else {
            return;
        };
        let released: usize = deliveries.drain(..=index).map(|d| d.bytes).sum();
        state.bytes -= released;
        self.changed.notify_all();
    }
    pub fn retain(
        &self,
        stream: &str,
        sequence: u64,
        payload: Value,
    ) -> Result<bool, &'static str> {
        let bytes = serde_json::to_vec(&payload).unwrap().len();
        if bytes > PANE_WINDOW {
            return Err("Terminal frame exceeds the delivery window.");
        }
        let mut state = self.state.lock().unwrap();
        if !state.streams.contains_key(stream) {
            return Ok(false);
        }
        state.waiters.push_back((stream.into(), bytes));
        loop {
            let Some(deliveries) = state.streams.get(stream) else {
                state.waiters.retain(|(id, _)| id != stream);
                return Ok(false);
            };
            if deliveries
                .front()
                .is_some_and(|d| d.sent.elapsed() >= ACK_TIMEOUT)
            {
                state.waiters.retain(|(id, _)| id != stream);
                return Err("Terminal display stopped acknowledging output.");
            }
            // A full/hidden pane cannot hold the head of the workspace queue.
            let eligible = state.waiters.iter().position(|(id, size)| {
                state.bytes + size <= TOTAL_WINDOW
                    && state.streams.get(id).is_some_and(|q| {
                        q.iter().map(|d| d.bytes).sum::<usize>() + size <= PANE_WINDOW
                    })
            });
            if let Some(index) = eligible.filter(|i| state.waiters[*i].0 == stream) {
                state.waiters.remove(index);
                state.bytes += bytes;
                state.streams.get_mut(stream).unwrap().push_back(Delivery {
                    sequence,
                    bytes,
                    _payload: payload,
                    sent: Instant::now(),
                });
                self.changed.notify_all();
                return Ok(true);
            }
            state = self
                .changed
                .wait_timeout(state, Duration::from_millis(100))
                .unwrap()
                .0;
        }
    }
    pub fn expired(&self, stream: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .streams
            .get(stream)
            .and_then(|q| q.front())
            .is_some_and(|d| d.sent.elapsed() >= ACK_TIMEOUT)
    }
}

/// A multi-step CLI operation shares one absolute deadline across SDK calls.
pub struct BudgetClient<'a> {
    pub client: &'a undercurrent_sdk::ProductClient,
    pub deadline: Instant,
}
impl BudgetClient<'_> {
    fn remaining(&self, timeout: Duration) -> Result<Duration, ProductClientError> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ProductClientError::Subscription(
                undercurrent_sdk::ResilientSubscriptionError::Timeout,
            ));
        }
        Ok(timeout.min(remaining))
    }
}
impl undercurrent_cli::CliProductRequestPort for BudgetClient<'_> {
    fn server_epoch(&self) -> Option<String> {
        self.client.agreement().map(|a| a.server_epoch().to_owned())
    }
    fn request(
        &self,
        request: undercurrent_protocol::ProductRequest,
        timeout: Duration,
    ) -> Result<undercurrent_protocol::ProductSuccess, ProductClientError> {
        self.client.request(request, self.remaining(timeout)?)
    }
}
impl undercurrent_cli::CliProductStreamPort for BudgetClient<'_> {
    type Subscription = undercurrent_sdk::ProductSubscription;
    fn open_product_subscription(
        &self,
        spec: undercurrent_protocol::ProductStreamSpec,
        timeout: Duration,
    ) -> Result<undercurrent_cli::OpenedCliSubscription<Self::Subscription>, ProductClientError>
    {
        let opened = self
            .client
            .open_subscription(spec, self.remaining(timeout)?)?;
        Ok(undercurrent_cli::OpenedCliSubscription {
            metadata: opened.metadata,
            subscription: opened.subscription,
        })
    }
}

/// Ready jobs are selected by priority while conflicting resource keys remain FIFO.
pub struct Scheduler<T> {
    pub queued: VecDeque<(T, Vec<String>, u8)>,
    pub running: BTreeSet<String>,
    pub active: usize,
    background: usize,
    noninteractive: usize,
}
impl<T> Default for Scheduler<T> {
    fn default() -> Self {
        Self {
            queued: VecDeque::new(),
            running: BTreeSet::new(),
            active: 0,
            background: 0,
            noninteractive: 0,
        }
    }
}
impl<T> Scheduler<T> {
    pub fn pop_ready(&mut self) -> Option<(T, Vec<String>, u8)> {
        if self.active >= 8 {
            return None;
        }
        let index = self
            .queued
            .iter()
            .enumerate()
            .filter(|(i, (_, keys, priority))| {
                (*priority < 2 || self.background < 2)
                    && (*priority == 0 || self.noninteractive < 6)
                    && !keys.iter().any(|key| self.running.contains(key))
                    && !self
                        .queued
                        .iter()
                        .take(*i)
                        .any(|(_, earlier, _)| earlier.iter().any(|key| keys.contains(key)))
            })
            .min_by_key(|(_, (_, _, priority))| *priority)
            .map(|(i, _)| i)?;
        let job = self.queued.remove(index).unwrap();
        self.running.extend(job.1.iter().cloned());
        self.active += 1;
        if job.2 > 0 {
            self.noninteractive += 1;
        }
        if job.2 >= 2 {
            self.background += 1;
        }
        Some(job)
    }
    pub fn finish(&mut self, keys: Vec<String>, priority: u8) {
        for key in keys {
            self.running.remove(&key);
        }
        self.active -= 1;
        if priority > 0 {
            self.noninteractive -= 1;
        }
        if priority >= 2 {
            self.background -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acknowledgements_are_cumulative_and_only_release_emitted_deliveries() {
        let window = DeliveryWindow::default();
        window.register("a");
        window.register("b");
        for seq in 1..=3 {
            assert!(window.retain("a", seq, json!({"data":"abc"})).unwrap());
        }
        window.ack("a", 99);
        assert_eq!(window.state.lock().unwrap().streams["a"].len(), 3);
        window.ack("a", 2);
        assert_eq!(window.state.lock().unwrap().streams["a"].len(), 1);
        window.ack("a", 1);
        assert_eq!(window.state.lock().unwrap().streams["a"].len(), 1);
        window.cancel("a");
        assert_eq!(window.state.lock().unwrap().bytes, 0);
        assert!(!window.retain("a", 4, json!({})).unwrap());
    }
    #[test]
    fn interactive_work_bypasses_reads_but_preserves_session_order() {
        let mut s = Scheduler::default();
        s.queued.push_back((1, vec!["session".into()], 2));
        s.queued.push_back((2, vec!["session".into()], 0));
        s.queued.push_back((3, vec!["other".into()], 0));
        assert_eq!(s.pop_ready().unwrap().0, 3);
        assert_eq!(s.pop_ready().unwrap().0, 1);
        assert!(s.pop_ready().is_none());
        s.finish(vec!["session".into()], 2);
        assert_eq!(s.pop_ready().unwrap().0, 2);
    }
    #[test]
    fn slow_attachments_cannot_occupy_the_interactive_worker_reservation() {
        let mut scheduler = Scheduler::default();
        for id in 0..8 {
            scheduler
                .queued
                .push_back((id, vec![format!("pane-{id}")], 1));
        }
        for _ in 0..6 {
            assert!(scheduler.pop_ready().is_some());
        }
        assert!(scheduler.pop_ready().is_none());
        scheduler
            .queued
            .push_back((99, vec!["interactive".into()], 0));
        assert_eq!(scheduler.pop_ready().unwrap().0, 99);
    }
    #[test]
    fn full_pane_window_does_not_block_a_peer_and_cancellation_wakes_a_waiter() {
        let window = Arc::new(DeliveryWindow::default());
        window.register("busy");
        window.register("peer");
        assert!(
            window
                .retain("busy", 1, json!({"data":"x".repeat(250 * 1024)}))
                .unwrap()
        );
        let writer = window.clone();
        let waiting = std::thread::spawn(move || {
            writer.retain("busy", 2, json!({"data":"x".repeat(16 * 1024)}))
        });
        let started = Instant::now();
        while window.state.lock().unwrap().waiters.is_empty() {
            assert!(started.elapsed() < Duration::from_secs(1));
            std::thread::yield_now();
        }
        assert!(
            window
                .retain("peer", 1, json!({"data":"interactive"}))
                .unwrap()
        );
        assert!(window.state.lock().unwrap().bytes <= TOTAL_WINDOW);
        window.cancel("busy");
        assert!(!waiting.join().unwrap().unwrap());
    }
    #[test]
    fn pre_admission_recovery_does_not_claim_an_uncertain_effect() {
        let error = BridgeError::sdk(
            ProductClientError::Client(ResilientClientError::Recovering),
            false,
        )
        .value("id", "input");
        assert_eq!(error["submission"], "not_sent");
        assert_eq!(error["code"], "backend_recovering");
        assert!(!error["message"].as_str().unwrap().contains("uncertain"));
        let mut error = BridgeError::from("Response lost");
        error.submission = "admitted";
        assert!(
            error.value("id", "input")["message"]
                .as_str()
                .unwrap()
                .contains("uncertain")
        );
    }
}
