use aixand_ir::*;
use serde_json::{Value as Json, json};
fn catalogs() -> CatalogRegistry {
    CatalogRegistry::new([parse_catalog(VERIFIER_CATALOG).unwrap()]).unwrap()
}
fn fixture() -> Json {
    parse_json(include_str!("../../../examples/branching/workflow.json")).unwrap()
}
fn validate(w: &Json) -> Result<Vec<Diagnostic>, ValidationError> {
    validate_workflow(&parse_workflow(&w.to_string())?, &catalogs())
}
fn literal(value: Json) -> Json {
    json!({"kind":"literal","value":value})
}
fn condition(c: Json) -> Json {
    let mut w = fixture();
    w["body"]["steps"][1]["condition"] = c;
    w
}
fn evaluate_json(c: Json) -> Value {
    evaluate(
        &serde_json::from_value(c).unwrap(),
        &Named::new(),
        &Named::new(),
        "/condition",
    )
    .unwrap()
}
#[test]
fn versions_and_structure_remain_distinct_from_semantics() {
    assert!(validate(&fixture()).is_ok());
    let mut w = fixture();
    w["body"]["steps"][1]
        .as_object_mut()
        .unwrap()
        .remove("else");
    assert!(validate(&w).is_ok());
    for (path, value) in [
        ("/ir_version", json!("0.1")),
        ("/body/steps/1/then/kind", json!("operation")),
        ("/body/steps/1/else", Json::Null),
    ] {
        let mut w = fixture();
        *w.pointer_mut(path).unwrap() = value;
        assert!(parse_workflow(&w.to_string()).is_err(), "{path}");
    }
    for c in [
        json!({"kind":"and","operands":[]}),
        json!({"kind":"not"}),
        json!({"kind":"compare","operator":"add","left":literal(json!(1)),"right":literal(json!(2))}),
    ] {
        assert!(parse_workflow(&condition(c).to_string()).is_err());
    }
    for source in [
        include_str!("../../../examples/real-agent/workflow.json"),
        include_str!("../../../examples/python/managed_codex_two_turns.json"),
    ] {
        let w = parse_workflow(source).unwrap();
        validate_workflow(
            &w,
            &CatalogRegistry::new([parse_catalog(AIXAND_CATALOG).unwrap()]).unwrap(),
        )
        .unwrap();
        assert_eq!(w.ir_version, "0.1");
    }
    let schema: Json = serde_json::from_str(WORKFLOW_V02_SCHEMA).unwrap();
    let shared: Json = serde_json::from_str(SHARED_V02_SCHEMA).unwrap();
    assert_eq!(schema["$defs"], shared["$defs"]);
}
#[test]
fn comparison_operators_and_boolean_values() {
    for (op, a, b, expected) in [
        ("eq", json!(1), json!(1.0), true),
        ("ne", json!("a"), json!("b"), true),
        ("lt", json!(1), json!(2), true),
        ("le", json!(2), json!(2), true),
        ("gt", json!(3), json!(2), true),
        ("ge", json!(2), json!(2), true),
        ("eq", Json::Null, json!(true), false),
        ("eq", Json::Null, Json::Null, true),
    ] {
        let c = json!({"kind":"compare","operator":op,"left":literal(a),"right":literal(b)});
        validate(&condition(c.clone())).unwrap();
        assert_eq!(evaluate_json(c), Value::Boolean(expected));
    }
    for (op, a, b) in [
        ("eq", json!(true), json!(1)),
        ("lt", json!("a"), json!("b")),
        ("lt", Json::Null, json!(1)),
        ("eq", json!([]), json!([])),
        ("eq", json!({}), json!({})),
    ] {
        let error = validate(&condition(
            json!({"kind":"compare","operator":op,"left":literal(a),"right":literal(b)}),
        ))
        .unwrap_err();
        assert_eq!(error.0[0].code, "comparison_type");
        assert_eq!(error.0[0].location, "/body/steps/1/condition");
        assert_eq!(error.0[0].invocation_id.as_deref(), Some("branch_1"));
    }
    for value in [Json::Null, json!(0), json!("true")] {
        assert!(validate(&condition(literal(value))).is_err());
    }
    for (kind, values, expected) in [
        ("and", vec![true, false], false),
        ("and", vec![true, true], true),
        ("or", vec![false, true], true),
        ("or", vec![false, false], false),
    ] {
        let c = json!({"kind":kind,"operands":values.into_iter().map(|v|literal(json!(v))).collect::<Vec<_>>()});
        validate(&condition(c.clone())).unwrap();
        assert_eq!(evaluate_json(c), Value::Boolean(expected));
    }
    let c = json!({"kind":"not","operand":literal(json!(false))});
    validate(&condition(c.clone())).unwrap();
    assert_eq!(evaluate_json(c), Value::Boolean(true));
    assert!(
        validate(&condition(
            json!({"kind":"not","operand":literal(json!(1))})
        ))
        .is_err()
    );
}
#[test]
fn short_circuit_does_not_traverse_an_unavailable_property() {
    let missing = json!({"kind":"ref","source":"input","name":"flags","path":["optional"]});
    for (kind, first, expected) in [("and", false, false), ("or", true, true)] {
        let expr: Expression =
            serde_json::from_value(json!({"kind":kind,"operands":[literal(json!(first)),missing]}))
                .unwrap();
        let mut w = condition(serde_json::to_value(&expr).unwrap());
        w["inputs"]["flags"] = json!({"type":{"kind":"object","properties":{"optional":{"kind":"boolean"}},"required":[]}});
        assert!(
            validate(&w)
                .unwrap()
                .iter()
                .any(|d| d.code == "runtime_presence")
        );
        let inputs = Named::from([("flags".into(), Value::from_json(&json!({})).unwrap())]);
        assert_eq!(
            evaluate(&expr, &inputs, &Named::new(), "").unwrap(),
            Value::Boolean(expected)
        );
    }
}
#[test]
fn lexical_visibility_duplicates_and_forward_references() {
    let mut w = fixture();
    let mut nested = w["body"]["steps"][1].clone();
    nested["id"] = json!("nested");
    nested["then"]["steps"] = json!([]);
    nested["else"]["steps"] = json!([]);
    nested["condition"]["step"] = json!("verify_2");
    w["body"]["steps"][1]["then"]["steps"]
        .as_array_mut()
        .unwrap()
        .push(nested);
    validate(&w).unwrap();
    let parsed = parse_workflow(&w.to_string()).unwrap();
    let ids = |path, before| {
        visible_operations(&parsed, path, before)
            .unwrap()
            .iter()
            .map(|s| s.id().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids("/body/steps/1/then/steps/1/then", 0),
        ["verify_1", "verify_2"]
    );
    assert_eq!(ids("/body/steps/1/else", 0), ["verify_1"]);
    assert_eq!(ids("/body", 3), ["verify_1", "verify_4"]);
    for path in ["/body/steps/1/condition/step", "/outputs/passed/value/step"] {
        let mut bad = fixture();
        *bad.pointer_mut(path).unwrap() = json!("verify_2");
        assert_eq!(validate(&bad).unwrap_err().0[0].code, "out_of_scope");
    }
    let mut bad = fixture();
    bad["body"]["steps"][1]["else"]["steps"][0]["inputs"]["required_terms"] =
        json!({"kind":"ref","source":"step","step":"verify_2","output":"result","path":["issues"]});
    let error = validate(&bad).unwrap_err();
    assert_eq!(error.0[0].code, "out_of_scope");
    assert_eq!(error.0[0].invocation_id.as_deref(), Some("verify_3"));
    let mut bad = fixture();
    bad["body"]["steps"][1]["condition"]["step"] = json!("verify_4");
    assert_eq!(validate(&bad).unwrap_err().0[0].code, "forward_reference");
    let mut bad = fixture();
    bad["body"]["steps"][1]["condition"]["step"] = json!("branch_1");
    assert_eq!(validate(&bad).unwrap_err().0[0].code, "branch_output");
    for id in ["verify_1", "verify_2", "branch_1"] {
        let mut bad = fixture();
        bad["body"]["steps"][1]["else"]["steps"][0]["id"] = json!(id);
        assert_eq!(
            validate(&bad).unwrap_err().0[0].code,
            "duplicate_invocation"
        );
    }
}
