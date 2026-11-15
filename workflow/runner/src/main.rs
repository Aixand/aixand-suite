use clap::{Parser, Subcommand};
use job_runner::{
    Result, Service, Submission,
    client::{Client, default_home},
    engine::{Engine, IrEngine},
    model::{Events, Request},
    native::{WorkflowEngine, default_suite_socket},
};
use serde_json::{Value, json};
use std::{path::PathBuf, process::ExitCode, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(
    version,
    about = "Durable local jobs for Aixand IR and native chat workflows"
)]
struct Cli {
    /// Service state directory (defaults to RUNNER_HOME or XDG state directory).
    #[arg(long, global = true)]
    home: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run one local service with a bounded execution pool.
    Serve {
        /// Host-owned Aixand SDK configuration; requires a build with --features sdk.
        #[arg(long)]
        sdk_config: Option<PathBuf>,
        /// Maximum jobs executing concurrently. Queue claims remain FIFO.
        #[arg(long, default_value_t = 1)]
        workers: usize,
        /// Host-owned effect adapter socket (Suite or another compatible host).
        #[arg(long = "effect-host", alias = "suite-socket")]
        suite_socket: Option<PathBuf>,
    },
    Health,
    /// Submit workflow JSON. Reuse the key to recover a lost submission response.
    Submit {
        workflow: PathBuf,
        #[arg(long)]
        inputs: Option<PathBuf>,
        #[arg(long)]
        metadata: Option<PathBuf>,
        #[arg(long)]
        key: String,
    },
    List {
        #[arg(long, default_value_t = 0)]
        after: i64,
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    Inspect {
        id: String,
    },
    /// Find an accepted submission without creating or replaying effects.
    Lookup {
        key: String,
    },
    Result {
        id: String,
    },
    Events {
        id: String,
        #[arg(long)]
        follow: bool,
        #[arg(long, default_value_t = 0)]
        after: i64,
    },
    Cancel {
        id: String,
    },
    /// Cancel a submission key, including one whose acceptance is still unconfirmed.
    CancelKey {
        key: String,
    },
    /// Reconcile a native workflow's existing effects without creating new identities.
    Resume {
        id: String,
    },
    Plan {
        id: String,
    },
    Hold {
        id: String,
    },
    Release {
        id: String,
    },
    Amend {
        id: String,
        workflow: PathBuf,
        #[arg(long)]
        key: String,
        #[arg(long)]
        revision: u64,
        #[arg(long)]
        authoring: Option<PathBuf>,
    },
    Continue {
        id: String,
        target: PathBuf,
        #[arg(long)]
        key: String,
        #[arg(long)]
        input_map: Option<PathBuf>,
    },
    Continuations {
        id: String,
    },
    CancelContinuation {
        id: String,
    },
    EnableEdits {
        id: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        authoring: Option<PathBuf>,
        #[arg(long)]
        groups: Option<PathBuf>,
        #[arg(long)]
        identities: Option<PathBuf>,
    },
}

fn read(path: &PathBuf) -> Result<Value> {
    Ok(aixand_ir::parse_json(&std::fs::read_to_string(path)?)?)
}

fn engine(config: Option<PathBuf>, socket: PathBuf) -> Result<Arc<dyn Engine>> {
    if let Some(path) = config {
        #[cfg(feature = "sdk")]
        {
            return Ok(Arc::new(
                IrEngine::with_sdk(serde_json::from_value(read(&path)?)?)?
                    .with_suite_socket(socket)?,
            ));
        }
        #[cfg(not(feature = "sdk"))]
        {
            let _ = path;
            return Err(job_runner::Error::new(
                "configuration",
                "Rebuild with --features sdk to use --sdk-config",
            ));
        }
    }
    Ok(Arc::new(IrEngine::verifier()?.with_suite_socket(socket)?))
}

async fn run(cli: Cli) -> Result<()> {
    let home = cli.home.map_or_else(default_home, Ok)?;
    if let Command::Serve {
        sdk_config,
        workers,
        suite_socket,
    } = cli.command
    {
        let socket = suite_socket.unwrap_or_else(default_suite_socket);
        let configured = WorkflowEngine::new(engine(sdk_config, socket.clone())?, socket)?;
        let service = Service::open_with_workers(&home, Arc::new(configured), workers)?;
        let stop = CancellationToken::new();
        let signal_stop = stop.clone();
        #[cfg(unix)]
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let signals = tokio::spawn(async move {
            #[cfg(unix)]
            tokio::select! { _ = tokio::signal::ctrl_c() => (), _ = terminate.recv() => () }
            #[cfg(windows)]
            {
                let mut terminate =
                    tokio::signal::windows::ctrl_break().expect("Windows console signals");
                tokio::select! { _ = tokio::signal::ctrl_c() => (), _ = terminate.recv() => () }
            }
            signal_stop.cancel();
        });
        eprintln!("Runner service: {}", service.socket().display());
        let result = service.serve(stop).await;
        signals.abort();
        return result;
    }
    let client = Client::new(home);
    let request = match cli.command {
        Command::Health => Request::Health,
        Command::Submit {
            workflow,
            inputs,
            metadata,
            key,
        } => Request::Submit {
            submission: Submission {
                key,
                workflow: read(&workflow)?,
                inputs: inputs.as_ref().map(read).transpose()?.unwrap_or(json!({})),
                metadata: metadata
                    .as_ref()
                    .map(read)
                    .transpose()?
                    .unwrap_or(json!({})),
            },
        },
        Command::List { after, limit } => Request::List { after, limit },
        Command::Inspect { id } => Request::Inspect { id },
        Command::Lookup { key } => Request::Lookup { key },
        Command::Result { id } => Request::Result { id },
        Command::Cancel { id } => Request::Cancel { id },
        Command::CancelKey { key } => Request::CancelKey { key },
        Command::Resume { id } => Request::Resume { id },
        Command::Plan { id } => Request::Plan { id },
        Command::Hold { id } => Request::Hold { id },
        Command::Release { id } => Request::Release { id },
        Command::Amend {
            id,
            workflow,
            key,
            revision,
            authoring,
        } => Request::Amend {
            id,
            key,
            expected_revision: revision,
            workflow: read(&workflow)?,
            authoring: authoring.as_ref().map(read).transpose()?,
        },
        Command::Continue {
            id,
            target,
            key,
            input_map,
        } => Request::Continue {
            id,
            key,
            target: serde_json::from_value(read(&target)?)?,
            input_map: input_map
                .as_ref()
                .map(read)
                .transpose()?
                .map(serde_json::from_value)
                .transpose()?
                .unwrap_or_default(),
        },
        Command::Continuations { id } => Request::Continuations { id },
        Command::CancelContinuation { id } => Request::CancelContinuation { id },
        Command::EnableEdits {
            id,
            key,
            authoring,
            groups,
            identities,
        } => Request::EnableEdits {
            id,
            key,
            authoring: authoring.as_ref().map(read).transpose()?,
            groups: groups
                .as_ref()
                .map(read)
                .transpose()?
                .map(serde_json::from_value)
                .transpose()?
                .unwrap_or_default(),
            identities: identities
                .as_ref()
                .map(read)
                .transpose()?
                .map(serde_json::from_value)
                .transpose()?
                .unwrap_or_default(),
        },
        Command::Events {
            id,
            follow,
            mut after,
        } => {
            loop {
                let page: Events = serde_json::from_value(
                    client
                        .request(Request::Events {
                            id: id.clone(),
                            after,
                            limit: 100,
                        })
                        .await?,
                )?;
                for event in page.events {
                    println!("{}", serde_json::to_string(&event)?);
                }
                after = page.next_after;
                if page.has_more {
                    continue;
                }
                if !follow || page.state.settled() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            return Ok(());
        }
        Command::Serve { .. } => unreachable!(),
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&client.request(request).await?)?
    );
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::to_string(&error).unwrap_or_else(|_| error.to_string())
            );
            ExitCode::FAILURE
        }
    }
}
