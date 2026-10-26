//! Private, bounded JSON-lines bridge. Only the parent NestJS process owns stdin/stdout.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    env,
    io::{self, BufRead, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
use undercurrent_cli::{
    CleanArguments, CliExecutionLimits, ConfigDiscovery, FiniteCliExecutor, GroupClient,
    load_cli_config,
};
use undercurrent_protocol::*;
use undercurrent_sdk::*;

const DEADLINE: Duration = Duration::from_secs(10);
const MAX_LINE: u64 = 100_000;
type Output = Arc<Mutex<io::Stdout>>;

fn emit(out: &Output, value: Value) {
    let mut writer = out.lock().unwrap();
    if serde_json::to_writer(&mut *writer, &value).is_err()
        || writer.write_all(b"\n").is_err()
        || writer.flush().is_err()
    {
        std::process::exit(0);
    }
}

#[derive(Deserialize)]
struct Command {
    id: String,
    op: String,
    #[serde(default)]
    args: Value,
}

struct Active {
    cancelled: Arc<AtomicBool>,
    subscription: Arc<ProductSubscription>,
    ack: mpsc::SyncSender<String>,
    worker: thread::JoinHandle<()>,
}
fn detach(active: Option<Active>) {
    if let Some(active) = active {
        active.cancelled.store(true, Ordering::Release);
        active.subscription.cancel();
        drop(active.ack);
        let _ = active.worker.join();
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
fn error(out: &Output, id: &str, message: impl ToString) {
    emit(
        out,
        json!({"type":"error","id":id,"message":message.to_string()}),
    );
}
fn execute(
    client: &ProductClient,
    groups: &GroupClient<'_, ProductClient>,
    cleaner: &FiniteCliExecutor<'_>,
    cmd: &Command,
    out: &Output,
    active: &mut BTreeMap<String, Active>,
) -> Result<(), String> {
    let args = &cmd.args;
    if cmd.op == "clean" {
        if args["confirmed"] != true {
            return Err("Confirm cleanup first".into());
        }
        let result = cleaner
            .clean_selected(
                &CleanArguments {
                    name: None,
                    all: false,
                    yes: true,
                },
                RemovalConfirmationDto::Confirmed,
            )
            .map_err(|e| format!("{e}. Cleanup was not retried. Refresh before trying again."))?;
        emit(out, json!({"type":"result","id":cmd.id,"result":result}));
        return Ok(());
    }
    if cmd.op == "groups"
        || cmd.op.starts_with("group-")
        || (cmd.op == "create" && args["group"].is_string())
    {
        let default_cwd = env::var("TERMINAL_CWD")
            .unwrap_or_else(|_| env::var("HOME").unwrap_or_else(|_| "/".into()));
        let default_shell = env::var("TERMINAL_SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let result = match cmd.op.as_str() {
            "groups" => {
                json!({"groups":groups.list().map_err(|e| e.to_string())?, "defaults":{"cwd":default_cwd,"shell":default_shell}})
            }
            "group-create" => {
                groups
                    .create(
                        &string(args, "name")?,
                        std::path::Path::new(args["cwd"].as_str().unwrap_or(&default_cwd)),
                        args["shell"].as_str().unwrap_or(&default_shell),
                        args["persistent"].as_bool().unwrap_or(true),
                    )
                    .map_err(|e| e.to_string())?;
                Value::Null
            }
            "group-delete" => {
                groups
                    .delete(&string(args, "group")?)
                    .map_err(|e| e.to_string())?;
                Value::Null
            }
            "group-assign" => {
                groups
                    .assign(
                        &string(args, "sessionId")?,
                        args["from"].as_str(),
                        args["to"].as_str(),
                    )
                    .map_err(|e| e.to_string())?;
                Value::Null
            }
            "group-restore" => {
                json!({"notices":groups.restore(&string(args, "group")?, &string(args, "sessionId")?, size(args)?).map_err(|e| e.to_string())?})
            }
            "group-reconcile" => {
                groups
                    .reconcile(&string(args, "group")?)
                    .map_err(|e| e.to_string())?;
                Value::Null
            }
            "create" => {
                json!({"session":groups.start(&string(args, "group")?, &string(args, "name")?, size(args)?).map_err(|e| e.to_string())?})
            }
            _ => return Err("Unknown group operation".into()),
        };
        emit(out, json!({"type":"result","id":cmd.id,"result":result}));
        return Ok(());
    }
    if cmd.op == "unwatch" {
        detach(active.remove(&format!("watch-{}", string(args, "kind")?)));
        emit(out, json!({"type":"result","id":cmd.id,"result":null}));
        return Ok(());
    }
    if cmd.op == "watch" || cmd.op == "watch-events" {
        let kind = if cmd.op == "watch" {
            "sessions"
        } else {
            "events"
        };
        let key = format!("watch-{kind}");
        detach(active.remove(&key));
        let spec = if kind == "sessions" {
            ProductStreamSpec::SessionWatch(SessionWatchSpec {
                query: ListSessionsRequest {
                    filter: SessionFilterDto::default(),
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
            .open_subscription(spec, DEADLINE)
            .map_err(|e| e.to_string())?;
        let subscription = Arc::new(opened.subscription);
        let stream = subscription.stream_id().to_string();
        emit(
            out,
            json!({"type":"result","id":cmd.id,"result":{"stream":stream}}),
        );
        let sub = subscription.clone();
        let output = out.clone();
        let (ack, receiver) = mpsc::sync_channel::<String>(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        let stopped = cancelled.clone();
        let worker = thread::spawn(move || {
            loop {
                let item = match sub.recv() {
                    Ok(item) => item,
                    Err(e) => {
                        if stopped.load(Ordering::Acquire) {
                            break;
                        }
                        emit(
                            &output,
                            json!({"type":"metadata-gap","kind":kind,"stream":stream,"message":e.to_string()}),
                        );
                        break;
                    }
                };
                let sequence = item.sequence().to_string();
                match item {
                    ProductSubscriptionItem::Json { item, .. } => {
                        let mut value = serde_json::to_value(item).unwrap();
                        if let Some(seq) = value["value"]["sequence"].as_u64() {
                            value["value"]["sequence"] = json!(seq.to_string());
                        }
                        emit(
                            &output,
                            json!({"type":"metadata","kind":kind,"stream":stream,"sequence":sequence,"payload":value}),
                        );
                    }
                    _ => {
                        emit(
                            &output,
                            json!({"type":"metadata-gap","kind":kind,"stream":stream,"message":"Live updates interrupted; refreshing snapshot."}),
                        );
                        break;
                    }
                }
                match receiver.recv_timeout(Duration::from_secs(30)) {
                    Ok(ack) if ack == sequence => (),
                    _ => {
                        if !stopped.load(Ordering::Acquire) {
                            emit(
                                &output,
                                json!({"type":"metadata-gap","kind":kind,"stream":stream,"message":"Metadata acknowledgement timed out."}),
                            );
                        }
                        break;
                    }
                }
            }
            sub.cancel();
        });
        active.insert(
            key,
            Active {
                cancelled,
                subscription,
                ack,
                worker,
            },
        );
        return Ok(());
    }
    let pane_id = args["paneId"].as_str().unwrap_or("main").to_owned();
    if cmd.op == "ack" {
        if let Some(active) = active
            .values()
            .find(|item| args["stream"].as_str() == Some(item.subscription.stream_id()))
        {
            let _ = active.ack.try_send(string(args, "sequence")?);
        }
        return Ok(());
    }
    if cmd.op == "detach" {
        detach(active.remove(&pane_id));
        emit(out, json!({"type":"result","id":cmd.id,"result":null}));
        return Ok(());
    }
    if cmd.op == "attach" {
        if active
            .keys()
            .filter(|key| !key.starts_with("watch-"))
            .count()
            >= 16
            && !active.contains_key(&pane_id)
        {
            return Err("Maximum of 16 terminal panes per connection".into());
        }
        detach(active.remove(&pane_id));
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
                DEADLINE,
            )
            .map_err(|e| e.to_string())?;
        let subscription = Arc::new(opened.subscription);
        let stream = subscription.stream_id().to_string();
        let (ack, receiver) = mpsc::sync_channel::<String>(1);
        emit(
            out,
            json!({"type":"result","id":cmd.id,"result":{"stream":stream,"sessionId":session_id}}),
        );
        let sub = subscription.clone();
        let output = out.clone();
        let worker = thread::spawn(move || {
            loop {
                let item = match sub.recv() {
                    Ok(item) => item,
                    Err(e) => {
                        emit(
                            &output,
                            json!({"type":"stream-error","stream":stream,"message":e.to_string()}),
                        );
                        break;
                    }
                };
                let sequence = item.sequence().to_string();
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
                emit(&output, value);
                // Do not consume more output until xterm has parsed this chunk.
                match receiver.recv_timeout(Duration::from_secs(30)) {
                    Ok(ack) if ack == sequence => (),
                    _ => {
                        emit(
                            &output,
                            json!({"type":"stream-error","stream":stream,"message":"Output acknowledgement timed out or stream detached."}),
                        );
                        break;
                    }
                }
            }
            sub.cancel();
        });
        active.insert(
            pane_id,
            Active {
                cancelled: Arc::new(AtomicBool::new(false)),
                subscription,
                ack,
                worker,
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
                "profile":null,"labels":{"app":"aixand-suite","feature":"terminal","session.kind":"shell"}
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
    let result = client.request(request, DEADLINE).map_err(|e| {
        // Never retry mutations on uncertain delivery: the caller must reconcile.
        format!("{e}. If this was a mutation, its effect may be uncertain; it was not retried. Refresh or inspect the session before trying again.")
    })?;
    let mut value = serde_json::to_value(result).map_err(|e| e.to_string())?;
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
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let out = Arc::new(Mutex::new(io::stdout()));
    let group_config = load_cli_config(&ConfigDiscovery::from_process_env(None))?;
    // Each browser owns an independent SDK client. Reusing an identity can
    // collide with a bridge that is still draining after a browser reconnect.
    let profile =
        StandaloneClientProfile::standard(format!("aixand-terminal-{}", uuid::Uuid::new_v4()))?;
    let config = LocalClientConfig::new(
        group_config.connection().endpoint().to_path_buf(),
        profile.hello().clone(),
        profile.local(),
    )?;
    let client = ProductClient::connect(
        Arc::new(LocalClientConnector::new(config)),
        profile.product(),
        Arc::new(DeterministicClientRecoveryJitter::new(1)),
    )?;
    let groups = GroupClient::new(&client, &group_config, DEADLINE)?.with_launch_context(
        BTreeMap::from([
            ("app".into(), "aixand-suite".into()),
            ("feature".into(), "terminal".into()),
            ("session.kind".into(), "shell".into()),
        ]),
        BTreeMap::new(),
    )?;
    let cleaner = FiniteCliExecutor::new(
        &client,
        DEADLINE,
        CliExecutionLimits::from_daemon(&group_config)?,
    );
    emit(&out, json!({"type":"ready"}));
    let mut active = BTreeMap::new();
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    loop {
        let mut line = String::new();
        use std::io::Read;
        let count = (&mut reader).take(MAX_LINE + 1).read_line(&mut line)?;
        if count == 0 {
            break;
        }
        if count as u64 > MAX_LINE {
            return Err("Bridge input exceeds limit".into());
        }
        match serde_json::from_str::<Command>(&line) {
            Ok(cmd) => {
                if let Err(e) = execute(&client, &groups, &cleaner, &cmd, &out, &mut active) {
                    error(&out, &cmd.id, e)
                }
            }
            Err(_) => error(&out, "", "Invalid bridge message"),
        }
    }
    for (_, pane) in active {
        detach(Some(pane));
    }
    client.close();
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        let out = Arc::new(Mutex::new(io::stdout()));
        emit(
            &out,
            json!({"type":"fatal","message":format!("Cannot connect to Undercurrent: {e}")}),
        );
        std::process::exit(1);
    }
}
