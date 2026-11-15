use aixand_ir::*;
use serde_json::{Value as Json, json};

fn catalogs() -> CatalogRegistry {
    CatalogRegistry::new([
        parse_catalog(AIXAND_CATALOG).unwrap(),
        parse_catalog(VERIFIER_CATALOG).unwrap(),
    ])
    .unwrap()
}
fn workflow() -> Json {
    json!({"ir_version":"0.1","inputs":{},"body":{"kind":"sequence","steps":[]},"outputs":{}})
}
fn validate(v: &Json) -> Result<Vec<Diagnostic>, ValidationError> {
    validate_workflow(&parse_workflow(&v.to_string())?, &catalogs())
}
fn string() -> Json {
    json!({"kind":"string"})
}

#[test]
fn schemas_and_examples_conform() {
    for schema in [WORKFLOW_SCHEMA, CATALOG_SCHEMA, SHARED_SCHEMA] {
        jsonschema::draft202012::new(&serde_json::from_str::<Json>(schema).unwrap()).unwrap();
    }
    for text in [
        include_str!("../../../examples/research-explicit.json"),
        include_str!("../../../examples/research-implicit.json"),
        include_str!("../../../examples/team.json"),
        include_str!("../../../examples/verifier.json"),
    ] {
        let workflow = parse_workflow(text).unwrap();
        assert!(
            validate_workflow(&workflow, &catalogs())
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            parse_workflow(&serde_json::to_string(&workflow).unwrap()).unwrap(),
            workflow
        );
    }
}

#[test]
fn strict_json_rejects_duplicate_keys_unsafe_integers_nonfinite_and_surrogates() {
    for text in [
        r#"{"x":1,"x":2}"#,
        r#"{"literal":{"x":1,"x":2}}"#,
        "9007199254740992",
        "-9007199254740992",
        "184467440737095516160000",
        "NaN",
        "Infinity",
        "1e999",
        r#""\ud800""#,
    ] {
        assert!(parse_json(text).is_err(), "{text}");
    }
    assert_eq!(parse_json("1").unwrap(), parse_json("1.0").unwrap());
    assert_eq!(parse_json("9007199254740991").unwrap(), json!(MAX_INTEGER));
    assert!(parse_json("1e30").is_ok());
}

#[test]
fn canonicalization_uses_jcs_numbers_and_utf16_key_order() {
    let value = parse_json(r#"{"z":1.0,"a":-0.0,"tiny":1e-7,"large":1e30}"#).unwrap();
    assert_eq!(
        String::from_utf8(canonicalize(&value).unwrap()).unwrap(),
        r#"{"a":0,"large":1e+30,"tiny":1e-7,"z":1}"#
    );
    let value = json!({"\u{e000}":1,"\u{1f600}":2});
    assert_eq!(
        String::from_utf8(canonicalize(&value).unwrap()).unwrap(),
        "{\"😀\":2,\"\u{e000}\":1}"
    );
}

#[test]
fn structural_records_are_closed_and_versions_are_exact() {
    for (path, value) in [("ir_version", json!("0.3")), ("retry", json!(1))] {
        let mut w = workflow();
        w[path] = value;
        assert!(validate(&w).is_err());
    }
    let mut w = workflow();
    w["body"]["steps"] = json!([{"kind":"sequence","steps":[]}]);
    assert!(validate(&w).is_err());
    for expr in [
        json!({"kind":"ref","source":"input","name":"x","step":"y"}),
        json!({"kind":"ref","source":"input","name":"x","path":[-1]}),
        json!({"kind":"ref","source":"input","name":"x","path":[true]}),
        json!({"kind":"literal","value":1,"extra":2}),
    ] {
        let mut w = workflow();
        w["outputs"]["x"] = json!({"type":{"kind":"json"},"value":expr});
        assert!(validate(&w).is_err());
    }
    let mut cat = parse_json(VERIFIER_CATALOG).unwrap();
    for version in ["*", "^1.0", "~1.0", ">=1", "1 || 2", ""] {
        cat["operations"][0]["version"] = json!(version);
        assert!(parse_catalog(&cat.to_string()).is_err());
    }
}

#[test]
fn literal_contents_are_not_expressions() {
    let mut w = workflow();
    w["outputs"]["data"] = json!({"type":{"kind":"json"},"value":{"kind":"literal","value":{"kind":"ref","source":"step","step":"missing","output":"invented"}}});
    assert!(validate(&w).is_ok());
}

#[test]
fn explicit_null_defaults_survive_round_trip_and_required_defaults_fail() {
    let mut w = workflow();
    w["inputs"]["x"] = json!({"type":{"kind":"string","nullable":true},"default":null});
    let parsed = parse_workflow(&w.to_string()).unwrap();
    assert_eq!(parsed.inputs["x"].default, Some(Json::Null));
    assert_eq!(to_json(&parsed).unwrap(), w);
    assert!(validate(&w).is_ok());
    w["inputs"]["x"]["type"] = string();
    assert!(validate(&w).is_err());
    let mut cat = parse_json(VERIFIER_CATALOG).unwrap();
    cat["operations"][0]["inputs"]["document"]["default"] = Json::Null;
    assert!(CatalogRegistry::new([parse_catalog(&cat.to_string()).unwrap()]).is_err());
}

#[test]
fn duplicate_catalog_registration_is_transactional() {
    let cat = parse_catalog(VERIFIER_CATALOG).unwrap();
    let mut registry = CatalogRegistry::new([cat.clone()]).unwrap();
    assert!(registry.add(cat).is_err());
    assert_eq!(registry.definitions().count(), 1);
}

#[test]
fn scalar_nominal_and_container_type_compatibility() {
    let ty = |j: Json| serde_json::from_value::<Type>(j).unwrap();
    let integer = ty(json!({"kind":"integer"}));
    let number = ty(json!({"kind":"number"}));
    assert!(compatible(&integer, &number));
    assert!(!compatible(&number, &integer));
    assert!(!compatible(&ty(json!({"kind":"boolean"})), &integer));
    assert!(!compatible(
        &ty(json!({"kind":"string","nullable":true})),
        &ty(string())
    ));
    assert!(compatible(
        &Type::Null,
        &ty(json!({"kind":"string","nullable":true}))
    ));
    assert!(!compatible(&Type::Json, &ty(string())));
    let opaque = ty(json!({"kind":"opaque","id":"demo.handle","version":"1"}));
    assert!(compatible(&opaque, &opaque));
    assert!(!compatible(&opaque, &Type::Json));
    assert!(!compatible(
        &opaque,
        &ty(json!({"kind":"opaque","id":"demo.handle","version":"2"}))
    ));
    let source =
        ty(json!({"kind":"object","properties":{"x":{"kind":"integer"}},"required":["x"]}));
    let target = ty(json!({"kind":"object","properties":{"x":{"kind":"number"}},"required":["x"]}));
    assert!(compatible(&source, &target));
    assert!(!compatible(&target, &source));
    let optional = ty(json!({"kind":"object","properties":{"x":{"kind":"integer"}},"required":[]}));
    assert!(!compatible(&optional, &source));
    let open =
        ty(json!({"kind":"object","properties":{},"required":[],"additional":{"kind":"integer"}}));
    assert!(!compatible(&open, &source));
    assert!(compatible(&source, &open));
    assert!(validate_value(&Value::Boolean(true), &integer, "").is_err());
    assert!(validate_value(&Value::Number(f64::NAN), &number, "").is_err());
    assert!(validate_value(&Value::Integer(MAX_INTEGER + 1), &number, "").is_err());
}

#[test]
fn paths_diagnose_uncertainty_and_distinguish_keys_from_indexes() {
    let mut w = workflow();
    w["inputs"]["obj"] = json!({"type":{"kind":"object","properties":{"a.b/0":{"kind":"array","items":{"kind":"string"}}},"required":[]}});
    w["outputs"]["x"] = json!({"type":string(),"value":{"kind":"ref","source":"input","name":"obj","path":["a.b/0",0]}});
    let diagnostics = validate(&w).unwrap();
    assert_eq!(diagnostics.len(), 2);
    assert!(diagnostics.iter().all(|d| d.severity == Severity::Warning));
    w["outputs"]["x"]["value"]["path"] = json!(["a.b/0", "0"]);
    assert!(validate(&w).is_err());
    w["outputs"]["x"]["value"]["path"] = json!(["absent"]);
    assert!(validate(&w).is_err());
    w["inputs"]["obj"]["type"] = json!({"kind":"opaque","id":"demo.handle","version":"1"});
    assert!(validate(&w).is_err());
}

#[test]
fn runtime_presence_and_opaque_identity() {
    let atom = Opaque::new("demo.handle", "1");
    let inputs = Named::from([
        ("handle".into(), Value::Opaque(atom.clone())),
        (
            "object".into(),
            Value::from_json(&json!({"0":"key","items":[1]})).unwrap(),
        ),
    ]);
    let expr = |name: &str, path: Json| {
        serde_json::from_value::<Expression>(
            json!({"kind":"ref","source":"input","name":name,"path":path}),
        )
        .unwrap()
    };
    assert_eq!(
        evaluate(&expr("handle", json!([])), &inputs, &Named::new(), "").unwrap(),
        Value::Opaque(atom)
    );
    assert!(evaluate(&expr("handle", json!(["x"])), &inputs, &Named::new(), "").is_err());
    assert_eq!(
        evaluate(&expr("object", json!(["0"])), &inputs, &Named::new(), "")
            .unwrap()
            .as_str(),
        Some("key")
    );
    assert!(
        evaluate(
            &expr("object", json!(["items", 1])),
            &inputs,
            &Named::new(),
            ""
        )
        .is_err()
    );
    assert!(inputs["handle"].to_json().is_err());
}

#[test]
fn invocation_and_port_rules() {
    let original = parse_json(include_str!("../../../examples/research-explicit.json")).unwrap();
    let mut cases = vec![];
    let mut w = original.clone();
    w["body"]["steps"][1]["id"] = json!("spawn_1");
    cases.push(w);
    let mut w = original.clone();
    w["body"]["steps"][0]["operation"]["version"] = json!("2.0.0");
    cases.push(w);
    let mut w = original.clone();
    w["body"]["steps"][1]["inputs"]["text"] =
        json!({"kind":"ref","source":"input","name":"absent"});
    cases.push(w);
    let mut w = original.clone();
    w["body"]["steps"][1]["inputs"]["agent"]["step"] = json!("send_2");
    cases.push(w);
    let mut w = original.clone();
    w["body"]["steps"][1]["inputs"]["agent"]["step"] = json!("send_1");
    cases.push(w);
    let mut w = original.clone();
    w["body"]["steps"][1]["inputs"]["agent"]["step"] = json!("missing");
    cases.push(w);
    let mut w = original.clone();
    w["body"]["steps"][1]["inputs"]["agent"]["output"] = json!("invented");
    cases.push(w);
    let mut w = original.clone();
    w["body"]["steps"][1]["inputs"]
        .as_object_mut()
        .unwrap()
        .remove("text");
    cases.push(w);
    let mut w = original.clone();
    w["body"]["steps"][1]["inputs"]["extra"] = json!({"kind":"literal","value":1});
    cases.push(w);
    let mut w = original.clone();
    w["body"]["steps"][1]["outputs"] = json!({});
    cases.push(w);
    for (i, w) in cases.iter().enumerate() {
        assert!(validate(w).is_err(), "case {i}");
    }
}

#[test]
fn construction_checks_each_child_without_losing_heterogeneous_precision() {
    let mut w = workflow();
    w["outputs"]["x"] = json!({"type":{"kind":"array","items":{"kind":"number"}},"value":{"kind":"array","items":[{"kind":"literal","value":1},{"kind":"literal","value":1.5}]}});
    assert!(validate(&w).is_ok());
    w["outputs"]["x"]["value"]["items"][0]["value"] = json!(true);
    assert!(validate(&w).is_err());
    w["outputs"]["x"] = json!({"type":{"kind":"object","properties":{"x":{"kind":"string"}},"required":["x"]},"value":{"kind":"object","fields":{}}});
    assert!(validate(&w).is_err());
}

#[test]
fn invalid_example_corpus_has_the_expected_diagnostics() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/invalid");
    let expected =
        parse_json(&std::fs::read_to_string(root.join("expected.json")).unwrap()).unwrap();
    for (file, code) in expected.as_object().unwrap() {
        let text = std::fs::read_to_string(root.join(file)).unwrap();
        let result = parse_workflow(&text).and_then(|w| validate_workflow(&w, &catalogs()));
        let error = result.expect_err(file);
        assert!(
            error.0.iter().any(|d| d.code == code.as_str().unwrap()),
            "{file}: {error}"
        );
    }
}

#[test]
fn embedded_schema_definitions_and_catalog_contracts_are_complete() {
    let shared: Json = serde_json::from_str(SHARED_SCHEMA).unwrap();
    for text in [WORKFLOW_SCHEMA, CATALOG_SCHEMA] {
        let schema: Json = serde_json::from_str(text).unwrap();
        assert_eq!(schema["$defs"], shared["$defs"]);
    }
    for text in [AIXAND_CATALOG, VERIFIER_CATALOG] {
        let cat = parse_catalog(text).unwrap();
        for op in cat.operations {
            assert!(op.description.as_deref().is_some_and(|s| s.len() > 100));
        }
    }
}

#[test]
fn additional_properties_nullable_arrays_and_nested_opaque_types() {
    let ty = |value: Json| serde_json::from_value::<Type>(value).unwrap();
    let source =
        ty(json!({"kind":"object","properties":{},"required":[],"additional":{"kind":"number"}}));
    let target = ty(
        json!({"kind":"object","properties":{"x":{"kind":"integer"}},"required":[],"additional":{"kind":"number"}}),
    );
    assert!(!compatible(&source, &target));
    let numbers = ty(json!({"kind":"array","items":{"kind":"number"}}));
    let integers = ty(json!({"kind":"array","items":{"kind":"integer"}}));
    assert!(compatible(&integers, &numbers));
    assert!(!compatible(&numbers, &integers));
    let nullable = ty(json!({"kind":"array","items":{"kind":"number","nullable":true}}));
    assert!(!compatible(&nullable, &numbers));
    assert!(compatible(&numbers, &nullable));
    let opaque = ty(
        json!({"kind":"object","properties":{},"required":[],"additional":{"kind":"array","items":{"kind":"opaque","id":"demo.handle","version":"1"}}}),
    );
    assert!(!opaque.json_only());
    assert!(!compatible(&opaque, &Type::Json));
}
