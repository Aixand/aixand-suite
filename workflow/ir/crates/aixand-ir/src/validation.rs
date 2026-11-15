use crate::*;
use std::collections::{BTreeMap, BTreeSet};

struct Checker<'a> {
    workflow: &'a Workflow,
    catalogs: &'a CatalogRegistry,
    available: BTreeMap<String, &'a OperationDefinition>,
    positions: BTreeMap<String, (String, usize, bool)>,
    sequence: String,
    position: usize,
    diagnostics: Vec<Diagnostic>,
}

pub fn validate_workflow(
    workflow: &Workflow,
    catalogs: &CatalogRegistry,
) -> Result<Vec<Diagnostic>, ValidationError> {
    validate_structure(&to_json(workflow)?, DocumentKind::Workflow)?;
    for (name, input) in &workflow.inputs {
        let path = pointer("/inputs", name);
        validate_type(&input.ty, &pointer(&path, "type"))?;
        if let Some(default) = &input.default {
            validate_value(
                &Value::from_json(default)?,
                &input.ty,
                &pointer(&path, "default"),
            )?;
        }
    }
    let mut checker = Checker {
        workflow,
        catalogs,
        available: BTreeMap::new(),
        positions: BTreeMap::new(),
        position: 0,
        sequence: "/body".into(),
        diagnostics: vec![],
    };
    collect_positions(&workflow.body, "/body", &mut checker.positions)?;
    checker.check_sequence(&workflow.body, "/body")?;
    checker.position = workflow.body.steps().len();
    for (name, output) in &workflow.outputs {
        let path = pointer("/outputs", name);
        validate_type(&output.ty, &pointer(&path, "type"))?;
        checker.check_expression(&output.value, &output.ty, &pointer(&path, "value"))?;
    }
    Ok(checker.diagnostics)
}

fn collect_positions(
    sequence: &Sequence,
    path: &str,
    ids: &mut BTreeMap<String, (String, usize, bool)>,
) -> Result<(), ValidationError> {
    for (i, step) in sequence.steps().iter().enumerate() {
        let location = pointer(&pointer(path, "steps"), i);
        if ids
            .insert(
                step.id().into(),
                (path.into(), i, step.identity().is_some()),
            )
            .is_some()
        {
            return Err(Diagnostic::error(
                "duplicate_invocation",
                &pointer(&location, "id"),
                format!("Duplicate invocation {:?}", step.id()),
            )
            .into());
        }
        if let Step::Branch {
            then, otherwise, ..
        } = step
        {
            collect_positions(then, &pointer(&location, "then"), ids)?;
            if let Some(otherwise) = otherwise {
                collect_positions(otherwise, &pointer(&location, "else"), ids)?;
            }
        }
    }
    Ok(())
}

/// Authoring-time visibility, using the same lexical block rule as validation.
/// `sequence_path` addresses a Sequence (e.g. /body/steps/1/then); `before` is an
/// insertion position. Branch-local producers never leak into siblings or parents.
pub fn visible_operations<'a>(
    workflow: &'a Workflow,
    sequence_path: &str,
    before: usize,
) -> Result<Vec<&'a Step>, ValidationError> {
    fn visit<'a>(
        sequence: &'a Sequence,
        path: &str,
        target: &str,
        before: usize,
        mut visible: Vec<&'a Step>,
    ) -> Option<Vec<&'a Step>> {
        if path == target {
            if before > sequence.steps().len() {
                return None;
            }
            visible.extend(
                sequence.steps()[..before]
                    .iter()
                    .filter(|s| s.identity().is_some()),
            );
            return Some(visible);
        }
        for (i, step) in sequence.steps().iter().enumerate() {
            let location = pointer(&pointer(path, "steps"), i);
            match step {
                Step::Operation { .. } => visible.push(step),
                Step::Branch {
                    then, otherwise, ..
                } => {
                    if let Some(found) = visit(
                        then,
                        &pointer(&location, "then"),
                        target,
                        before,
                        visible.clone(),
                    ) {
                        return Some(found);
                    }
                    if let Some(otherwise) = otherwise
                        && let Some(found) = visit(
                            otherwise,
                            &pointer(&location, "else"),
                            target,
                            before,
                            visible.clone(),
                        )
                    {
                        return Some(found);
                    }
                }
            }
        }
        None
    }
    visit(&workflow.body, "/body", sequence_path, before, vec![]).ok_or_else(|| {
        Diagnostic::error(
            "sequence_location",
            sequence_path,
            "Unknown sequence or invalid insertion position",
        )
        .into()
    })
}

impl<'a> Checker<'a> {
    fn check_sequence(&mut self, sequence: &Sequence, path: &str) -> Result<(), ValidationError> {
        let parent = self.sequence.clone();
        let position = self.position;
        self.sequence = path.into();
        for (i, step) in sequence.steps().iter().enumerate() {
            self.position = i;
            let location = pointer(&pointer(path, "steps"), i);
            let start = self.diagnostics.len();
            let result = match step {
                Step::Operation {
                    operation, inputs, ..
                } => self.check_operation(step.id(), operation, inputs, &location),
                Step::Branch {
                    condition,
                    then,
                    otherwise,
                    ..
                } => {
                    let available = self.available.clone();
                    let result = (|| {
                        self.check_expression(
                            condition,
                            &boolean_type(),
                            &pointer(&location, "condition"),
                        )?;
                        self.check_sequence(then, &pointer(&location, "then"))?;
                        self.available = available.clone();
                        if let Some(otherwise) = otherwise {
                            self.check_sequence(otherwise, &pointer(&location, "else"))?;
                        }
                        Ok(())
                    })();
                    self.available = available;
                    result
                }
            };
            let contextualize = |diagnostic: &mut Diagnostic| {
                if diagnostic.invocation_id.is_none() {
                    diagnostic.invocation_id = Some(step.id().into());
                    diagnostic.operation = step.identity().cloned();
                }
            };
            if let Err(mut error) = result {
                error.0.iter_mut().for_each(contextualize);
                return Err(error);
            }
            self.diagnostics[start..].iter_mut().for_each(contextualize);
        }
        self.sequence = parent;
        self.position = position;
        Ok(())
    }

    fn check_operation(
        &mut self,
        id: &str,
        identity: &OperationIdentity,
        inputs: &Named<Expression>,
        location: &str,
    ) -> Result<(), ValidationError> {
        let definition = self.catalogs.resolve(identity).ok_or_else(|| {
            Diagnostic::error(
                "unknown_operation",
                &pointer(location, "operation"),
                format!(
                    "Unknown exact operation {}@{}",
                    identity.id, identity.version
                ),
            )
        })?;
        for name in inputs.keys() {
            if !definition.inputs.contains_key(name) {
                return Err(Diagnostic::error(
                    "unknown_input",
                    &pointer(&pointer(location, "inputs"), name),
                    "Unknown operation input",
                )
                .into());
            }
        }
        for (name, input) in &definition.inputs {
            let path = pointer(&pointer(location, "inputs"), name);
            if let Some(expr) = inputs.get(name) {
                self.check_expression(expr, &input.ty, &path)?;
            } else if input.required {
                return Err(Diagnostic::error(
                    "missing_input",
                    &path,
                    "Required operation input is absent",
                )
                .into());
            }
        }
        self.available.insert(id.into(), definition);
        Ok(())
    }

    fn check_expression(
        &mut self,
        expression: &Expression,
        target: &Type,
        location: &str,
    ) -> Result<(), ValidationError> {
        match expression {
            Expression::Compare { .. }
            | Expression::And { .. }
            | Expression::Or { .. }
            | Expression::Not { .. } => {
                self.condition_type(expression, location)?;
                if compatible(&boolean_type(), target) {
                    Ok(())
                } else {
                    Err(Diagnostic::error(
                        "incompatible_type",
                        location,
                        format!("Boolean expression cannot satisfy {target:?}"),
                    )
                    .into())
                }
            }
            Expression::Literal { value } => {
                validate_value(&Value::from_json(value)?, target, location)
            }
            Expression::Ref(reference) => {
                let source = self.reference_type(reference, location)?;
                if compatible(&source, target) {
                    Ok(())
                } else {
                    Err(Diagnostic::error(
                        "incompatible_type",
                        location,
                        format!("Expected {target:?}, reference produces {source:?}"),
                    )
                    .into())
                }
            }
            Expression::Array { items } => {
                let item_type = match target {
                    Type::Array { items, .. } => items.as_ref(),
                    Type::Json => &Type::Json,
                    _ => {
                        return Err(Diagnostic::error(
                            "incompatible_type",
                            location,
                            format!("Array construction cannot satisfy {target:?}"),
                        )
                        .into());
                    }
                };
                for (i, item) in items.iter().enumerate() {
                    self.check_expression(
                        item,
                        item_type,
                        &pointer(&pointer(location, "items"), i),
                    )?;
                }
                Ok(())
            }
            Expression::Object { fields } => {
                match target {
                    Type::Json => {
                        for (name, expr) in fields {
                            self.check_expression(
                                expr,
                                &Type::Json,
                                &pointer(&pointer(location, "fields"), name),
                            )?;
                        }
                    }
                    Type::Object {
                        properties,
                        required,
                        additional,
                        ..
                    } => {
                        for name in required {
                            if !fields.contains_key(name) {
                                return Err(Diagnostic::error(
                                    "missing_property",
                                    location,
                                    format!("Missing required property {name:?}"),
                                )
                                .into());
                            }
                        }
                        for (name, expr) in fields {
                            let path = pointer(&pointer(location, "fields"), name);
                            let ty = properties
                                .get(name)
                                .or_else(|| additional.ty())
                                .ok_or_else(|| {
                                    Diagnostic::error(
                                        "unexpected_property",
                                        &path,
                                        "Object construction has an undeclared property",
                                    )
                                })?;
                            self.check_expression(expr, ty, &path)?;
                        }
                    }
                    _ => {
                        return Err(Diagnostic::error(
                            "incompatible_type",
                            location,
                            format!("Object construction cannot satisfy {target:?}"),
                        )
                        .into());
                    }
                }
                Ok(())
            }
        }
    }

    fn expression_type(
        &mut self,
        expression: &Expression,
        location: &str,
    ) -> Result<Type, ValidationError> {
        match expression {
            Expression::Literal { value } => {
                Ok(crate::conditions::scalar_type(&Value::from_json(value)?))
            }
            Expression::Ref(reference) => self.reference_type(reference, location),
            Expression::Object { .. } | Expression::Array { .. } => {
                self.check_expression(expression, &Type::Json, location)?;
                Ok(Type::Json)
            }
            _ => {
                self.condition_type(expression, location)?;
                Ok(boolean_type())
            }
        }
    }
    fn condition_type(
        &mut self,
        expression: &Expression,
        location: &str,
    ) -> Result<(), ValidationError> {
        match expression {
            Expression::Compare {
                operator,
                left,
                right,
            } => {
                let left = self.expression_type(left, &pointer(location, "left"))?;
                let right = self.expression_type(right, &pointer(location, "right"))?;
                validate_comparison_types(*operator, &left, &right, location)
            }
            Expression::And { operands } | Expression::Or { operands } => {
                for (i, operand) in operands.iter().enumerate() {
                    self.check_expression(
                        operand,
                        &boolean_type(),
                        &pointer(&pointer(location, "operands"), i),
                    )?;
                }
                Ok(())
            }
            Expression::Not { operand } => {
                self.check_expression(operand, &boolean_type(), &pointer(location, "operand"))
            }
            _ => self.check_expression(expression, &boolean_type(), location),
        }
    }

    fn reference_type(
        &mut self,
        reference: &Reference,
        location: &str,
    ) -> Result<Type, ValidationError> {
        let mut ty = match reference {
            Reference::Input { name, .. } => self
                .workflow
                .inputs
                .get(name)
                .map(|v| v.ty.clone())
                .ok_or_else(|| {
                Diagnostic::error(
                    "unknown_reference",
                    location,
                    format!("Unknown workflow input {name:?}"),
                )
            })?,
            Reference::Step { step, output, .. } => {
                let producer = self.available.get(step).ok_or_else(|| {
                    match self.positions.get(step) {
                        Some((_, _, false)) => Diagnostic::error("branch_output", location, "Branches do not publish output values"),
                        Some((scope, _, _)) if scope == &self.sequence || self.sequence.starts_with(&format!("{scope}/steps/")) =>
                            Diagnostic::error("forward_reference", location, "Step references must target a strictly earlier invocation"),
                        Some(_) => Diagnostic::error("out_of_scope", location, format!("Producer {step:?} is local to another branch; branch results cannot escape or cross arms")),
                        None => Diagnostic::error("unknown_reference", location, format!("Unknown producer {step:?}")),
                    }
                })?;
                producer
                    .outputs
                    .get(output)
                    .map(|o| o.ty.clone())
                    .ok_or_else(|| {
                        Diagnostic::error(
                            "unknown_output",
                            location,
                            format!("Producer {step:?} has no output {output:?}"),
                        )
                    })?
            }
        };
        for (i, segment) in reference.path().iter().enumerate() {
            let path = pointer(&pointer(location, "path"), i);
            if ty.nullable() && !matches!(ty, Type::Null | Type::Json) {
                self.diagnostics.push(Diagnostic::warning(
                    "runtime_presence",
                    &path,
                    "Traversal may encounter null; runtime presence check required",
                ));
            }
            ty = match (&ty, segment) {
                (Type::Opaque { .. }, _) => {
                    return Err(Diagnostic::error(
                        "opaque_traversal",
                        &path,
                        "Opaque values have no accessible properties",
                    )
                    .into());
                }
                (
                    Type::Object {
                        properties,
                        required,
                        additional,
                        ..
                    },
                    PathSegment::Key(key),
                ) => {
                    let next =
                        properties
                            .get(key)
                            .or_else(|| additional.ty())
                            .ok_or_else(|| {
                                Diagnostic::error(
                                    "invalid_path",
                                    &path,
                                    format!("Object cannot contain key {key:?}"),
                                )
                            })?;
                    if !required.contains(key) {
                        self.diagnostics.push(Diagnostic::warning(
                            "runtime_presence",
                            &path,
                            "Property may be absent; runtime presence check required",
                        ));
                    }
                    next.clone()
                }
                (Type::Array { items, .. }, PathSegment::Index(_)) => {
                    self.diagnostics.push(Diagnostic::warning(
                        "runtime_presence",
                        &path,
                        "Array index may be out of range; runtime presence check required",
                    ));
                    items.as_ref().clone()
                }
                (Type::Json, _) => {
                    self.diagnostics.push(Diagnostic::warning(
                        "runtime_presence",
                        &path,
                        "JSON shape is unknown; runtime traversal check required",
                    ));
                    Type::Json
                }
                _ => {
                    return Err(Diagnostic::error(
                        "invalid_path",
                        &path,
                        format!("Cannot traverse {ty:?} using {segment:?}"),
                    )
                    .into());
                }
            };
        }
        Ok(ty)
    }
}

/// Evaluate pure expressions against already published immutable values.
pub fn evaluate(
    expression: &Expression,
    inputs: &Named<Value>,
    steps: &Named<Named<Value>>,
    location: &str,
) -> Result<Value, ValidationError> {
    match expression {
        Expression::Compare {
            operator,
            left,
            right,
        } => {
            let left = evaluate(left, inputs, steps, &pointer(location, "left"))?;
            let right = evaluate(right, inputs, steps, &pointer(location, "right"))?;
            Ok(Value::Boolean(crate::conditions::compare_values(
                *operator, &left, &right, location,
            )?))
        }
        Expression::And { operands } | Expression::Or { operands } => {
            let conjunction = matches!(expression, Expression::And { .. });
            for (i, operand) in operands.iter().enumerate() {
                let path = pointer(&pointer(location, "operands"), i);
                let value = require_boolean(&evaluate(operand, inputs, steps, &path)?, &path)?;
                if value != conjunction {
                    return Ok(Value::Boolean(value));
                }
            }
            Ok(Value::Boolean(conjunction))
        }
        Expression::Not { operand } => {
            let path = pointer(location, "operand");
            Ok(Value::Boolean(!require_boolean(
                &evaluate(operand, inputs, steps, &path)?,
                &path,
            )?))
        }
        Expression::Literal { value } => Value::from_json(value),
        Expression::Object { fields } => Ok(Value::Object(std::sync::Arc::new(
            fields
                .iter()
                .map(|(k, e)| {
                    Ok((
                        k.clone(),
                        evaluate(e, inputs, steps, &pointer(&pointer(location, "fields"), k))?,
                    ))
                })
                .collect::<Result<_, ValidationError>>()?,
        ))),
        Expression::Array { items } => Ok(Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, e)| evaluate(e, inputs, steps, &pointer(&pointer(location, "items"), i)))
                .collect::<Result<Vec<_>, _>>()?
                .into(),
        )),
        Expression::Ref(reference) => {
            let mut value = match reference {
                Reference::Input { name, .. } => inputs.get(name),
                Reference::Step { step, output, .. } => {
                    steps.get(step).and_then(|outputs| outputs.get(output))
                }
            }
            .ok_or_else(|| {
                Diagnostic::error(
                    "missing_reference",
                    location,
                    "Referenced value is not published",
                )
            })?;
            for (i, segment) in reference.path().iter().enumerate() {
                value = match (value, segment) {
                    (Value::Object(fields), PathSegment::Key(key)) => fields.get(key),
                    (Value::Array(items), PathSegment::Index(index)) => {
                        usize::try_from(*index).ok().and_then(|i| items.get(i))
                    }
                    _ => None,
                }
                .ok_or_else(|| {
                    Diagnostic::error(
                        "runtime_presence",
                        &pointer(&pointer(location, "path"), i),
                        "Missing property/index or invalid traversal",
                    )
                })?;
            }
            Ok(value.clone())
        }
    }
}

/// Complete records are mandatory; no partial result is a successful publication.
pub fn validate_outputs(
    values: &Named<Value>,
    definition: &OperationDefinition,
    location: &str,
) -> Result<(), ValidationError> {
    let expected: BTreeSet<_> = definition.outputs.keys().collect();
    let actual: BTreeSet<_> = values.keys().collect();
    if expected != actual {
        return Err(Diagnostic::error(
            "output_record",
            location,
            format!("Expected output ports {expected:?}, received {actual:?}"),
        )
        .into());
    }
    for (name, output) in &definition.outputs {
        validate_value(&values[name], &output.ty, &pointer(location, name))?;
    }
    Ok(())
}
