use aixand_ir::*;
use aixand_ir_runner::*;
use clap::{Parser, Subcommand, ValueEnum};
use std::{path::PathBuf, process::ExitCode};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(
    version,
    about = "Validate, canonicalize and run Aixand IR v0.1/v0.2 workflows"
)]
struct Args {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Lower restricted Python operations and if/elif/else without executing source.
    #[cfg(feature = "frontend")]
    LowerPython {
        file: PathBuf,
        #[arg(long)]
        catalog: Vec<PathBuf>,
        /// Frontend-only API mapping metadata; never runtime implementations.
        #[arg(long)]
        mappings: Option<PathBuf>,
    },
    /// Validate portable document structure and (unless --structural) contracts.
    Validate {
        file: PathBuf,
        #[arg(long)]
        catalog: Vec<PathBuf>,
        #[arg(long)]
        structural: bool,
        #[arg(long)]
        operation_catalog: bool,
    },
    /// Emit RFC 8785 canonical UTF-8 JSON (no semantic normalization).
    Canonicalize { file: PathBuf },
    /// Print a bundled Draft 2020-12 document schema.
    Schema {
        #[arg(value_enum)]
        kind: SchemaKind,
        /// Workflow expression version; operation contracts remain v0.1.
        #[arg(long, default_value = "0.1", value_parser = ["0.1", "0.2"])]
        ir_version: String,
    },
    /// Print a portable built-in operation catalog.
    Catalog {
        #[arg(value_enum)]
        package: PackageKind,
    },
    /// Execute with JSON inputs and outputs; verifier bindings are built in.
    Run {
        file: PathBuf,
        #[arg(long)]
        inputs: Option<PathBuf>,
        #[arg(long)]
        catalog: Vec<PathBuf>,
        #[arg(long)]
        stop_owned: bool,
        /// Runtime-only SDK configuration; requires building with --features sdk.
        #[arg(long)]
        sdk_config: Option<PathBuf>,
    },
}
#[derive(Clone, ValueEnum)]
enum SchemaKind {
    Workflow,
    Catalog,
    Shared,
}
#[derive(Clone, ValueEnum)]
enum PackageKind {
    Aixand,
    Verifier,
}

fn read(path: &PathBuf) -> Result<String, Failure> {
    std::fs::read_to_string(path)
        .map_err(|e| Failure::new("file", format!("{}: {e}", path.display())))
}
fn catalogs(paths: Vec<PathBuf>) -> Result<CatalogRegistry, Failure> {
    let mut all = vec![
        parse_catalog(AIXAND_CATALOG)?,
        parse_catalog(VERIFIER_CATALOG)?,
    ];
    for path in paths {
        all.push(parse_catalog(&read(&path)?)?);
    }
    Ok(CatalogRegistry::new(all)?)
}

async fn execute(args: Args) -> Result<(), Failure> {
    match args.command {
        #[cfg(feature = "frontend")]
        Command::LowerPython {
            file,
            catalog,
            mappings,
        } => {
            let selected = if catalog.is_empty() {
                catalogs(vec![])?
            } else {
                CatalogRegistry::new(
                    catalog
                        .iter()
                        .map(|path| Ok(parse_catalog(&read(path)?)?))
                        .collect::<Result<Vec<_>, Failure>>()?,
                )?
            };
            let mappings = match mappings {
                Some(path) => aixand_ir_frontend::MappingRegistry::from_json(&read(&path)?)?,
                None => aixand_ir_frontend::MappingRegistry::aixand(),
            };
            let workflow = aixand_ir_frontend::compile_python(
                &read(&file)?,
                &file.display().to_string(),
                &selected,
                &mappings,
            )
            .map_err(|error| {
                Failure::new("compiler", error.to_string())
                    .with_details(serde_json::json!({"diagnostics":error.diagnostics}))
            })?;
            println!(
                "{}",
                serde_json::to_string_pretty(&workflow)
                    .map_err(|e| Failure::new("json", e.to_string()))?
            );
        }
        Command::Canonicalize { file } => {
            use std::io::Write;
            let bytes = canonicalize(&parse_json(&read(&file)?)?)?;
            std::io::stdout()
                .write_all(&bytes)
                .map_err(|e| Failure::new("io", e.to_string()))?;
        }
        Command::Schema { kind, ir_version } => print!(
            "{}",
            match kind {
                SchemaKind::Workflow if ir_version == "0.2" => WORKFLOW_V02_SCHEMA,
                SchemaKind::Workflow => WORKFLOW_SCHEMA,
                SchemaKind::Catalog => CATALOG_SCHEMA,
                SchemaKind::Shared if ir_version == "0.2" => SHARED_V02_SCHEMA,
                SchemaKind::Shared => SHARED_SCHEMA,
            }
        ),
        Command::Catalog { package } => print!(
            "{}",
            match package {
                PackageKind::Aixand => AIXAND_CATALOG,
                PackageKind::Verifier => VERIFIER_CATALOG,
            }
        ),
        Command::Validate {
            file,
            catalog,
            structural,
            operation_catalog,
        } => {
            let text = read(&file)?;
            if operation_catalog {
                let parsed = parse_catalog(&text)?;
                if !structural {
                    CatalogRegistry::new([parsed])?;
                }
            } else {
                let workflow = parse_workflow(&text)?;
                if !structural {
                    for diagnostic in validate_workflow(&workflow, &catalogs(catalog)?)? {
                        eprintln!("{diagnostic}");
                    }
                }
            }
            println!("Valid");
        }
        Command::Run {
            file,
            inputs,
            catalog,
            stop_owned,
            sdk_config,
        } => {
            let workflow = parse_workflow(&read(&file)?)?;
            let inputs = match inputs {
                Some(path) => parse_json(&read(&path)?)?,
                None => serde_json::json!({}),
            };
            let catalogs = catalogs(catalog)?;
            let mut bindings = BindingRegistry::default();
            aixand_ir_verifier::register(&mut bindings)?;
            let scope = Scope::new(if stop_owned {
                CleanupPolicy::StopOwned
            } else {
                CleanupPolicy::Detach
            });
            if let Some(path) = sdk_config {
                #[cfg(feature = "sdk")]
                {
                    let config: aixand_ir_aixand::Config =
                        serde_json::from_value(parse_json(&read(&path)?)?)
                            .map_err(|e| Failure::new("sdk_config", e.to_string()))?;
                    let execution_id = format!(
                        "ir-{}-{}",
                        std::process::id(),
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_err(|_| Failure::new("clock", "Execution clock is unavailable"))?
                            .as_nanos()
                    );
                    let mut labels = serde_json::json!({"feature":"workflow","orchestrator":"aixand-ir","workflow.run_id":execution_id});
                    if config
                        .connection
                        .get("labels")
                        .and_then(|v| v.get("app"))
                        .is_none()
                    {
                        labels["app"] = serde_json::json!("aixand-ir");
                    }
                    if let Some(name) = &workflow.name {
                        if name.len() <= 256 && !name.chars().any(char::is_control) {
                            labels["workflow.name"] = serde_json::json!(name);
                        }
                    }
                    let config = config.with_context(&serde_json::json!({"labels":labels}))?;
                    if let Err(mut error) = aixand_ir_aixand::install(&scope, &mut bindings, config)
                    {
                        if let Err(cleanup) = scope.close().await {
                            error.cleanup_errors.push(cleanup);
                        }
                        return Err(error);
                    }
                }
                #[cfg(not(feature = "sdk"))]
                {
                    let _ = path;
                    return Err(Failure::new(
                        "sdk_disabled",
                        "Build aixand-ir-cli with --features sdk to use SDK bindings",
                    ));
                }
            }
            let cancellation = CancellationToken::new();
            let copy = cancellation.clone();
            let signal = tokio::spawn(async move {
                if tokio::signal::ctrl_c().await.is_ok() {
                    copy.cancel();
                }
            });
            let result = Runner::new(catalogs, bindings)
                .run_scoped_json(&workflow, inputs, scope, cancellation)
                .await;
            signal.abort();
            println!(
                "{}",
                serde_json::to_string_pretty(&result?)
                    .map_err(|e| Failure::new("json", e.to_string()))?
            );
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match execute(Args::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::to_string_pretty(&error).unwrap_or_else(|_| error.to_string())
            );
            ExitCode::FAILURE
        }
    }
}
