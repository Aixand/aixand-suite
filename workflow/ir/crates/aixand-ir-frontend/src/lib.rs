//! Restricted Python AST compilation, implemented in Rust. CPython parses syntax;
//! workflow source, imports, decorators, annotations and calls are never executed.
mod diagnostic;
mod mapping;
use aixand_ir::*;
use diagnostic::Source;
pub use diagnostic::{CompilerDiagnostic, CompilerError, SourceSpan};
pub use mapping::*;
use pyo3::{prelude::*, types::PyDict};
use serde_json::Value as Json;
use std::collections::BTreeSet;

type Result<T> = std::result::Result<T, CompilerError>;
fn kind(node: &Bound<'_, PyAny>) -> String {
    node.get_type()
        .name()
        .map(|s| s.to_string())
        .unwrap_or_default()
}
fn attr(node: &Bound<'_, PyAny>, name: &str) -> Result<String> {
    Ok(node.getattr(name)?.extract()?)
}
fn children<'py>(node: &Bound<'py, PyAny>, name: &str) -> Result<Vec<Bound<'py, PyAny>>> {
    node.getattr(name)?
        .try_iter()?
        .map(|v| v.map_err(Into::into))
        .collect()
}
fn dotted(node: &Bound<'_, PyAny>) -> Option<String> {
    match kind(node).as_str() {
        "Name" => attr(node, "id").ok(),
        "Attribute" => Some(format!(
            "{}.{}",
            dotted(&node.getattr("value").ok()?)?,
            attr(node, "attr").ok()?
        )),
        _ => None,
    }
}

#[derive(Clone)]
struct Symbol {
    value: Expression,
    ty: Type,
    properties: Named<Symbol>,
}
impl Symbol {
    fn new(value: Expression, ty: Type) -> Self {
        Self {
            value,
            ty,
            properties: Named::new(),
        }
    }
    // Unannotated ordinary container outputs deliberately publish the JSON
    // boundary. Scalars and capabilities retain their exact inferred types.
    fn output_type(&self) -> Type {
        if matches!(self.ty, Type::Array { .. } | Type::Object { .. }) && self.ty.json_only() {
            Type::Json
        } else {
            self.ty.clone()
        }
    }
}
struct Lowerer<'a> {
    source: Source<'a>,
    catalogs: &'a CatalogRegistry,
    mappings: &'a MappingRegistry,
    symbols: Named<Symbol>,
    locals: BTreeSet<String>,
    counts: Named<usize>,
    block: Vec<(usize, bool)>,
    branch_locals: BTreeSet<String>,
    workflow: Workflow,
    locations: Named<SourceSpan>,
}
impl Lowerer<'_> {
    fn error(
        &self,
        node: &Bound<'_, PyAny>,
        code: &str,
        message: impl Into<String>,
    ) -> CompilerError {
        self.source.error(Some(node), code, message)
    }
    fn mark(&mut self, path: &str, node: &Bound<'_, PyAny>) {
        self.locations
            .insert(path.into(), self.source.span(Some(node)));
    }
    fn validate(&self) -> Result<()> {
        validate_workflow(&self.workflow, self.catalogs)
            .map_err(|e| self.source.relocate(e, &self.locations))?;
        Ok(())
    }
    fn symbol(&self, node: &Bound<'_, PyAny>) -> Result<Symbol> {
        let name = attr(node, "id")?;
        self.symbols.get(&name).cloned().ok_or_else(|| {
            if self.branch_locals.contains(&name) {
                self.error(node, "branch_result", format!("{name:?} was assigned inside a branch; branch-local values cannot escape and branch-result merging is not supported. Assign a new value before using this name."))
            } else if self.locals.contains(&name) {
                self.error(
                    node,
                    "unavailable_value",
                    format!("Local {name:?} has no value yet; forward references are unsupported"),
                )
            } else {
                self.error(
                    node,
                    "undefined_variable",
                    format!("Undefined workflow variable {name:?}"),
                )
            }
        })
    }
    fn annotation(&self, node: &Bound<'_, PyAny>) -> Result<Type> {
        let scalar = match dotted(node).as_deref() {
            Some("str") => Some(Type::String { nullable: false }),
            Some("int") => Some(Type::Integer { nullable: false }),
            Some("float") => Some(Type::Number { nullable: false }),
            Some("bool") => Some(Type::Boolean { nullable: false }),
            // Frontend annotation marker only; no SDK import or attribute lookup.
            Some("aixand.Json") => Some(Type::Json),
            _ => None,
        };
        if let Some(ty) = scalar {
            return Ok(ty);
        }
        if kind(node) == "Constant" && node.getattr("value")?.is_none() {
            return Ok(Type::Null);
        }
        if kind(node) == "Subscript" {
            let base = dotted(&node.getattr("value")?);
            let slice = node.getattr("slice")?;
            if base.as_deref() == Some("list") {
                return Ok(Type::Array {
                    items: Box::new(self.annotation(&slice)?),
                    nullable: false,
                });
            }
            if base.as_deref() == Some("dict") && kind(&slice) == "Tuple" {
                let parts = children(&slice, "elts")?;
                if parts.len() == 2 && dotted(&parts[0]).as_deref() == Some("str") {
                    return Ok(Type::Object {
                        properties: Named::new(),
                        required: vec![],
                        additional: Additional::Typed(Box::new(self.annotation(&parts[1])?)),
                        nullable: false,
                    });
                }
            }
        }
        if kind(node) == "BinOp" && kind(&node.getattr("op")?) == "BitOr" {
            let left = self.annotation(&node.getattr("left")?)?;
            let right = self.annotation(&node.getattr("right")?)?;
            let mut ty = if left == Type::Null {
                right
            } else if right == Type::Null {
                left
            } else {
                return Err(self.error(node, "annotation", "Only T | None unions are supported"));
            };
            match &mut ty {
                Type::Null | Type::Json => {}
                Type::Boolean { nullable }
                | Type::Integer { nullable }
                | Type::Number { nullable }
                | Type::String { nullable }
                | Type::Array { nullable, .. }
                | Type::Object { nullable, .. }
                | Type::Opaque { nullable, .. } => *nullable = true,
            }
            return Ok(ty);
        }
        Err(self.error(
            node,
            "annotation",
            "Expected str, int, float, bool, None, list[T], dict[str, T], T | None, or aixand.Json",
        ))
    }
    fn literal(&self, node: &Bound<'_, PyAny>) -> Result<Json> {
        if kind(node) == "UnaryOp" {
            let operand = node.getattr("operand")?;
            let op = kind(&node.getattr("op")?);
            if kind(&operand) != "Constant" || !matches!(op.as_str(), "UAdd" | "USub") {
                return Err(self.error(
                    node,
                    "literal",
                    "Only a numeric literal may have a unary + or - sign",
                ));
            }
            let value = self.literal(&operand)?;
            if !value.is_number() {
                return Err(self.error(node, "literal", "Unary signs require a numeric literal"));
            }
            if op == "UAdd" {
                return Ok(value);
            }
            return Ok(if let Some(n) = value.as_i64() {
                Json::from(-n)
            } else {
                Json::from(-value.as_f64().expect("finite JSON number"))
            });
        }
        if kind(node) != "Constant" {
            return Err(self.error(node, "literal", "Expected a literal constant"));
        }
        let value = node.getattr("value")?;
        if !value.is_none() && !matches!(kind(&value).as_str(), "str" | "bool" | "int" | "float") {
            return Err(self.error(
                node,
                "literal",
                "Only None, bool, safe integer, finite float and string literals are supported",
            ));
        }
        let kwargs = PyDict::new(node.py());
        kwargs.set_item("allow_nan", false)?;
        let encoded: String = node
            .py()
            .import("json")?
            .getattr("dumps")?
            .call((value,), Some(&kwargs))
            .and_then(|v| v.extract())
            .map_err(|e| self.error(node, "literal", e.to_string()))?;
        parse_json(&encoded).map_err(|e| self.error(node, "literal", e.to_string()))
    }
    fn sequence(&mut self) -> &mut Sequence {
        let mut sequence = &mut self.workflow.body;
        for &(index, then_arm) in &self.block {
            let Step::Branch {
                then, otherwise, ..
            } = &mut sequence.steps_mut()[index]
            else {
                unreachable!()
            };
            sequence = if then_arm {
                then
            } else {
                otherwise.as_mut().expect("else block")
            };
        }
        sequence
    }
    fn block_path(&self) -> String {
        let mut path = "/body".to_owned();
        for &(index, then_arm) in &self.block {
            path.push_str(&format!(
                "/steps/{index}/{}",
                if then_arm { "then" } else { "else" }
            ));
        }
        path
    }
    fn next_id(&mut self, verb: &str) -> String {
        let count = self.counts.entry(verb.into()).or_default();
        *count += 1;
        format!("{verb}_{count}")
    }
    fn conditional_expression(&mut self, node: &Bound<'_, PyAny>, path: &str) -> Result<Symbol> {
        self.workflow.ir_version = "0.2".into();
        let value = match kind(node).as_str() {
            "Compare" => {
                let operators = children(node, "ops")?;
                let operands = children(node, "comparators")?;
                if operators.len() != 1 {
                    return Err(self.error(node, "condition", "Chained comparisons are unsupported; combine explicit comparisons with and"));
                }
                let operator = match kind(&operators[0]).as_str() {
                    "Eq" => Comparison::Eq, "NotEq" => Comparison::Ne,
                    "Lt" => Comparison::Lt, "LtE" => Comparison::Le,
                    "Gt" => Comparison::Gt, "GtE" => Comparison::Ge,
                    _ => return Err(self.error(node, "condition", "Only ==, !=, <, <=, > and >= comparisons are supported; identity and membership are not workflow conditions")),
                };
                let left = self.expr(&node.getattr("left")?, &pointer(path, "left"))?;
                let right = self.expr(&operands[0], &pointer(path, "right"))?;
                validate_comparison_types(operator, &left.ty, &right.ty, path)
                    .map_err(|e| self.source.relocate(e, &self.locations))?;
                Expression::Compare {
                    operator,
                    left: Box::new(left.value),
                    right: Box::new(right.value),
                }
            }
            "BoolOp" => {
                let mut operands = vec![];
                for (i, operand) in children(node, "values")?.iter().enumerate() {
                    operands.push(
                        self.boolean_expression(operand, &pointer(&pointer(path, "operands"), i))?,
                    );
                }
                match kind(&node.getattr("op")?).as_str() {
                    "And" => Expression::And { operands },
                    "Or" => Expression::Or { operands },
                    _ => unreachable!("Python BoolOp"),
                }
            }
            "UnaryOp" => Expression::Not {
                operand: Box::new(
                    self.boolean_expression(&node.getattr("operand")?, &pointer(path, "operand"))?,
                ),
            },
            _ => unreachable!("conditional syntax"),
        };
        Ok(Symbol::new(value, boolean_type()))
    }
    fn boolean_expression(&mut self, node: &Bound<'_, PyAny>, path: &str) -> Result<Expression> {
        let symbol = self.expr(node, path)?;
        if symbol.ty != boolean_type() {
            return Err(self.error(node, "condition_type", "Conditions require a non-null boolean; Python truthiness and operand-returning and/or are unsupported"));
        }
        Ok(symbol.value)
    }
    fn statements(&mut self, nodes: &[Bound<'_, PyAny>]) -> Result<()> {
        for node in nodes {
            match kind(node).as_str() {
                "Assign" => self.assignment(node)?,
                "Expr" => { self.invoke(&node.getattr("value")?)?; },
                "If" => self.branch(node)?,
                "Pass" => {},
                _ => return Err(self.error(node, "unsupported_statement", format!("Unsupported statement {}; only assignments, awaited operations, if/elif/else and a final top-level return are supported", kind(node)))),
            }
        }
        Ok(())
    }
    fn branch(&mut self, node: &Bound<'_, PyAny>) -> Result<()> {
        self.workflow.ir_version = "0.2".into();
        let index = self.sequence().steps().len();
        let path = format!("{}/steps/{index}", self.block_path());
        self.mark(&path, node);
        let condition =
            self.boolean_expression(&node.getattr("test")?, &pointer(&path, "condition"))?;
        let then_nodes = children(node, "body")?;
        let else_nodes = children(node, "orelse")?;
        let id = self.next_id("branch");
        self.sequence().steps_mut().push(Step::Branch {
            id,
            condition,
            then: Sequence::Sequence { steps: vec![] },
            otherwise: (!else_nodes.is_empty()).then(|| Sequence::Sequence { steps: vec![] }),
        });
        let symbols = self.symbols.clone();
        let unavailable = self.branch_locals.clone();
        self.block.push((index, true));
        self.statements(&then_nodes)?;
        self.block.pop();
        self.symbols = symbols.clone();
        self.branch_locals = unavailable.clone();
        if !else_nodes.is_empty() {
            self.block.push((index, false));
            self.statements(&else_nodes)?;
            self.block.pop();
        }
        self.symbols = symbols;
        self.branch_locals = unavailable;
        // Even rebinding an outer name cannot silently retain its pre-branch
        // value. Every name assigned in either arm becomes unavailable here.
        let mut assigned = BTreeSet::new();
        collect_locals(&then_nodes, &mut assigned)?;
        collect_locals(&else_nodes, &mut assigned)?;
        for name in assigned {
            self.symbols.remove(&name);
            self.branch_locals.insert(name);
        }
        self.validate()
    }
    fn expr(&mut self, node: &Bound<'_, PyAny>, path: &str) -> Result<Symbol> {
        self.mark(path, node);
        if matches!(kind(node).as_str(), "Compare" | "BoolOp")
            || (kind(node) == "UnaryOp" && kind(&node.getattr("op")?) == "Not")
        {
            return self.conditional_expression(node, path);
        }
        match kind(node).as_str() {
            "Constant" | "UnaryOp" => {
                let value = self.literal(node)?;
                let ty = match &value {
                    Json::Null => Type::Null,
                    Json::Bool(_) => Type::Boolean { nullable: false },
                    Json::String(_) => Type::String { nullable: false },
                    Json::Number(n) if n.as_f64().is_some_and(|v| v.fract() == 0.0 && v.abs() <= MAX_INTEGER as f64) => Type::Integer { nullable: false },
                    Json::Number(_) => Type::Number { nullable: false },
                    _ => unreachable!("literal whitelist"),
                };
                Ok(Symbol::new(Expression::Literal { value }, ty))
            }
            "Name" => self.symbol(node),
            "Attribute" => {
                let base = node.getattr("value")?;
                if kind(&base) != "Name" { return Err(self.error(node, "attribute", "Only explicitly mapped properties on a bound operation result are supported")); }
                self.symbol(&base)?.properties.get(&attr(node, "attr")?).cloned()
                    .ok_or_else(|| self.error(node, "attribute", "Property has no frontend mapping to a published output; arbitrary or opaque attribute traversal is forbidden"))
            }
            "Dict" => {
                let mut fields = Named::new();
                let mut properties = Named::new();
                for (key, value) in children(node, "keys")?.into_iter().zip(children(node, "values")?) {
                    if key.is_none() { return Err(self.error(node, "dictionary", "Dictionary unpacking is unsupported")); }
                    let key_text = self.literal(&key)?.as_str().ok_or_else(|| self.error(&key, "dictionary", "Dictionary keys must be literal strings"))?.to_owned();
                    let value = self.expr(&value, &pointer(&pointer(path, "fields"), &key_text))?;
                    properties.insert(key_text.clone(), value.ty);
                    if fields.insert(key_text, value.value).is_some() { return Err(self.error(&key, "dictionary", "Duplicate dictionary key")); }
                }
                let required = properties.keys().cloned().collect();
                Ok(Symbol::new(Expression::Object { fields }, Type::Object { properties, required, additional: Additional::default(), nullable: false }))
            }
            "List" => {
                let mut items = vec![];
                let mut types = vec![];
                for (i, item) in children(node, "elts")?.iter().enumerate() {
                    let value = self.expr(item, &pointer(&pointer(path, "items"), i))?;
                    items.push(value.value); types.push(value.ty);
                }
                let ty = types.iter().find(|target| types.iter().all(|source| compatible(source, target))).cloned()
                    .unwrap_or(Type::Json);
                if ty == Type::Json && !types.iter().all(Type::json_only) {
                    return Err(self.error(node, "list_type", "Heterogeneous lists containing opaque values have no supported element type"));
                }
                Ok(Symbol::new(Expression::Array { items }, Type::Array { items: Box::new(ty), nullable: false }))
            }
            "Call" => Err(self.error(node, "arbitrary_call", "Arbitrary Python calls are forbidden; registered operations must be awaited as standalone statements or assignments")),
            _ => Err(self.error(node, "unsupported_expression", format!("Unsupported Python expression {}", kind(node)))),
        }
    }
    fn invoke(&mut self, node: &Bound<'_, PyAny>) -> Result<Option<Symbol>> {
        if kind(node) != "Await" {
            return Err(self.error(
                node,
                "await_required",
                "Operation statements must await a registered call",
            ));
        }
        let call = node.getattr("value")?;
        if kind(&call) != "Call" {
            return Err(self.error(
                &call,
                "operation",
                "await must contain a registered operation call",
            ));
        }
        let function = call.getattr("func")?;
        let qualified = dotted(&function);
        let mut receiver_value = None;
        let mapping = if let Some(mapping) = self
            .mappings
            .0
            .iter()
            .find(|m| m.receiver.is_none() && Some(m.python.as_str()) == qualified.as_deref())
        {
            mapping.clone()
        } else if kind(&function) == "Attribute" {
            let base = function.getattr("value")?;
            if kind(&base) != "Name" {
                return Err(self.error(
                    &function,
                    "unknown_operation",
                    format!(
                        "Unregistered Python operation {}",
                        qualified.as_deref().unwrap_or("<dynamic>")
                    ),
                ));
            }
            if self.mappings.reserves(&attr(&base, "id")?) {
                return Err(self.error(
                    &function,
                    "unknown_operation",
                    "This API spelling has no registered frontend mapping",
                ));
            }
            let receiver = self.symbol(&base)?;
            let method = attr(&function, "attr")?;
            let mapping = self
                .mappings
                .0
                .iter()
                .find(|m| {
                    m.python == method && m.receiver.as_ref().is_some_and(|r| r.ty() == receiver.ty)
                })
                .ok_or_else(|| {
                    self.error(
                        &function,
                        "invalid_receiver",
                        format!(
                            "Method {method:?} is not registered for receiver type {:?}",
                            receiver.ty
                        ),
                    )
                })?
                .clone();
            receiver_value = Some(receiver.value);
            mapping
        } else {
            return Err(self.error(
                &function,
                "unknown_operation",
                "Only registered, statically named Python operations are supported",
            ));
        };
        let mut mapping = mapping;
        let mut selected = None;
        for keyword in children(&call, "keywords")? {
            if !keyword.getattr("arg")?.is_none() {
                let port = attr(&keyword, "arg")?;
                if let Some(identity) = mapping.keyword_operations.get(&port) {
                    if selected
                        .as_ref()
                        .is_some_and(|previous| previous != identity)
                    {
                        return Err(self.error(
                            &call,
                            "frontend_metadata",
                            "Keywords select conflicting operation contracts",
                        ));
                    }
                    selected = Some(identity.clone());
                }
            }
        }
        if let Some(identity) = selected {
            mapping.operation = identity;
        }
        let definition = self
            .catalogs
            .resolve(&mapping.operation)
            .cloned()
            .ok_or_else(|| {
                self.error(
                    &call,
                    "unknown_operation",
                    format!(
                        "Catalog has no exact operation {}@{}",
                        mapping.operation.id, mapping.operation.version
                    ),
                )
            })?;
        mapping
            .validate(&definition)
            .map_err(|e| self.error(&call, "frontend_metadata", e))?;
        let index = self.sequence().steps().len();
        let path = format!("{}/steps/{index}", self.block_path());
        self.mark(&path, &call);
        let mut inputs = Named::new();
        if let (Some(receiver), Some(value)) = (&mapping.receiver, receiver_value) {
            self.mark(
                &pointer(&pointer(&path, "inputs"), &receiver.port),
                &function.getattr("value")?,
            );
            inputs.insert(receiver.port.clone(), value);
        }
        let args = children(&call, "args")?;
        if args.len() > mapping.positional.len() {
            return Err(self.error(
                &call,
                "argument",
                format!(
                    "Expected at most {} positional arguments",
                    mapping.positional.len()
                ),
            ));
        }
        for (port, arg) in mapping.positional.iter().zip(args) {
            inputs.insert(
                port.clone(),
                self.expr(&arg, &pointer(&pointer(&path, "inputs"), port))?
                    .value,
            );
        }
        for keyword in children(&call, "keywords")? {
            if keyword.getattr("arg")?.is_none() {
                return Err(self.error(&keyword, "argument", "Keyword unpacking is unsupported"));
            }
            let port = attr(&keyword, "arg")?;
            if !definition.inputs.contains_key(&port) {
                return Err(self.error(
                    &keyword,
                    "unknown_input",
                    format!("Operation {} has no input {port:?}", definition.id),
                ));
            }
            if inputs.contains_key(&port) {
                return Err(self.error(
                    &keyword,
                    "argument",
                    format!("Duplicate argument {port:?}; a bound receiver cannot be overridden"),
                ));
            }
            let value = self.expr(
                &keyword.getattr("value")?,
                &pointer(&pointer(&path, "inputs"), &port),
            )?;
            inputs.insert(port, value.value);
        }
        let verb = mapping
            .operation
            .id
            .rsplit('.')
            .next()
            .expect("catalog operation ID");
        let id = self.next_id(verb);
        self.sequence().steps_mut().push(Operation::Operation {
            id: id.clone(),
            operation: mapping.operation.clone(),
            inputs,
        });
        self.validate()?; // Delegate argument names, defaults, references and types to the core.
        let Some(primary) = &mapping.result else {
            return Ok(None);
        };
        let reference = |output: &str, path: Vec<PathSegment>| {
            Expression::Ref(Reference::Step {
                step: id.clone(),
                output: output.into(),
                path,
            })
        };
        let mut symbol = Symbol::new(
            reference(primary, vec![]),
            definition.outputs[primary].ty.clone(),
        );
        for (name, property) in &mapping.properties {
            let ty = property
                .ty(&definition)
                .map_err(|e| self.error(&call, "frontend_metadata", e))?;
            symbol.properties.insert(
                name.clone(),
                Symbol::new(reference(&property.output, property.path.clone()), ty),
            );
        }
        Ok(Some(symbol))
    }
    fn assignment(&mut self, node: &Bound<'_, PyAny>) -> Result<()> {
        let targets = children(node, "targets")?;
        if targets.len() != 1 || kind(&targets[0]) != "Name" {
            return Err(self.error(node, "assignment", "Only one simple name assignment is supported; mutation and destructuring are forbidden"));
        }
        let name = attr(&targets[0], "id")?;
        if self.mappings.reserves(&name) {
            return Err(self.error(
                &targets[0],
                "reserved_name",
                "Registered API namespaces cannot be rebound",
            ));
        }
        let value = node.getattr("value")?;
        let symbol = if kind(&value) == "Await" {
            self.invoke(&value)?.ok_or_else(|| {
                self.error(
                    &value,
                    "unavailable_value",
                    "This operation has no assignable result",
                )
            })?
        } else {
            self.expr(&value, "")?
        };
        self.branch_locals.remove(&name);
        self.symbols.insert(name, symbol);
        Ok(())
    }
    fn return_value(
        &mut self,
        node: &Bound<'_, PyAny>,
        annotation: &Bound<'_, PyAny>,
    ) -> Result<()> {
        let value = node.getattr("value")?;
        let declared = if annotation.is_none() {
            None
        } else {
            Some(self.annotation(annotation)?)
        };
        let empty =
            value.is_none() || (kind(&value) == "Constant" && value.getattr("value")?.is_none());
        if empty {
            if let Some(ty) = declared.filter(|t| *t != Type::Null) {
                self.mark("/outputs/result/value", node);
                self.workflow.outputs.insert(
                    "result".into(),
                    WorkflowOutput {
                        ty,
                        value: Expression::Literal { value: Json::Null },
                        description: None,
                    },
                );
            }
            return Ok(());
        }
        // An unannotated literal-key return dictionary names workflow outputs.
        // Annotated returns (including dictionaries) produce one `result` port.
        if kind(&value) == "Dict" && declared.is_none() {
            for (key, expr) in children(&value, "keys")?
                .into_iter()
                .zip(children(&value, "values")?)
            {
                if key.is_none() {
                    return Err(self.error(
                        &value,
                        "return",
                        "Output dictionary unpacking is unsupported",
                    ));
                }
                let name = self
                    .literal(&key)?
                    .as_str()
                    .ok_or_else(|| {
                        self.error(&key, "return", "Output names must be literal strings")
                    })?
                    .to_owned();
                let path = pointer("/outputs", &name);
                self.mark(&path, &key);
                let symbol = self.expr(&expr, &pointer(&path, "value"))?;
                let output = WorkflowOutput {
                    ty: symbol.output_type(),
                    value: symbol.value,
                    description: None,
                };
                if self.workflow.outputs.insert(name, output).is_some() {
                    return Err(self.error(&key, "return", "Duplicate workflow output"));
                }
            }
        } else {
            let symbol = self.expr(&value, "/outputs/result/value")?;
            let ty = declared.unwrap_or_else(|| symbol.output_type());
            self.workflow.outputs.insert(
                "result".into(),
                WorkflowOutput {
                    ty,
                    value: symbol.value,
                    description: None,
                },
            );
        }
        Ok(())
    }
}

fn collect_locals(nodes: &[Bound<'_, PyAny>], locals: &mut BTreeSet<String>) -> Result<()> {
    for node in nodes {
        match kind(node).as_str() {
            "Assign" => {
                for target in children(node, "targets")? {
                    if kind(&target) == "Name" {
                        locals.insert(attr(&target, "id")?);
                    }
                }
            }
            "If" => {
                collect_locals(&children(node, "body")?, locals)?;
                collect_locals(&children(node, "orelse")?, locals)?;
            }
            _ => {}
        }
    }
    Ok(())
}
fn literal_data(node: &Bound<'_, PyAny>) -> Result<bool> {
    Ok(match kind(node).as_str() {
        "Constant" => true,
        "UnaryOp" => {
            matches!(kind(&node.getattr("op")?).as_str(), "USub" | "UAdd")
                && kind(&node.getattr("operand")?) == "Constant"
        }
        "List" => children(node, "elts")?
            .iter()
            .map(literal_data)
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .all(|v| v),
        "Dict" => children(node, "keys")?
            .iter()
            .chain(children(node, "values")?.iter())
            .map(literal_data)
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .all(|v| v),
        _ => false,
    })
}

/// Compile with bundled frontend mappings. The source need not import Aixand;
/// the decorator is a syntactic marker and is never evaluated.
pub fn lower_python(source: &str, catalogs: &CatalogRegistry) -> Result<Workflow> {
    compile_python(source, "<workflow>", catalogs, &MappingRegistry::aixand())
}

/// Compile one workflow against explicitly selected portable catalogs and Python
/// API metadata. Neither the runtime bindings nor aixand-python are imported.
pub fn compile_python(
    source: &str,
    filename: &str,
    catalogs: &CatalogRegistry,
    mappings: &MappingRegistry,
) -> Result<Workflow> {
    Python::attach(|py| {
        let source_info = Source::new(filename, source);
        let ast = py
            .import("ast")?
            .call_method1("parse", (source, filename))
            .map_err(|e| source_info.syntax_error(py, e))?;
        let mut function = None;
        for node in children(&ast, "body")? {
            match kind(&node).as_str() {
                "Import" => {
                    for alias in children(&node, "names")? {
                        if attr(&alias, "name")? != "aixand" || !alias.getattr("asname")?.is_none()
                        {
                            return Err(source_info.error(Some(&node), "import", "Only unaliased import aixand is supported; imports are not executed"));
                        }
                    }
                }
                "AsyncFunctionDef" if function.is_none() => function = Some(node),
                _ => {
                    return Err(source_info.error(
                        Some(&node),
                        "module",
                        "Expected optional import aixand and exactly one async workflow definition",
                    ));
                }
            }
        }
        let function = function
            .ok_or_else(|| source_info.error(None, "workflow", "No async workflow definition"))?;
        if mappings.reserves(&attr(&function, "name")?) {
            return Err(source_info.error(
                Some(&function),
                "reserved_name",
                "Workflow name cannot shadow a registered API namespace",
            ));
        }
        let decorators = children(&function, "decorator_list")?;
        if decorators.len() != 1 || dotted(&decorators[0]).as_deref() != Some("aixand.workflow") {
            return Err(source_info.error(
                Some(&function),
                "decorator",
                "Expected exactly @aixand.workflow without arguments",
            ));
        }
        if !children(&function, "type_params")?.is_empty() {
            return Err(source_info.error(
                Some(&function),
                "annotation",
                "Generic workflow parameters are unsupported",
            ));
        }
        let args = function.getattr("args")?;
        if !children(&args, "posonlyargs")?.is_empty()
            || !children(&args, "kwonlyargs")?.is_empty()
            || !args.getattr("vararg")?.is_none()
            || !args.getattr("kwarg")?.is_none()
        {
            return Err(source_info.error(Some(&function), "parameters", "Only ordinary named workflow parameters are supported; no variadics or specialized parameter forms"));
        }
        let body = children(&function, "body")?;
        let mut locals = BTreeSet::new();
        collect_locals(&body, &mut locals)?;
        let mut lower = Lowerer {
            source: source_info,
            catalogs,
            mappings,
            symbols: Named::new(),
            locals,
            counts: Named::new(),
            block: vec![],
            branch_locals: BTreeSet::new(),
            locations: Named::new(),
            workflow: Workflow {
                ir_version: "0.1".into(),
                name: Some(attr(&function, "name")?),
                description: None,
                inputs: Named::new(),
                body: Sequence::Sequence { steps: vec![] },
                outputs: Named::new(),
            },
        };
        lower.mark("", &function);
        let params = children(&args, "args")?;
        let defaults = children(&args, "defaults")?;
        for (i, param) in params.iter().enumerate() {
            let name = attr(param, "arg")?;
            if mappings.reserves(&name) || lower.symbols.contains_key(&name) {
                return Err(lower.error(
                    param,
                    "parameter",
                    "Duplicate parameter or reserved aixand namespace",
                ));
            }
            let path = pointer("/inputs", &name);
            lower.mark(&path, param);
            let annotation = param.getattr("annotation")?;
            if annotation.is_none() {
                return Err(lower.error(
                    param,
                    "annotation",
                    "Workflow parameters require a supported type annotation",
                ));
            }
            let ty = lower.annotation(&annotation)?;
            let default = if i >= params.len() - defaults.len() {
                let node = &defaults[i - (params.len() - defaults.len())];
                if !literal_data(node)? {
                    return Err(lower.error(node, "default", "Defaults must be literal data; conditions are evaluated at workflow runtime"));
                }
                let symbol = lower.expr(node, &pointer(&path, "default"))?;
                Some(
                    evaluate(&symbol.value, &Named::new(), &Named::new(), "")
                        .and_then(|v| v.to_json())
                        .map_err(|e| {
                            lower.error(
                                node,
                                "default",
                                format!("Defaults must be literal data: {e}"),
                            )
                        })?,
                )
            } else {
                None
            };
            lower.workflow.inputs.insert(
                name.clone(),
                WorkflowInput {
                    ty: ty.clone(),
                    default,
                    description: None,
                },
            );
            lower.symbols.insert(
                name.clone(),
                Symbol::new(Expression::Ref(Reference::Input { name, path: vec![] }), ty),
            );
        }
        lower.validate()?;
        let returns = function.getattr("returns")?;
        let declared = if returns.is_none() {
            None
        } else {
            Some(lower.annotation(&returns)?)
        };
        let mut returned = false;
        for (i, node) in body.iter().enumerate() {
            if kind(node) == "Return" && i + 1 == body.len() {
                lower.return_value(node, &returns)?;
                returned = true;
            } else {
                lower.statements(std::slice::from_ref(node))?;
            }
        }
        if !returned && declared.is_some_and(|t| t != Type::Null) {
            return Err(lower.error(
                &function,
                "return_type",
                "The return annotation requires a final value",
            ));
        }
        lower.validate()?;
        Ok(lower.workflow)
    })
}
