//! A file-driven Rust host. All application steps and dataflow live in the IR.
use aixand_ir::{CatalogRegistry, parse_catalog, parse_json, parse_workflow, validate_workflow};
use aixand_ir_aixand::{Config, install_catalog};
use aixand_ir_runner::{BindingRegistry, CleanupPolicy, Event, Failure, Runner, Scope};
use clap::Parser;
use serde_json::json;
use std::{fs, path::PathBuf, process::ExitCode};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(about = "Execute hand-authored Aixand IR through the Python SDK")]
struct Options {
    #[arg(long, default_value = "examples/real-agent/workflow.json")]
    workflow: PathBuf,
    #[arg(long, default_value = "examples/real-agent/catalog.json")]
    catalog: PathBuf,
    #[arg(long, default_value = "examples/real-agent/inputs.json")]
    inputs: PathBuf,
    /// Runtime options only; see examples/real-agent/README.md.
    #[arg(long)]
    sdk_config: PathBuf,
}

fn read(path: &PathBuf) -> Result<String, Failure> {
    fs::read_to_string(path)
        .map_err(|error| Failure::new("file", format!("{}: {error}", path.display())))
}

async fn execute(options: Options) -> Result<serde_json::Value, Failure> {
    let workflow = parse_workflow(&read(&options.workflow)?)?;
    let catalog = CatalogRegistry::new([parse_catalog(&read(&options.catalog)?)?])?;
    validate_workflow(&workflow, &catalog)?;
    let inputs = parse_json(&read(&options.inputs)?)?;
    let config: Config = serde_json::from_value(parse_json(&read(&options.sdk_config)?)?)
        .map_err(|error| Failure::new("config", error.to_string()))?;
    let scope = Scope::new(CleanupPolicy::StopOwned);
    let mut bindings = BindingRegistry::default();
    if let Err(mut error) = install_catalog(&scope, &mut bindings, config, &catalog) {
        if let Err(cleanup) = scope.close().await {
            error.cleanup_errors.push(cleanup);
        }
        return Err(error);
    }
    let runner = Runner::new(catalog, bindings).with_observer(|event| {
        let record = match event {
            Event::Prepared { warnings } => json!({"event":"prepared", "warnings":warnings}),
            Event::Started {
                invocation,
                operation,
            } => json!({"event":"started", "invocation":invocation, "operation":operation}),
            Event::Published { invocation } => {
                json!({"event":"published", "invocation":invocation})
            }
            Event::Failed { failure } => json!({"event":"failed", "failure":failure}),
            Event::BranchEvaluated { invocation, result, selected } => json!({"event":"branch_evaluated", "invocation":invocation, "result":result, "selected":selected}),
            Event::Completed => json!({"event":"completed"}),
        };
        eprintln!("{record}");
    });
    let cancellation = CancellationToken::new();
    let signal_token = cancellation.clone();
    let signal = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_token.cancel();
        }
    });
    let result = runner
        .run_scoped_json(&workflow, inputs, scope, cancellation)
        .await;
    signal.abort();
    let _ = signal.await;
    result
}

#[tokio::main]
async fn main() -> ExitCode {
    match execute(Options::parse()).await {
        Ok(result) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&result).expect("JSON result")
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::to_string(&error).expect("structured failure")
            );
            ExitCode::FAILURE
        }
    }
}
