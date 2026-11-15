//! Private, bounded JSON-lines bridge. Only the parent NestJS process owns stdin/stdout.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    env,
    io::{self, BufRead},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use undercurrent_cli::{
    CleanArguments, CliExecutionLimits, ConfigDiscovery, FiniteCliExecutor, GroupClient,
    load_cli_config,
};
use undercurrent_protocol::*;
use undercurrent_sdk::*;

mod runtime;
use runtime::{
    BridgeError, BudgetClient, DeliveryWindow, LONG_BUDGET, Output, REQUEST_BUDGET, Scheduler,
};
const DEADLINE: Duration = Duration::from_secs(10);
const MAX_LINE: u64 = 100_000;
fn suite_terminal_labels() -> BTreeMap<String, String> {
    let mut labels = BTreeMap::from([
        ("app".into(), "aixand-suite".into()),
        ("feature".into(), "terminal".into()),
        ("session.kind".into(), "shell".into()),
    ]);
    if let Ok(instance) = env::var("AIXAND_SUITE_INSTANCE_ID") {
        labels.insert("suite.instance".into(), instance);
    }
    labels
}

fn emit(out: &Output, value: Value) {
    out.emit(value);
}
fn exact_counters(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if matches!(
                    key.as_str(),
                    "sequence"
                        | "checkpoint"
                        | "revision"
                        | "session_revision"
                        | "catalog_revision"
                        | "snapshot_revision"
                        | "from_revision"
                        | "to_revision"
                ) && value.is_u64()
                {
                    *value = json!(value.as_u64().unwrap().to_string());
                } else {
                    exact_counters(value);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                exact_counters(item);
            }
        }
        _ => (),
    }
}

#[derive(Deserialize)]
struct Command {
    id: String,
    op: String,
    #[serde(default)]
    args: Value,
    #[serde(skip, default = "Instant::now")]
    received: Instant,
    #[serde(skip)]
    version: u64,
}
impl Command {
    fn budget(&self) -> Duration {
        if matches!(
            self.op.as_str(),
            "clean" | "group-restore" | "group-reconcile"
        ) {
            LONG_BUDGET
        } else {
            REQUEST_BUDGET
        }
    }
    fn remaining(&self) -> Duration {
        self.budget()
            .saturating_sub(self.received.elapsed())
            .min(DEADLINE)
    }
    fn key(&self) -> Vec<String> {
        if matches!(self.op.as_str(), "attach" | "detach") {
            return vec![format!(
                "pane:{}",
                self.args["paneId"].as_str().unwrap_or("main")
            )];
        }
        if matches!(
            self.op.as_str(),
            "watch" | "watch-events" | "watch-open" | "unwatch"
        ) {
            return vec![watch_key(self)];
        }
        let mut keys = Vec::new();
        if runtime::is_mutation(&self.op) {
            if let Some(id) = self.args["sessionId"].as_str() {
                keys.push(format!("session:{id}"));
            }
            if self.op.starts_with("group-") || self.args["group"].is_string() || self.op == "clean"
            {
                keys.push("registry".into());
            }
            if self.op == "create" {
                keys.push(format!("name:{}", self.args["name"]));
            }
        }
        keys
    }
    fn priority(&self) -> u8 {
        if matches!(self.op.as_str(), "input" | "resize" | "detach") {
            0
        } else if matches!(self.op.as_str(), "list" | "groups" | "inspect" | "events") {
            2
        } else {
            1
        }
    }
}
fn watch_key(cmd: &Command) -> String {
    format!(
        "watch-{}",
        match cmd.op.as_str() {
            "watch-events" => "events",
            "watch-open" => "open",
            "unwatch" => cmd.args["kind"].as_str().unwrap_or("sessions"),
            _ => "sessions",
        }
    )
}

struct Active {
    cancelled: Arc<AtomicBool>,
    subscription: Arc<ProductSubscription>,
    window: Arc<DeliveryWindow>,
    _worker: thread::JoinHandle<()>,
}
fn detach(active: Option<Active>) {
    if let Some(active) = active {
        active.cancelled.store(true, Ordering::Release);
        active.subscription.cancel();
        active.window.cancel(active.subscription.stream_id());
    }
}
fn mutation(op: ProductOperation) -> MutationContext {
    let mut context = MutationContext::current(op);
    context.idempotency_key = Some(uuid::Uuid::new_v4().to_string());
    context
}
fn string(args: &Value, key: &str) -> Result<String, String> {
    args[key]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("Missing {key}"))
}
fn size(args: &Value) -> Result<TerminalSizeDto, String> {
    serde_json::from_value(json!({"columns":args["columns"],"rows":args["rows"]}))
        .map_err(|_| "Invalid terminal size".into())
}
#[derive(Default)]
struct Streams {
    active: BTreeMap<String, Active>,
    versions: BTreeMap<String, u64>,
}
fn error(out: &Output, cmd: &Command, cause: BridgeError) {
    emit(out, cause.value(&cmd.id, &cmd.op));
}
struct Execution<'a> {
    client: &'a ProductClient,
    out: &'a Output,
    streams: &'a Mutex<Streams>,
    window: &'a Arc<DeliveryWindow>,
}
fn execute(
    context: Execution<'_>,
    groups: Option<&GroupClient<'_, BudgetClient<'_>>>,
    cleaner: Option<&FiniteCliExecutor<'_>>,
    cmd: &Command,
) -> Result<(), BridgeError> {
    let Execution {
        client,
        out,
        streams,
        window,
    } = context;
    let args = &cmd.args;
    if cmd.op == "clean" {
        if args["confirmed"] != true {
            return Err("Confirm cleanup first".into());
        }
        let result = cleaner
            .ok_or("Cleanup client unavailable")?
            .clean_selected(
                &CleanArguments {
                    name: None,
                    all: false,
                    yes: true,
                },
                RemovalConfirmationDto::Confirmed,
            )
            .map_err(BridgeError::cli)?;
        emit(out, json!({"type":"result","id":cmd.id,"result":result}));
        return Ok(());
    }
    if cmd.op == "groups"
        || cmd.op.starts_with("group-")
        || (cmd.op == "create" && args["group"].is_string())
    {
        let groups = groups.ok_or("Group client unavailable")?;
        let default_cwd = env::var("TERMINAL_CWD")
            .unwrap_or_else(|_| env::var("HOME").unwrap_or_else(|_| "/".into()));
        let default_shell = env::var("TERMINAL_SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut result = match cmd.op.as_str() {
            "groups" => {
                json!({"groups":groups.list().map_err(BridgeError::cli)?, "defaults":{"cwd":default_cwd,"shell":default_shell}})
            }
            "group-create" => {
                groups
                    .create(
                        &string(args, "name")?,
                        std::path::Path::new(args["cwd"].as_str().unwrap_or(&default_cwd)),
                        args["shell"].as_str().unwrap_or(&default_shell),
                        args["persistent"].as_bool().unwrap_or(true),
                    )
                    .map_err(BridgeError::cli)?;
                Value::Null
            }
            "group-delete" => {
                groups
                    .delete(&string(args, "group")?)
                    .map_err(BridgeError::cli)?;
                Value::Null
            }
            "group-assign" => {
                groups
                    .assign(
                        &string(args, "sessionId")?,
                        args["from"].as_str(),
                        args["to"].as_str(),
                    )
                    .map_err(BridgeError::cli)?;
                Value::Null
            }
            "group-restore" => {
                json!({"notices":groups.restore(&string(args, "group")?, &string(args, "sessionId")?, size(args)?).map_err(BridgeError::cli)?})
            }
            "group-reconcile" => {
                groups
                    .reconcile(&string(args, "group")?)
                    .map_err(BridgeError::cli)?;
                Value::Null
            }
            "create" => {
                json!({"session":groups.start(&string(args, "group")?, &string(args, "name")?, size(args)?).map_err(BridgeError::cli)?})
            }
            _ => return Err("Unknown group operation".into()),
        };
        exact_counters(&mut result);
        emit(out, json!({"type":"result","id":cmd.id,"result":result}));
        return Ok(());
    }
    if cmd.op == "unwatch" {
        let old = streams.lock().unwrap().active.remove(&watch_key(cmd));
        detach(old);
        emit(out, json!({"type":"result","id":cmd.id,"result":null}));
        return Ok(());
    }
    if matches!(cmd.op.as_str(), "watch" | "watch-events" | "watch-open") {
        let kind = if cmd.op != "watch-events" {
            "sessions"
        } else {
            "events"
        };
        let key = watch_key(cmd);
        let old = streams.lock().unwrap().active.remove(&key);
        detach(old);
        let spec = if kind == "sessions" {
            ProductStreamSpec::SessionWatch(SessionWatchSpec {
                query: ListSessionsRequest {
                    filter: if cmd.op == "watch-open" {
                        SessionFilterDto {
                            ids: serde_json::from_value(args["sessionIds"].clone())
                                .map_err(|_| "Invalid session IDs")?,
                            ..Default::default()
                        }
                    } else {
                        SessionFilterDto::default()
                    },
                    sort: SessionSortDto::default(),
                    projection: SessionProjectionDto::WithLabels,
                    page_size: 100,
                    cursor: None,
                    include_total: true,
                },
            })
        } else {
            ProductStreamSpec::SessionEvents(SessionEventsSpec {
                session_ids: vec![string(args, "sessionId")?],
                kinds: vec![],
                after_sequence: args["after"]
                    .as_str()
                    .map(str::parse)
                    .transpose()
                    .map_err(|_| "Invalid event checkpoint")?,
            })
        };
        let opened = client
            .open_subscription(spec, cmd.remaining())
            .map_err(|e| BridgeError::sdk(e, false))?;
        let subscription = Arc::new(opened.subscription);
        let mut registry = streams.lock().unwrap();
        if registry.versions.get(&key) != Some(&cmd.version) {
            drop(registry);
            subscription.cancel();
            return Err("Attachment superseded".into());
        }
        let stream = subscription.stream_id().to_string();
        window.register(&stream);
        emit(
            out,
            json!({"type":"result","id":cmd.id,"result":{"stream":stream}}),
        );
        let sub = subscription.clone();
        let output = out.clone();
        let window_worker = window.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let stopped = cancelled.clone();
        let worker = thread::spawn(move || {
            loop {
                let item = match sub.recv_timeout(Duration::from_millis(100)) {
                    Ok(item) => item,
                    Err(ProductClientError::Subscription(ResilientSubscriptionError::Timeout))
                        if !window_worker.expired(&stream) && !stopped.load(Ordering::Acquire) =>
                    {
                        continue;
                    }
                    Err(e) => {
                        if stopped.load(Ordering::Acquire) {
                            break;
                        }
                        emit(
                            &output,
                            json!({"type":"metadata-gap","kind":kind,"scope":if key == "watch-open" {"open"} else {kind},"stream":stream,"message":e.to_string()}),
                        );
                        break;
                    }
                };
                let sequence_number = item.sequence();
                let sequence = sequence_number.to_string();
                match item {
                    ProductSubscriptionItem::Json { item, .. } => {
                        let mut value = serde_json::to_value(item).unwrap();
                        exact_counters(&mut value);
                        if let Some(seq) = value["value"]["sequence"].as_u64() {
                            value["value"]["sequence"] = json!(seq.to_string());
                        }
                        let value = json!({"type":"metadata","kind":kind,"scope":if key == "watch-open" { "open" } else { kind },"stream":stream,"sequence":sequence,"payload":value});
                        match window_worker.retain(&stream, sequence_number, value.clone()) {
                            Ok(true) => emit(&output, value),
                            Ok(false) => break,
                            Err(message) => {
                                emit(
                                    &output,
                                    json!({"type":"metadata-gap","kind":kind,"scope":if key == "watch-open" {"open"} else {kind},"stream":stream,"message":message}),
                                );
                                break;
                            }
                        }
                    }
                    _ => {
                        emit(
                            &output,
                            json!({"type":"metadata-gap","kind":kind,"scope":if key == "watch-open" {"open"} else {kind},"stream":stream,"message":"Live updates interrupted; refreshing snapshot."}),
                        );
                        break;
                    }
                }
            }
            window_worker.cancel(&stream);
            sub.cancel();
        });
        registry.active.insert(
            watch_key(cmd),
            Active {
                cancelled,
                subscription,
                window: window.clone(),
                _worker: worker,
            },
        );
        return Ok(());
    }
    let pane_id = args["paneId"].as_str().unwrap_or("main").to_owned();
    if cmd.op == "detach" {
        let old = streams.lock().unwrap().active.remove(&pane_id);
        detach(old);
        emit(out, json!({"type":"result","id":cmd.id,"result":null}));
        return Ok(());
    }
    if cmd.op == "attach" {
        {
            let registry = streams.lock().unwrap();
            if registry
                .active
                .keys()
                .filter(|key| !key.starts_with("watch-"))
                .count()
                >= 16
                && !registry.active.contains_key(&pane_id)
            {
                return Err("Maximum of 16 terminal panes per connection".into());
            }
        }
        let old = streams.lock().unwrap().active.remove(&pane_id);
        detach(old);
        let initial = if args["screen"] == true {
            TerminalInitialModeDto::Screen
        } else {
            TerminalInitialModeDto::Resume {
                after_offset: args["offset"]
                    .as_str()
                    .unwrap_or("0")
                    .parse()
                    .map_err(|_| "Invalid output offset")?,
            }
        };
        let session_id = string(args, "sessionId")?;
        let opened = client
            .open_subscription(
                ProductStreamSpec::TerminalOutput(TerminalOutputSpec {
                    session_id: session_id.clone(),
                    initial,
                }),
                cmd.remaining(),
            )
            .map_err(|e| BridgeError::sdk(e, false))?;
        let subscription = Arc::new(opened.subscription);
        let mut registry = streams.lock().unwrap();
        if registry
            .active
            .keys()
            .filter(|key| !key.starts_with("watch-"))
            .count()
            >= 16
            && !registry.active.contains_key(&pane_id)
        {
            drop(registry);
            subscription.cancel();
            return Err("Maximum of 16 terminal panes per connection".into());
        }
        if registry.versions.get(&pane_id) != Some(&cmd.version) {
            drop(registry);
            subscription.cancel();
            return Err("Attachment superseded".into());
        }
        let stream = subscription.stream_id().to_string();
        window.register(&stream);
        let window_worker = window.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let stopped = cancelled.clone();
        emit(
            out,
            json!({"type":"result","id":cmd.id,"result":{"stream":stream,"sessionId":session_id}}),
        );
        let sub = subscription.clone();
        let output = out.clone();
        let worker = thread::spawn(move || {
            loop {
                let item = match sub.recv_timeout(Duration::from_millis(100)) {
                    Ok(item) => item,
                    Err(ProductClientError::Subscription(ResilientSubscriptionError::Timeout))
                        if !window_worker.expired(&stream) && !stopped.load(Ordering::Acquire) =>
                    {
                        continue;
                    }
                    Err(e) => {
                        if stopped.load(Ordering::Acquire) {
                            break;
                        }
                        emit(
                            &output,
                            json!({"type":"stream-error","stream":stream,"message":e.to_string()}),
                        );
                        break;
                    }
                };
                let sequence_number = item.sequence();
                let sequence = sequence_number.to_string();
                let value = match item {
                    ProductSubscriptionItem::Terminal {
                        item: TerminalStreamItem::Output(chunk),
                        ..
                    } => {
                        json!({"type":"output","stream":stream,"sequence":sequence,
                            "start":chunk.start_offset().to_string(),"offset":chunk.end_offset().unwrap().to_string(),
                            "data":STANDARD.encode(chunk.bytes())})
                    }
                    ProductSubscriptionItem::Terminal {
                        item: TerminalStreamItem::Screen(screen),
                        ..
                    } => {
                        json!({"type":"screen","stream":stream,"sequence":sequence,
                            "offset":screen.output_offset().to_string(),"columns":screen.columns(),"rows":screen.rows(),
                            "cursorRow":screen.cursor_row(),"cursorColumn":screen.cursor_column(),
                            "cursorVisible":screen.cursor_visible(),"alternateScreen":screen.alternate_screen(),
                            "data":STANDARD.encode(screen.contents())})
                    }
                    ProductSubscriptionItem::Gap(gap) => {
                        emit(
                            &output,
                            json!({"type":"gap","stream":stream,"reason":gap.reason.as_str()}),
                        );
                        break;
                    }
                    _ => break,
                };
                match window_worker.retain(&stream, sequence_number, value.clone()) {
                    Ok(true) => emit(&output, value),
                    Ok(false) => break,
                    Err(message) => {
                        emit(
                            &output,
                            json!({"type":"stream-error","stream":stream,"message":message}),
                        );
                        break;
                    }
                }
            }
            window_worker.cancel(&stream);
            sub.cancel();
        });
        registry.active.insert(
            pane_id,
            Active {
                cancelled,
                subscription,
                window: window.clone(),
                _worker: worker,
            },
        );
        return Ok(());
    }
    let request = match cmd.op.as_str() {
        "set-my-terminal" => {
            let selected = args["myTerminal"]
                .as_bool()
                .ok_or("Missing My terminals selection")?;
            let marker = "aixand.my_terminal".to_owned();
            ProductRequest::UpdateSessionLabels(UpdateSessionLabelsRequest {
                mutation: mutation(ProductOperation::UpdateSessionLabels),
                session_id: string(args, "sessionId")?,
                set: if selected {
                    BTreeMap::from([(marker.clone(), "true".to_owned())])
                } else {
                    BTreeMap::new()
                },
                remove: if selected { vec![] } else { vec![marker] },
            })
        }
        "stop" => ProductRequest::StopSession(StopSessionRequest {
            mutation: mutation(ProductOperation::StopSession),
            session_id: string(args, "sessionId")?,
            expected_revision: None,
            force: args["force"].as_bool().ok_or("Missing force selection")?,
            graceful_only: false,
        }),
        "restart" => ProductRequest::RestartSession(RestartSessionRequest {
            mutation: mutation(ProductOperation::RestartSession),
            session_id: string(args, "sessionId")?,
            force: args["force"].as_bool().ok_or("Missing force selection")?,
        }),
        "remove" => {
            if args["confirmed"] != true {
                return Err("Confirm session removal first".into());
            }
            ProductRequest::RemoveSession(RemoveSessionRequest {
                mutation: mutation(ProductOperation::RemoveSession),
                session_id: string(args, "sessionId")?,
                confirmation: RemovalConfirmationDto::Confirmed,
            })
        }
        "inspect" => ProductRequest::GetSessionDetail(GetSessionDetailRequest {
            session_id: string(args, "sessionId")?,
            projection: SessionDetailProjectionDto {
                configuration: true,
                work_context: true,
                process: true,
                foreground_evidence: true,
                health_results: true,
            },
        }),
        "events" => ProductRequest::ReadSessionEvents(ReadSessionEventsRequest {
            tail: true,
            include_observation: true,
            session_ids: vec![string(args, "sessionId")?],
            kinds: vec![],
            after_sequence: None,
            limit: 100,
        }),
        "list" => ProductRequest::ListSessions(ListSessionsRequest {
            filter: SessionFilterDto::default(),
            sort: SessionSortDto::default(),
            projection: SessionProjectionDto::WithLabels,
            page_size: 100,
            cursor: args["cursor"].as_str().map(str::to_owned),
            include_total: true,
        }),
        "create" => {
            let cwd = env::var("TERMINAL_CWD")
                .unwrap_or_else(|_| env::var("HOME").unwrap_or_else(|_| "/".into()));
            let mut request: StartSessionRequest = serde_json::from_value(json!({
                "launch_mode":"native", "name":string(args,"name")?,
                "command":{"program":env::var("TERMINAL_SHELL").unwrap_or_else(|_| "/bin/bash".into()),"arguments":if cfg!(windows) { vec![] } else { vec!["-i"] }},
                "working_directory":cwd,"terminal":size(args)?,
                "environment":{"schema_version":EnvironmentSchemaVersionDto::Current,"variables":{"TERM":"xterm-256color","COLORTERM":"truecolor"},
                    "file":null,"binding":{"working_directory_root":cwd,
                    "binding_digest_sha256":standalone_environment_binding_digest_sha256(&cwd)}},
                "profile":null,"labels":suite_terminal_labels()
            })).map_err(|e|e.to_string())?;
            request.mutation = mutation(ProductOperation::StartSession);
            ProductRequest::StartSession(request)
        }
        "input" => ProductRequest::SendTerminalInput(SendTerminalInputRequest {
            mutation: mutation(ProductOperation::SendTerminalInput),
            session_id: string(args, "sessionId")?,
            expected_revision: None,
            delivery_id: Some(uuid::Uuid::new_v4().to_string()),
            items: vec![TerminalInputDto::Raw {
                bytes: STANDARD
                    .decode(string(args, "data")?)
                    .map_err(|_| "Invalid input encoding")?,
            }],
            observation_policy: InputObservationPolicyDto::Preserve,
        }),
        "resize" => ProductRequest::ResizeTerminal(ResizeTerminalRequest {
            mutation: mutation(ProductOperation::ResizeTerminal),
            session_id: string(args, "sessionId")?,
            size: size(args)?,
        }),
        _ => return Err("Unknown bridge operation".into()),
    };
    let pending = client
        .request_cancellable(request)
        .map_err(|e| BridgeError::sdk(e, false))?;
    let result = pending
        .wait(cmd.remaining())
        .map_err(|e| BridgeError::sdk(e, true))?;
    let mut value = serde_json::to_value(result).map_err(|e| e.to_string())?;
    exact_counters(&mut value);
    if cmd.op == "events" {
        if let Some(seq) = value["result"]["checkpoint"].as_u64() {
            value["result"]["checkpoint"] = json!(seq.to_string());
        }
        if let Some(items) = value["result"]["items"].as_array_mut() {
            for item in items {
                if let Some(seq) = item["sequence"].as_u64() {
                    item["sequence"] = json!(seq.to_string());
                }
            }
        }
    }
    emit(
        out,
        json!({"type":"result","id":cmd.id,"result":value["result"]}),
    );
    Ok(())
}
fn run(out: Output) -> Result<(), Box<dyn std::error::Error>> {
    let group_config = Arc::new(load_cli_config(&ConfigDiscovery::from_process_env(None))?);
    // Each browser owns an independent SDK client. Reusing an identity can
    // collide with a bridge that is still draining after a browser reconnect.
    let profile =
        StandaloneClientProfile::standard(format!("aixand-terminal-{}", uuid::Uuid::new_v4()))?;
    let config = LocalClientConfig::new(
        group_config.connection().endpoint().to_path_buf(),
        profile.hello().clone(),
        profile.local(),
    )?;
    let client = ProductClient::connect_with_initial_policy(
        Arc::new(LocalClientConnector::new(config)),
        profile.product(),
        StandaloneClientProfile::single_connection_attempt("terminal-startup")?
            .product()
            .recovery_policy(),
        Arc::new(DeterministicClientRecoveryJitter::new(
            uuid::Uuid::new_v4().as_u64_pair().0,
        )),
    )?;
    let streams = Arc::new(Mutex::new(Streams::default()));
    let window = Arc::new(DeliveryWindow::default());
    let stopped = Arc::new(AtomicBool::new(false));
    let monitor_stop = stopped.clone();
    let monitor_client = client.clone();
    let monitor_output = out.clone();
    let monitor = thread::spawn(move || {
        let mut previous = None;
        let mut heartbeat = Instant::now();
        while !monitor_stop.load(Ordering::Acquire) {
            let pressure = monitor_client.pressure();
            let next = (pressure.phase, pressure.generation);
            if previous != Some(next) || heartbeat.elapsed() >= Duration::from_secs(5) {
                let phase = match pressure.phase {
                    ResilientClientPhase::Connected => "connected",
                    ResilientClientPhase::Recovering => "recovering",
                    ResilientClientPhase::Failed(_) => "failed",
                    ResilientClientPhase::Closed => "closed",
                };
                emit(
                    &monitor_output,
                    json!({"type":"backend-state","phase":phase,"generation":pressure.generation.to_string(),"attempts":pressure.physical_connection_attempts,"diagnostics":monitor_client.telemetry_diagnostics().unwrap_or_default().into_iter().rev().take(16).map(|name|name.as_str()).collect::<Vec<_>>()}),
                );
                previous = Some(next);
                heartbeat = Instant::now();
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
    emit(&out, json!({"type":"ready"}));
    enum Event {
        Command(Command),
        Finished(Vec<String>, u8),
        End,
    }
    let (sender, receiver) = mpsc::sync_channel::<Event>(64);
    let input = sender.clone();
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = stdin.lock();
        loop {
            use std::io::Read;
            let mut line = String::new();
            match (&mut reader).take(MAX_LINE + 1).read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(count) if count as u64 > MAX_LINE => break,
                _ => {
                    if let Ok(cmd) = serde_json::from_str::<Command>(&line) {
                        if input.send(Event::Command(cmd)).is_err() {
                            return;
                        }
                    } else {
                        break;
                    }
                }
            }
        }
        let _ = input.send(Event::End);
    });
    let mut scheduler: Scheduler<Command> = Scheduler::default();
    loop {
        let Ok(event) = receiver.recv() else {
            break;
        };
        match event {
            Event::End => break,
            Event::Finished(keys, priority) => scheduler.finish(keys, priority),
            Event::Command(mut cmd) => {
                if cmd.op == "ack" {
                    if let (Some(stream), Some(sequence)) = (
                        cmd.args["stream"].as_str(),
                        cmd.args["sequence"].as_str().and_then(|s| s.parse().ok()),
                    ) {
                        window.ack(stream, sequence);
                    }
                    continue;
                }
                if scheduler.queued.len() + scheduler.active
                    >= if cmd.priority() == 0 { 32 } else { 28 }
                {
                    let mut cause =
                        BridgeError::from("Terminal is busy. The request was not submitted.");
                    cause.code = "overloaded".into();
                    cause.retryable = true;
                    error(&out, &cmd, cause);
                    continue;
                }
                if matches!(
                    cmd.op.as_str(),
                    "attach" | "detach" | "watch" | "watch-open" | "watch-events" | "unwatch"
                ) {
                    let key = if matches!(cmd.op.as_str(), "attach" | "detach") {
                        cmd.args["paneId"].as_str().unwrap_or("main").to_owned()
                    } else {
                        watch_key(&cmd)
                    };
                    let mut registry = streams.lock().unwrap();
                    let version = registry.versions.entry(key).or_default();
                    *version += 1;
                    cmd.version = *version;
                }
                let keys = cmd.key();
                let priority = cmd.priority();
                scheduler.queued.push_back((cmd, keys, priority));
            }
        }
        while let Some((cmd, keys, priority)) = scheduler.pop_ready() {
            let client = client.clone();
            let config = group_config.clone();
            let output = out.clone();
            let registry = streams.clone();
            let deliveries = window.clone();
            let completed = sender.clone();
            thread::spawn(move || {
                let started = Instant::now();
                let execute_job = || -> Result<(), BridgeError> {
                    if cmd.received.elapsed() >= cmd.budget() {
                        let mut e =
                            BridgeError::from("Terminal request expired before submission.");
                        e.code = "timeout".into();
                        e.retryable = true;
                        return Err(e);
                    }
                    if cmd.version > 0 {
                        let key = if matches!(cmd.op.as_str(), "attach" | "detach") {
                            cmd.args["paneId"].as_str().unwrap_or("main").to_owned()
                        } else {
                            watch_key(&cmd)
                        };
                        if registry.lock().unwrap().versions.get(&key) != Some(&cmd.version) {
                            return Err("Attachment superseded".into());
                        }
                    }
                    let budget_client = BudgetClient {
                        client: &client,
                        deadline: cmd.received + cmd.budget(),
                    };
                    let needs_groups = cmd.op == "groups"
                        || cmd.op.starts_with("group-")
                        || (cmd.op == "create" && cmd.args["group"].is_string());
                    let groups = if needs_groups {
                        Some(
                            GroupClient::new(&budget_client, &config, cmd.remaining())
                                .map_err(BridgeError::cli)?
                                .with_launch_context(
                                    suite_terminal_labels(),
                                    BTreeMap::new(),
                                )
                                .map_err(BridgeError::cli)?,
                        )
                    } else {
                        None
                    };
                    let cleaner = if cmd.op == "clean" {
                        Some(FiniteCliExecutor::new(
                            &budget_client,
                            cmd.remaining(),
                            CliExecutionLimits::from_daemon(&config).map_err(|e| e.to_string())?,
                        ))
                    } else {
                        None
                    };
                    execute(
                        Execution {
                            client: &client,
                            out: &output,
                            streams: &registry,
                            window: &deliveries,
                        },
                        groups.as_ref(),
                        cleaner.as_ref(),
                        &cmd,
                    )
                };
                if let Err(cause) = execute_job() {
                    error(&output, &cmd, cause);
                }
                // Payload-free operation timings, available to a diagnostic consumer.
                let queued = cmd.received.elapsed().saturating_sub(started.elapsed());
                if queued >= Duration::from_millis(50)
                    || started.elapsed() >= Duration::from_millis(100)
                {
                    emit(
                        &output,
                        json!({"type":"request-metric","operation":cmd.op,"queueMillis":queued.as_millis(),"durationMillis":started.elapsed().as_millis()}),
                    );
                }
                if matches!(cmd.op.as_str(), "detach" | "unwatch") {
                    let key = if cmd.op == "detach" {
                        cmd.args["paneId"].as_str().unwrap_or("main").to_owned()
                    } else {
                        watch_key(&cmd)
                    };
                    let mut registry = registry.lock().unwrap();
                    if registry.versions.get(&key) == Some(&cmd.version) {
                        registry.versions.remove(&key);
                    }
                }
                let _ = completed.send(Event::Finished(keys, priority));
            });
        }
    }
    stopped.store(true, Ordering::Release);
    client.close();
    let active = std::mem::take(&mut streams.lock().unwrap().active);
    for (_, pane) in active {
        detach(Some(pane));
    }
    let _ = monitor.join();
    Ok(())
}

fn main() {
    let out = Output::new();
    if let Err(e) = run(out.clone()) {
        emit(
            &out,
            json!({"type":"fatal","message":format!("Cannot connect to Undercurrent: {e}")}),
        );
        out.flush();
        out.close();
        std::process::exit(1);
    }
    out.flush();
    out.close();
}
