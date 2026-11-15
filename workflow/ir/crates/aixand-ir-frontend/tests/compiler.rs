use aixand_ir::*;
use aixand_ir_frontend::{CompilerError, MappingRegistry, compile_python};
use serde_json::{Value as Json, json};

const SOURCE: &str = include_str!("../../../examples/python/managed_codex_two_turns.py");
const EXPECTED: &str = include_str!("../../../examples/real-agent/workflow.json");
const GENERATED: &str = include_str!("../../../examples/python/managed_codex_two_turns.json");
fn catalogs() -> CatalogRegistry {
    CatalogRegistry::new([
        parse_catalog(include_str!("../../../examples/real-agent/catalog.json")).unwrap(),
    ])
    .unwrap()
}
fn compile(source: &str) -> Result<Workflow, CompilerError> {
    compile_python(
        source,
        "fixture.py",
        &catalogs(),
        &MappingRegistry::aixand(),
    )
}
fn body(text: &str) -> String {
    format!("@aixand.workflow\nasync def f(task: str):\n{text}")
}
fn json_workflow(text: &str) -> Json {
    to_json(&compile(&body(text)).unwrap()).unwrap()
}

/// Alpha-renaming only: retain every operation, argument, expression, type,
/// input and output. Description is nonsemantic documentation.
fn normalized(workflow: Workflow) -> Json {
    let mut value = to_json(&workflow).unwrap();
    value.as_object_mut().unwrap().remove("description");
    let ids: Named<String> = workflow
        .body
        .steps()
        .iter()
        .enumerate()
        .map(|(i, step)| (step.id().into(), format!("step_{i}")))
        .collect();
    fn references(value: &mut Json, ids: &Named<String>) {
        match value {
            Json::Array(items) => {
                for item in items {
                    references(item, ids);
                }
            }
            Json::Object(fields) => {
                // Do not treat objects inside literal payloads as references.
                if fields.get("kind").and_then(Json::as_str) == Some("literal") {
                    return;
                }
                if fields.get("kind").and_then(Json::as_str) == Some("ref")
                    && fields.get("source").and_then(Json::as_str) == Some("step")
                {
                    fields.insert("step".into(), json!(ids[fields["step"].as_str().unwrap()]));
                }
                for child in fields.values_mut() {
                    references(child, ids);
                }
            }
            _ => {}
        }
    }
    for step in value["body"]["steps"].as_array_mut().unwrap() {
        step["id"] = json!(ids[step["id"].as_str().unwrap()]);
        references(&mut step["inputs"], &ids);
    }
    for output in value["outputs"].as_object_mut().unwrap().values_mut() {
        references(&mut output["value"], &ids);
    }
    value
}

#[test]
fn fixture_is_equivalent_to_verified_ir_including_all_outputs() {
    let compiled = compile(SOURCE).unwrap();
    assert_eq!(
        normalized(compiled.clone()),
        normalized(parse_workflow(EXPECTED).unwrap())
    );
    assert_eq!(compiled, parse_workflow(GENERATED).unwrap());
}

#[test]
fn invocation_ids_are_readable_and_deterministic() {
    let first = compile(SOURCE).unwrap();
    assert_eq!(first, compile(SOURCE).unwrap());
    assert_eq!(
        first
            .body
            .steps()
            .iter()
            .map(Operation::id)
            .collect::<Vec<_>>(),
        ["spawn_1", "send_1", "wait_1", "send_2", "wait_2", "stop_1"]
    );
}

#[test]
fn minimal_no_return_source_preserves_all_six_effects() {
    let source = SOURCE
        .split("    return {")
        .next()
        .unwrap()
        .replace("task_observation = ", "")
        .replace("summary_observation = ", "");
    let compiled = compile(&source).unwrap();
    let mut expected = parse_workflow(EXPECTED).unwrap();
    expected.outputs.clear();
    assert!(compiled.outputs.is_empty());
    assert_eq!(normalized(compiled), normalized(expected));
}

#[test]
fn workflow_and_parameters_cannot_shadow_api_namespaces() {
    for source in [
        "@aixand.workflow\nasync def aixand(task: str):\n    pass\n",
        "@aixand.workflow\nasync def f(aixand: str):\n    pass\n",
    ] {
        assert!(compile(source).is_err());
    }
    rejected("    await aixand.unknown()\n", "unknown_operation", 3);
}

#[test]
fn parameter_literals_receiver_and_reassigned_receipts_lower_to_references() {
    let workflow = to_json(&compile(SOURCE).unwrap()).unwrap();
    let steps = &workflow["body"]["steps"];
    assert_eq!(
        steps[0]["inputs"]["provider"],
        json!({"kind":"literal","value":"codex"})
    );
    assert_eq!(steps[0]["inputs"]["profile"]["value"], "backup");
    assert_eq!(steps[0]["inputs"]["cwd"]["value"], "..");
    assert_eq!(
        steps[1]["inputs"]["text"],
        json!({"kind":"ref","source":"input","name":"task"})
    );
    for index in 1..6 {
        assert_eq!(
            steps[index]["inputs"]["agent"],
            json!({"kind":"ref","source":"step","step":"spawn_1","output":"agent"})
        );
    }
    assert_eq!(steps[2]["inputs"]["after"]["step"], "send_1");
    assert_eq!(steps[4]["inputs"]["after"]["step"], "send_2");
    assert_eq!(
        steps[3]["inputs"]["text"]["value"],
        "Summarize your findings."
    );
    assert_eq!(workflow["outputs"]["run_id"]["value"]["output"], "run_id");
}

#[test]
fn omitted_null_and_explicit_receipt_are_distinct() {
    let workflow = json_workflow(
        "    agent = await aixand.agents.spawn()\n    receipt = await agent.send(task)\n    await agent.wait()\n    await agent.wait(after=None)\n    await agent.wait(after=receipt)\n",
    );
    let steps = &workflow["body"]["steps"];
    assert!(steps[2]["inputs"].get("after").is_none());
    assert_eq!(
        steps[3]["inputs"]["after"],
        json!({"kind":"literal","value":null})
    );
    assert_eq!(
        steps[4]["inputs"]["after"],
        json!({"kind":"ref","source":"step","step":"send_1","output":"receipt"})
    );
}

#[test]
fn aliases_rebind_without_mutating_previously_compiled_values() {
    let workflow = json_workflow(
        "    agent = await aixand.agents.spawn()\n    alias = agent\n    receipt = await alias.send(task)\n    earlier = receipt\n    receipt = await agent.send('second')\n    await alias.wait(after=earlier)\n    await agent.wait(after=receipt)\n    return alias.run_id\n",
    );
    assert_eq!(
        workflow["body"]["steps"][3]["inputs"]["after"]["step"],
        "send_1"
    );
    assert_eq!(
        workflow["body"]["steps"][4]["inputs"]["after"]["step"],
        "send_2"
    );
    assert_eq!(workflow["outputs"]["result"]["value"]["output"], "run_id");
}

#[test]
fn all_literal_types_and_nested_construction_use_existing_expressions() {
    let workflow = json_workflow(
        "    data = {'none': None, 'bool': True, 'integer': -7, 'float': +1.25, 'text': task, 'list': [False, 2, 'x']}\n    return {'data': data}\n",
    );
    let value = &workflow["outputs"]["data"]["value"];
    assert_eq!(value["kind"], "object");
    assert_eq!(value["fields"]["list"]["kind"], "array");
    assert_eq!(value["fields"]["integer"]["value"], -7);
    assert_eq!(value["fields"]["float"]["value"], 1.25);
    assert_eq!(value["fields"]["text"]["source"], "input");
}

#[test]
fn annotations_and_literal_defaults_are_checked_without_evaluation() {
    let nullable =
        compile("@aixand.workflow\nasync def f() -> str | None:\n    return None\n").unwrap();
    assert!(nullable.outputs["result"].ty.nullable());
    assert_eq!(
        nullable.outputs["result"].value,
        Expression::Literal { value: Json::Null }
    );
    let source = "@aixand.workflow\nasync def f(text: str = 'x', values: list[int] = [1, 2], data: dict[str, bool] = {'ok': True}, timeout: float | None = None) -> list[int]:\n    return values\n";
    let workflow = compile(source).unwrap();
    assert_eq!(workflow.inputs["timeout"].default, Some(Json::Null));
    assert!(workflow.inputs["timeout"].ty.nullable());
    assert_eq!(
        workflow.outputs["result"].ty,
        Type::Array {
            items: Box::new(Type::Integer { nullable: false }),
            nullable: false
        }
    );
    assert!(compile("@aixand.workflow\nasync def f(task: str = 5):\n    pass\n").is_err());
    assert!(compile("@aixand.workflow\nasync def f(task: str = str(5)):\n    pass\n").is_err());
    assert!(compile("@aixand.workflow\nasync def f() -> bool:\n    return 'wrong'\n").is_err());
}

fn rejected(text: &str, code: &str, line: usize) -> CompilerError {
    let error = compile(&body(text)).unwrap_err();
    let diagnostic = &error.diagnostics[0];
    assert_eq!(diagnostic.code, code, "{error}");
    assert_eq!(diagnostic.source.file, "fixture.py");
    assert_eq!(diagnostic.source.line, line, "{error}");
    assert!(diagnostic.source.column >= 5);
    assert!(
        diagnostic.source.end_column > diagnostic.source.column
            || diagnostic.source.end_line > line
    );
    error
}

#[test]
fn invalid_operation_and_missing_exact_contract_are_rejected() {
    rejected(
        "    await aixand.agents.teleport()\n",
        "unknown_operation",
        3,
    );
    let error = compile_python(
        SOURCE,
        "fixture.py",
        &CatalogRegistry::default(),
        &MappingRegistry::aixand(),
    )
    .unwrap_err();
    assert_eq!(error.diagnostics[0].code, "unknown_operation");
    assert!(error.to_string().contains("aixand.agents.spawn@1.0.0"));
}

#[test]
fn invalid_required_duplicate_and_typed_arguments_are_rejected() {
    rejected(
        "    agent = await aixand.agents.spawn(unknown=True)\n",
        "unknown_input",
        3,
    );
    rejected(
        "    agent = await aixand.agents.spawn('codex')\n",
        "argument",
        3,
    );
    rejected(
        "    agent = await aixand.agents.spawn()\n    await agent.send()\n",
        "missing_input",
        4,
    );
    rejected(
        "    agent = await aixand.agents.spawn()\n    await agent.send(task, text='duplicate')\n",
        "argument",
        4,
    );
    let error = rejected(
        "    agent = await aixand.agents.spawn()\n    await agent.send(42)\n",
        "type",
        4,
    );
    assert_eq!(error.diagnostics[0].source.column, 22);
    assert_eq!(
        error.diagnostics[0].ir_location.as_deref(),
        Some("/body/steps/1/inputs/text")
    );
    assert_eq!(
        error.diagnostics[0].invocation_id.as_deref(),
        Some("send_1")
    );
}

#[test]
fn invalid_receiver_is_not_dynamic_dispatch() {
    rejected("    await task.send('hello')\n", "invalid_receiver", 3);
    rejected(
        "    agent = await aixand.agents.spawn()\n    receipt = await agent.send(task)\n    await receipt.stop()\n",
        "invalid_receiver",
        5,
    );
    rejected(
        "    agent = await aixand.agents.spawn()\n    await agent.wait(agent=agent)\n",
        "argument",
        4,
    );
}

#[test]
fn undefined_and_forward_values_have_distinct_diagnostics() {
    rejected(
        "    agent = await aixand.agents.spawn()\n    await agent.send(missing)\n",
        "undefined_variable",
        4,
    );
    rejected(
        "    agent = await aixand.agents.spawn()\n    await agent.wait(after=receipt)\n    receipt = await agent.send(task)\n",
        "unavailable_value",
        4,
    );
    rejected(
        "    agent = await aixand.agents.spawn()\n    result = await agent.stop()\n",
        "unavailable_value",
        4,
    );
}

#[test]
fn non_boolean_if_is_source_located() {
    rejected("    if task:\n        pass\n", "condition_type", 3);
}
#[test]
fn unsupported_loops_are_source_located() {
    for text in [
        "    for value in [task]:\n        pass\n",
        "    while True:\n        pass\n",
        "    async for value in task:\n        pass\n",
    ] {
        rejected(text, "unsupported_statement", 3);
    }
}
#[test]
fn arbitrary_calls_and_unawaited_operations_are_rejected() {
    rejected(
        "    value = open('side-effect.txt', 'w')\n",
        "arbitrary_call",
        3,
    );
    rejected("    await print(task)\n", "unknown_operation", 3);
    rejected("    agent = aixand.agents.spawn()\n", "arbitrary_call", 3);
    rejected(
        "    await getattr(task, 'send')('text')\n",
        "unknown_operation",
        3,
    );
}
#[test]
fn unsupported_python_expressions_and_mutation_are_rejected() {
    for text in [
        "    result = [x for x in task]\n",
        "    result = lambda: task\n",
        "    result = task[0]\n",
        "    result = task + 'x'\n",
        "    result = f'{task}'\n",
    ] {
        rejected(text, "unsupported_expression", 3);
    }
    rejected("    task.value = 'x'\n", "assignment", 3);
    rejected("    task[0] = 'x'\n", "assignment", 3);
    rejected("    task += 'x'\n", "unsupported_statement", 3);
    rejected("    aixand = task\n", "reserved_name", 3);
    rejected(
        "    agent = await aixand.agents.spawn()\n    value = agent.session_id\n",
        "attribute",
        4,
    );
}
#[test]
fn nested_control_scopes_and_early_returns_are_rejected() {
    for text in [
        "    try:\n        pass\n    finally:\n        pass\n",
        "    async with task:\n        pass\n",
        "    async def nested():\n        pass\n",
        "    return task\n    pass\n",
    ] {
        rejected(text, "unsupported_statement", 3);
    }
}
#[test]
fn unsafe_literals_unpacking_and_duplicate_keys_are_rejected() {
    for text in [
        "    value = 9007199254740992\n",
        "    value = 1e999\n",
        "    value = b'bytes'\n",
        "    value = ...\n",
        "    value = -True\n",
    ] {
        rejected(text, "literal", 3);
    }
    rejected("    value = {'x': 1, 'x': 2}\n", "dictionary", 3);
    rejected("    value = {**task}\n", "dictionary", 3);
    rejected("    await aixand.agents.spawn(**task)\n", "argument", 3);
}
#[test]
fn syntax_errors_and_unicode_columns_are_useful() {
    let error = compile("@aixand.workflow\nasync def f(task: str):\n    await (\n").unwrap_err();
    assert_eq!(error.diagnostics[0].code, "syntax");
    assert_eq!(error.diagnostics[0].source.line, 3);
    let line = "    data = {'é': 'ok', 'bad': missing}";
    let error = compile(&body(&format!("{line}\n"))).unwrap_err();
    let expected = line[..line.find("missing").unwrap()].chars().count() + 1;
    assert_eq!(error.diagnostics[0].source.column, expected);
    assert!(
        error
            .to_string()
            .contains(&format!("fixture.py:3:{expected}: undefined_variable"))
    );
}

#[test]
fn compilation_does_not_import_or_execute_aixand() {
    // Install a trap module whose decorator/API would fail if compilation used it.
    use pyo3::{prelude::*, types::PyModule};
    Python::attach(|py| {
        let modules = py.import("sys").unwrap().getattr("modules").unwrap();
        let previous = modules.call_method1("get", ("aixand",)).unwrap().unbind();
        let trap = PyModule::new(py, "aixand").unwrap();
        modules.set_item("aixand", trap).unwrap();
        let compiled = compile(SOURCE);
        if previous.bind(py).is_none() {
            modules.del_item("aixand").unwrap();
        } else {
            modules.set_item("aixand", previous).unwrap();
        }
        assert!(compiled.is_ok(), "{compiled:?}");
    });
}

#[tokio::test]
async fn external_frontend_mapping_uses_catalog_signatures_and_existing_runner() {
    let catalog = CatalogRegistry::new([parse_catalog(VERIFIER_CATALOG).unwrap()]).unwrap();
    let mappings = MappingRegistry::from_json(
        &json!([{
            "python":"aixand.verify", "operation":{"id":"verifier.verify","version":"1.0.0"},
            "positional":["document","required_terms"], "result":"result",
            "properties":{"passed":{"output":"result","path":["passed"]}}
        }])
        .to_string(),
    )
    .unwrap();
    let source = "@aixand.workflow\nasync def f(task: str) -> bool:\n    document = {'title': 'Research', 'body': task, 'labels': ['ir']}\n    result = await aixand.verify(document, ['agent'])\n    return result.passed\n";
    let workflow = compile_python(source, "verifier.py", &catalog, &mappings).unwrap();
    let mut bindings = aixand_ir_runner::BindingRegistry::default();
    aixand_ir_verifier::register(&mut bindings).unwrap();
    let result = aixand_ir_runner::Runner::new(catalog.clone(), bindings)
        .run_json(
            &workflow,
            json!({"task":"managed agent"}),
            aixand_ir_runner::CleanupPolicy::Detach,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result, json!({"result":true}));
    let error = compile_python(
        &source.replace("['agent']", "[True]"),
        "verifier.py",
        &catalog,
        &mappings,
    )
    .unwrap_err();
    assert_eq!(error.diagnostics[0].source.line, 4);
    assert_eq!(error.diagnostics[0].code, "type");
}

#[test]
fn invalid_frontend_output_and_receiver_metadata_are_rejected() {
    for extra in [
        json!({"result":"missing"}),
        json!({"result":"agent","properties":{"name":{"output":"agent","path":["run_id"]}}}),
    ] {
        let mut mapping = json!({"python":"aixand.agents.spawn","operation":{"id":"aixand.agents.spawn","version":"1.0.0"}});
        mapping
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let mappings = MappingRegistry::from_json(&json!([mapping]).to_string()).unwrap();
        let error = compile_python(SOURCE, "fixture.py", &catalogs(), &mappings).unwrap_err();
        assert_eq!(error.diagnostics[0].code, "frontend_metadata");
    }
    let duplicate =
        json!({"python":"aixand.spawn","operation":{"id":"aixand.agents.spawn","version":"1.0.0"}});
    assert!(MappingRegistry::from_json(&json!([duplicate, duplicate]).to_string()).is_err());
    let mut mappings: Json = serde_json::from_str(aixand_ir_frontend::PYTHON_MAPPINGS).unwrap();
    let send = mappings
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|m| m["python"] == "send" && m["receiver"]["id"] == "aixand.agent")
        .unwrap();
    send["receiver"]["port"] = json!("text");
    let mappings = MappingRegistry::from_json(&mappings.to_string()).unwrap();
    let error = compile_python(SOURCE, "fixture.py", &catalogs(), &mappings).unwrap_err();
    assert_eq!(error.diagnostics[0].code, "frontend_metadata");
}

#[test]
fn explicit_mcp_selection_uses_the_new_spawn_contract_and_preserves_existing_workflows() {
    let catalog =
        CatalogRegistry::new([
            parse_catalog(include_str!("../../aixand-ir/catalogs/aixand.json")).unwrap(),
        ])
        .unwrap();
    for (arguments, version) in [
        ("profile='work'", "1.0.0"),
        (
            "profile='work', mcp={'inherit': False, 'add': ['sonar']}",
            "1.1.0",
        ),
    ] {
        let source = format!(
            "@aixand.workflow\nasync def f():\n    agent = await aixand.agents.spawn({arguments})\n    await agent.stop()\n"
        );
        let workflow =
            compile_python(&source, "fixture.py", &catalog, &MappingRegistry::aixand()).unwrap();
        let value = to_json(&workflow).unwrap();
        assert_eq!(value["body"]["steps"][0]["operation"]["version"], version);
        if version == "1.1.0" {
            let selection = &value["body"]["steps"][0]["inputs"]["mcp"];
            assert_eq!(selection["fields"]["inherit"]["value"], false);
            assert_eq!(selection["fields"]["add"]["items"][0]["value"], "sonar");
        }
    }
}
