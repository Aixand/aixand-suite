//! Private transport adapter for the existing IR APIs. No workflow semantics
//! or scheduling are implemented by the Web gateway.
use aixand_ir::*;
use aixand_ir_runner::*;
use serde::Deserialize;
use serde_json::{Value as Json, json};
use std::{
    io::{self, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_util::sync::CancellationToken;

type Output = Arc<Mutex<io::Stdout>>;
fn emit(out: &Output, message: Json) {
    let mut writer = out.lock().expect("output lock");
    let _ = serde_json::to_writer(&mut *writer, &message);
    let _ = writer.write_all(b"\n");
    let _ = writer.flush();
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Command {
    id: String,
    op: String,
    #[serde(default)]
    args: Json,
}
struct Host {
    catalogs: Vec<Catalog>,
    registry: CatalogRegistry,
    sdk: Option<aixand_ir_aixand::Config>,
}

// Apply only identifier changes made by the typed IR reader. Keep the original
// JSON shape (including explicit defaults) and all user literals intact.
fn apply_contract_renames(document: &mut Json, normalized: &Json) {
    match (document, normalized) {
        (Json::Object(original), Json::Object(current)) => {
            for (key, value) in original {
                if let Some(normalized) = current.get(key) {
                    apply_contract_renames(value, normalized);
                }
            }
        }
        (Json::Array(original), Json::Array(current)) => {
            for (value, normalized) in original.iter_mut().zip(current) {
                apply_contract_renames(value, normalized);
            }
        }
        (Json::String(original), Json::String(current))
            if (original == "intessio" || original.starts_with("intessio."))
                && *current == original.replacen("intessio", "aixand", 1) =>
        {
            original.clone_from(current);
        }
        _ => {}
    }
}

impl Host {
    fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let catalogs = if let Some(paths) = std::env::var_os("WORKFLOW_CATALOG_PATHS") {
            std::env::split_paths(&paths)
                .map(|p| Ok(parse_catalog(&std::fs::read_to_string(p)?)?))
                .collect::<Result<Vec<_>, Box<dyn std::error::Error>>>()?
        } else {
            vec![
                parse_catalog(AIXAND_CATALOG)?,
                parse_catalog(VERIFIER_CATALOG)?,
            ]
        };
        let sdk = std::env::var_os("WORKFLOW_SDK_CONFIG")
            .map(|path| -> Result<_, Box<dyn std::error::Error>> {
                Ok(serde_json::from_value(parse_json(
                    &std::fs::read_to_string(PathBuf::from(path))?,
                )?)?)
            })
            .transpose()?;
        Ok(Self {
            registry: CatalogRegistry::new(catalogs.clone())?,
            catalogs,
            sdk,
        })
    }
    fn source<'a>(&self, args: &'a Json) -> Result<&'a str, Failure> {
        args["source"]
            .as_str()
            .ok_or_else(|| Failure::new("request", "Expected workflow source string"))
    }
    fn validate(&self, source: &str) -> Json {
        let workflow = match parse_workflow(source) {
            Ok(workflow) => workflow,
            Err(error) => return json!({"valid":false,"phase":"structural","diagnostics":error.0}),
        };
        let mut document = parse_json(source).expect("parsed source");
        apply_contract_renames(
            &mut document,
            &to_json(&workflow).expect("portable workflow"),
        );
        match validate_workflow(&workflow, &self.registry) {
            Ok(warnings) => {
                json!({"valid":true,"diagnostics":warnings,"document":document,
                    "canonical":String::from_utf8(canonicalize(&document).expect("validated JSON")).expect("UTF8")})
            }
            Err(error) => {
                json!({"valid":false,"phase":"semantic","diagnostics":error.0,"document":document})
            }
        }
    }
    fn references(&self, args: &Json) -> Result<Json, Failure> {
        let workflow = parse_workflow(self.source(args)?)?;
        let expected: Type = serde_json::from_value(args["expected"].clone())
            .map_err(|e| Failure::new("type", e.to_string()))?;
        validate_type(&expected, "expected")?;
        let before = args["before"]
            .as_u64()
            .ok_or_else(|| Failure::new("request", "Expected sequence position"))?
            as usize;
        let mut candidates = vec![];
        for (name, input) in &workflow.inputs {
            collect_references(
                &input.ty,
                &expected,
                json!({"kind":"ref","source":"input","name":name}),
                format!("workflow.{name}"),
                &mut candidates,
                0,
            );
        }
        let sequence = args["sequence"].as_str().unwrap_or("/body");
        for step in visible_operations(&workflow, sequence, before)? {
            if let Some(definition) = self
                .registry
                .resolve(step.identity().expect("visible operation"))
            {
                for (output, port) in &definition.outputs {
                    collect_references(
                        &port.ty,
                        &expected,
                        json!({"kind":"ref","source":"step","step":step.id(),"output":output}),
                        format!("{}.{output}", step.id()),
                        &mut candidates,
                        0,
                    );
                }
            }
        }
        Ok(json!(candidates))
    }
    async fn run(
        &self,
        args: Json,
        out: Output,
        id: String,
        cancellation: CancellationToken,
    ) -> Result<Json, Failure> {
        let workflow = parse_workflow(self.source(&args)?)?;
        validate_workflow(&workflow, &self.registry)?;
        let mut bindings = BindingRegistry::default();
        aixand_ir_verifier::register(&mut bindings)?;
        let scope = Scope::new(CleanupPolicy::StopOwned);
        if let Some(config) = &self.sdk {
            let mut labels = json!({"app":"aixand-suite","feature":"workflow","workflow.run_id":id});
            if let Some(name) = &workflow.name {
                if name.len() <= 256 && !name.chars().any(char::is_control) {
                    labels["workflow.name"] = json!(name);
                }
            }
            let config = config.with_context(&json!({"labels":labels,"metadata":{"suite.execution_id":id}}))?;
            let known = CatalogRegistry::new([parse_catalog(AIXAND_CATALOG)?])?;
            let selected = Catalog {
                contract_version: "0.1".into(),
                package: parse_catalog(AIXAND_CATALOG)?.package,
                operations: self
                    .registry
                    .definitions()
                    .filter(|d| known.resolve(&d.identity()).is_some())
                    .map(|d| d.as_ref().clone())
                    .collect(),
            };
            let selected = CatalogRegistry::new([selected])?;
            if let Err(mut error) =
                aixand_ir_aixand::install_catalog(&scope, &mut bindings, config, &selected)
            {
                if let Err(cleanup) = scope.close().await {
                    error.cleanup_errors.push(cleanup);
                }
                return Err(error);
            }
        }
        Runner::new(self.registry.clone(), bindings)
            .with_observer(move |event| {
                let event = match event {
                    Event::Prepared { warnings } => json!({"event":"prepared","warnings":warnings}),
                    Event::Started {
                        invocation,
                        operation,
                    } => json!({"event":"started","invocation":invocation,"operation":operation}),
                    Event::Published { invocation } => {
                        json!({"event":"published","invocation":invocation})
                    }
                    Event::Failed { failure } => json!({"event":"failed","failure":failure}),
                    Event::BranchEvaluated { invocation, result, selected } => json!({"event":"branch_evaluated","invocation":invocation,"result":result,"selected":selected}),
                    Event::Completed => json!({"event":"completed"}),
                };
                emit(&out, json!({"type":"run-event","id":id,"event":event}));
            })
            .run_scoped_json(
                &workflow,
                args.get("inputs").cloned().unwrap_or(json!({})),
                scope,
                cancellation,
            )
            .await
    }
}
fn collect_references(
    ty: &Type,
    expected: &Type,
    reference: Json,
    label: String,
    candidates: &mut Vec<Json>,
    depth: usize,
) {
    if candidates.len() >= 1000 || depth > 12 {
        return;
    }
    if compatible(ty, expected) {
        candidates.push(json!({"label":label,"value":reference,"type":ty}));
    }
    if let Type::Object {
        properties,
        required,
        nullable: false,
        ..
    } = ty
    {
        for (key, child) in properties {
            if !required.contains(key) {
                continue;
            }
            let mut next = reference.clone();
            let mut path = next
                .get("path")
                .and_then(Json::as_array)
                .cloned()
                .unwrap_or_default();
            path.push(json!(key));
            next["path"] = json!(path);
            collect_references(
                child,
                expected,
                next,
                format!("{label}.{key}"),
                candidates,
                depth + 1,
            );
        }
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = Arc::new(Mutex::new(io::stdout()));
    let host = match Host::load() {
        Ok(host) => Arc::new(host),
        Err(e) => {
            emit(&out, json!({"type":"fatal","message":e.to_string()}));
            return Ok(());
        }
    };
    emit(
        &out,
        json!({"type":"ready","sdkConfigured":host.sdk.is_some()}),
    );
    let mut reader = BufReader::new(tokio::io::stdin());
    let mut active: Option<(CancellationToken, tokio::task::JoinHandle<()>)> = None;
    loop {
        let mut line = vec![];
        // Bound each frame before parsing, including the last frame at EOF.
        let length = tokio::io::AsyncReadExt::take(&mut reader, 1_048_577)
            .read_until(b'\n', &mut line)
            .await?;
        if length == 0 {
            break;
        }
        if length > 1_048_576 {
            break;
        }
        let command: Command = match serde_json::from_slice(&line) {
            Ok(command) => command,
            Err(e) => {
                emit(&out, json!({"type":"fatal","message":e.to_string()}));
                break;
            }
        };
        if active.as_ref().is_some_and(|(_, task)| task.is_finished())
            && let Some((_, task)) = active.take()
        {
            let _ = task.await;
        }
        let result = match command.op.as_str() {
            "catalogs" => Ok(json!({"catalogs":host.catalogs,"sdkConfigured":host.sdk.is_some()})),
            "validate" => host.source(&command.args).map(|s| host.validate(s)),
            "references" => host.references(&command.args),
            "example" => {
                let text = if command.args["variant"] == "branch" {
                    include_str!("../../../aixand-ir/examples/branching/workflow.json")
                } else if command.args["variant"] == "branch-python" {
                    include_str!("../../../aixand-ir/examples/branching/generated.json")
                } else if command.args["variant"] == "python" {
                    include_str!("../../../aixand-ir/examples/python/managed_codex_two_turns.json")
                } else {
                    include_str!("../../../aixand-ir/examples/real-agent/workflow.json")
                };
                Ok(json!({"document":parse_json(text)?}))
            }
            "cancel" => {
                if let Some((token, _)) = &active {
                    token.cancel();
                }
                Ok(json!({"requested":true}))
            }
            "run" if active.is_none() => {
                let token = CancellationToken::new();
                let child = token.clone();
                let run_host = host.clone();
                let run_out = out.clone();
                let id = command.id.clone();
                let task = tokio::spawn(async move {
                    let result = run_host
                        .run(command.args, run_out.clone(), id.clone(), child)
                        .await;
                    match result {
                        Ok(outputs) => emit(
                            &run_out,
                            json!({"type":"run-result","id":id,"outputs":outputs}),
                        ),
                        Err(failure) => emit(
                            &run_out,
                            json!({"type":"run-failure","id":id,"failure":failure}),
                        ),
                    }
                });
                active = Some((token, task));
                continue;
            }
            "run" => Err(Failure::new(
                "busy",
                "A workflow is already running in this connection",
            )),
            _ => Err(Failure::new("request", "Unknown workflow request")),
        };
        match result {
            Ok(result) => emit(
                &out,
                json!({"type":"result","id":command.id,"result":result}),
            ),
            Err(failure) => emit(
                &out,
                json!({"type":"error","id":command.id,"message":failure.message,"failure":failure}),
            ),
        }
    }
    if let Some((token, task)) = active {
        token.cancel();
        let _ = task.await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn host() -> Host {
        let catalog = parse_catalog(AIXAND_CATALOG).unwrap();
        Host {
            registry: CatalogRegistry::new([catalog.clone()]).unwrap(),
            catalogs: vec![catalog],
            sdk: None,
        }
    }
    const HAND: &str = include_str!("../../../aixand-ir/examples/real-agent/workflow.json");
    #[test]
    fn validated_canonical_round_trip_preserves_the_document() {
        let host = host();
        for source in [
            HAND,
            include_str!("../../../aixand-ir/examples/python/managed_codex_two_turns.json"),
        ] {
            let result = host.validate(source);
            assert_eq!(result["valid"], true);
            let canonical = result["canonical"].as_str().unwrap();
            assert_eq!(parse_json(canonical).unwrap(), parse_json(source).unwrap());
            assert_eq!(host.validate(canonical)["valid"], true);
        }
    }
    #[test]
    fn legacy_drafts_return_current_identifiers_and_preserve_literal_text() {
        let mut legacy = parse_json(&HAND.replace("aixand", "intessio")).unwrap();
        legacy["inputs"]["task"]["default"] = json!("intessio.agents.spawn");
        let result = host().validate(&legacy.to_string());
        assert_eq!(result["valid"], true);
        assert_eq!(
            result["document"]["body"]["steps"][0]["operation"]["id"],
            "aixand.agents.spawn"
        );
        assert_eq!(
            result["document"]["inputs"]["task"]["default"],
            "intessio.agents.spawn"
        );
        assert_eq!(
            host().validate(result["canonical"].as_str().unwrap())["document"],
            result["document"]
        );
    }
    #[test]
    fn filtering_uses_core_types_and_only_earlier_outputs() {
        let host = host();
        let args = json!({"source":HAND,"before":1,"expected":{"kind":"opaque","id":"aixand.agent","version":"1"}});
        let refs = host.references(&args).unwrap();
        assert_eq!(refs.as_array().unwrap().len(), 1);
        assert_eq!(refs[0]["label"], "spawn.agent");
        let mut early = args.clone();
        early["before"] = json!(0);
        assert_eq!(host.references(&early).unwrap(), json!([]));
        let mut receipts = args;
        receipts["expected"]["id"] = json!("aixand.input_receipt");
        assert_eq!(host.references(&receipts).unwrap(), json!([]));
        receipts["before"] = json!(2);
        assert_eq!(
            host.references(&receipts).unwrap()[0]["label"],
            "send_task.receipt"
        );
    }
    #[test]
    fn reorder_remove_and_opaque_mismatch_report_core_locations() {
        let host = host();
        let mut document = parse_json(HAND).unwrap();
        document["body"]["steps"].as_array_mut().unwrap().swap(0, 1);
        let invalid = host.validate(&document.to_string());
        assert_eq!(invalid["diagnostics"][0]["code"], "forward_reference");
        assert_eq!(invalid["diagnostics"][0]["invocation_id"], "send_task");
        assert!(invalid["document"].is_object());
        document = parse_json(HAND).unwrap();
        document["body"]["steps"][2]["inputs"]["after"]["output"] = json!("agent");
        document["body"]["steps"][2]["inputs"]["after"]["step"] = json!("spawn");
        assert_eq!(
            host.validate(&document.to_string())["diagnostics"][0]["code"],
            "incompatible_type"
        );
        document["body"]["steps"].as_array_mut().unwrap().remove(0);
        assert_eq!(host.validate(&document.to_string())["valid"], false);
    }
    #[test]
    fn structural_validation_does_not_lose_json_lexemes() {
        let result = host().validate(r#"{"ir_version":"0.1","ir_version":"0.1"}"#);
        assert_eq!(result["valid"], false);
        assert_eq!(result["phase"], "structural");
        assert!(result.get("document").is_none());
    }
    #[tokio::test]
    async fn runner_failure_and_cancellation_are_propagated() {
        let host = host();
        let out = Arc::new(Mutex::new(io::stdout()));
        let error = host
            .run(
                json!({"source":HAND,"inputs":{"task":"test"}}),
                out.clone(),
                "run".into(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "missing_binding");
        let mut verifier_host = host;
        verifier_host.registry =
            CatalogRegistry::new([parse_catalog(VERIFIER_CATALOG).unwrap()]).unwrap();
        let source = include_str!("../../../aixand-ir/examples/verifier.json");
        let token = CancellationToken::new();
        token.cancel();
        let error = verifier_host.run(json!({"source":source,"inputs":parse_json(include_str!("../../../aixand-ir/examples/verifier-inputs.json")).unwrap()}), out, "cancel".into(), token).await.unwrap_err();
        assert_eq!(error.code, "cancelled");
    }
    #[test]
    fn branch_round_trips_and_reference_choices_use_core_block_scopes() {
        let catalog = parse_catalog(VERIFIER_CATALOG).unwrap();
        let host = Host {
            registry: CatalogRegistry::new([catalog.clone()]).unwrap(),
            catalogs: vec![catalog],
            sdk: None,
        };
        for source in [
            include_str!("../../../aixand-ir/examples/branching/workflow.json"),
            include_str!("../../../aixand-ir/examples/branching/generated.json"),
        ] {
            let validated = host.validate(source);
            assert_eq!(validated["valid"], true);
            let canonical = validated["canonical"].as_str().unwrap();
            assert_eq!(parse_json(canonical).unwrap(), parse_json(source).unwrap());
            let refs = |sequence: &str, before| {
                host.references(&json!({"source":source,"expected":{"kind":"boolean"},"sequence":sequence,"before":before})).unwrap().as_array().unwrap().iter().map(|v|v["label"].as_str().unwrap().to_owned()).collect::<Vec<_>>()
            };
            assert_eq!(
                refs("/body/steps/1/then", 1),
                ["verify_1.result.passed", "verify_2.result.passed"]
            );
            assert_eq!(refs("/body/steps/1/else", 0), ["verify_1.result.passed"]);
            assert_eq!(
                refs("/body", 3),
                ["verify_1.result.passed", "verify_4.result.passed"]
            );
            assert!(host.references(&json!({"source":source,"expected":{"kind":"boolean"},"sequence":"/body/steps/1/missing","before":0})).is_err());
        }
    }
}
