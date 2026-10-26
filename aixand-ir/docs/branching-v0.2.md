# Aixand IR v0.2: structured conditional branching

This extension is normative for workflow documents with `ir_version: "0.2"`.
The [v0.1 specification](specification.md) still defines types, values, operation
contracts, reference paths, invocation behavior, portable JSON and runtime scopes.
Its original schemas and sequential documents are unchanged. A v0.2 reader MUST
also accept v0.1. A v0.1 reader MUST reject v0.2 rather than ignore control flow.
Operation catalogs continue to use `contract_version: "0.1"`.

## Expressions

Literal, Reference (`ref`), Object and Array retain their v0.1 representation and
semantics. v0.2 adds these closed expression records:

| Kind | Fields | Result |
| --- | --- | --- |
| `compare` | `operator`, `left`, `right` | Boolean |
| `and` | `operands`: array of at least two expressions | Boolean |
| `or` | `operands`: array of at least two expressions | Boolean |
| `not` | `operand`: expression | Boolean |

`compare.operator` is exactly `eq`, `ne`, `lt`, `le`, `gt` or `ge`. Operands MUST
be evaluated once each, left before right. Equality and inequality accept matching
ordinary scalar families: boolean, string or numeric. Integer and number belong
to the same numeric family, with the existing safe-integer/finite-binary64 domain.
Nullable scalars are permitted for equality. Null can be compared with a scalar
or null: null equals only null. String equality is exact and case-sensitive.
Boolean values are not numbers. There is no coercion.

Ordering (`lt`, `le`, `gt`, `ge`) requires two non-null numeric operands. Ordering
strings, containers or nullable numbers is unsupported. Equality of objects,
arrays, opaque capabilities or untyped `json` is also unsupported. A nominally
unknown JSON value must first be refined by an operation with a typed contract.
Comparison validation uses published operand types, not the possible values of
a particular run. Conditions do not introduce type refinement.

`and` and `or` MUST inspect operands left to right and short-circuit. `and` stops
at the first false value; `or` stops at the first true value. Every evaluated
operand MUST be boolean. `not` evaluates its single operand once and negates a
boolean. No Python/JavaScript truthiness or operand-returning boolean behavior
exists. All operands, including short-circuited ones, are validated statically.
An absent optional path can therefore generate a presence warning without being
traversed at runtime if short-circuited.

These additions are ordinary pure IR expressions and may also appear in operation
inputs, constructed values or workflow outputs wherever a boolean fits. They
have no calls, effects, arithmetic, callbacks or general expression execution.
Existing JSON defaults remain literal data, not expression records.

## Branch structure and execution

A sequence's `steps` may contain existing Operation records or this closed record:

```json
{
  "kind": "branch",
  "id": "branch_1",
  "condition": {
    "kind": "ref", "source": "step", "step": "verify_1",
    "output": "result", "path": ["passed"]
  },
  "then": { "kind": "sequence", "steps": [] },
  "else": { "kind": "sequence", "steps": [] }
}
```

`id`, `condition` and `then` are required. `else` is optional; omission means an
empty false arm. Explicit `else: null` is invalid. Empty arms and nested Branches
are supported. A bare Sequence is not a step. Branches have no operation identity,
input map or output ports.

The runner MUST evaluate a branch condition exactly once upon reaching it and
require a boolean. It MUST execute only the selected arm, sequentially, then
continue with the enclosing sequence. It MUST NOT invoke operations in the other
arm, speculate, infer execution from reference edges, or run arms concurrently.
A condition failure or selected-arm failure fails the workflow normally and
prevents continuation. Cancellation and scope failures retain existing semantics.

Before any operation effects, semantic validation and binding preparation MUST
cover **both arms**, including statically literal-false arms. This preserves v0.1's
preparation guarantee; an unavailable binding in either arm rejects preparation.
Resolving a binding is not invoking an operation.

## Lexical values and IDs

Every step ID, including Branch IDs, MUST be globally unique throughout the whole
workflow, even in mutually exclusive arms. Existing identifier syntax applies.
References still use the global producer ID and output name; no block-qualified
reference format is introduced.

Within either arm, workflow inputs and operation values available immediately
before the branch are visible. A value published by an operation inside an arm
is visible to later steps in that same arm and to their nested branches. It is
not visible in the sibling arm, the enclosing sequence, a later sibling branch,
the branch's own condition, or the final workflow outputs. This remains true even
for literal-true conditions or when both arms happen to produce the same type.
Branches themselves publish no values. There is no implicit merge or phi node.

After returning from an arm, the runner restores the enclosing sequence's value
environment. This is **value visibility**, not a new resource lifetime. A resource
created by a selected arm remains registered with the existing workflow Scope;
leaving the arm does not stop or detach it. Existing explicit stop/ack operations
and host cleanup policy remain authoritative. On failure/cancellation, cleanup
still runs in reverse registration order and retains cleanup errors alongside
the primary failure. Unselected operations register no resources.

A later branch-result feature will need an explicit contract for published values.
It is intentionally absent here; authors can continue after a branch using only
pre-branch values or fresh root-sequence operations.

## Validation, diagnostics and events

`workflow-0.2.schema.json` and `shared-0.2.schema.json` define structure separately
from catalog-dependent validation. `parse_workflow` dispatches by `ir_version`.
The existing `validate_workflow` validates all nested blocks, operand compatibility,
boolean conditions, references and globally unique IDs. Diagnostics use exact
JSON Pointers such as `/body/steps/1/else/steps/0/inputs/document` and retain the
innermost invocation/operation context. Relevant semantic codes include
`comparison_type`, `out_of_scope`, `branch_output`, `forward_reference`, and
`duplicate_invocation`; existing type and path diagnostic codes remain in use.

`visible_operations(workflow, sequence_path, before)` exposes the same lexical
rule for authoring clients. It returns only earlier accessible operations. The
Web bridge combines this with the core type-compatibility and property APIs.

The existing runner event stream adds:

```json
{"event":"branch_evaluated","invocation":"branch_1","result":true,"selected":"then"}
```

The Rust event is `Event::BranchEvaluated` with `BranchArm::Then`/`Else`. It occurs
once after successful condition evaluation, before any selected-arm operation.
The other arm is skipped; no artificial Started/Published events are emitted for
its steps. Selecting a missing else emits `selected: "else"` and does nothing.
Nested branches emit their own events only when reached. Condition evaluation
failure emits the existing Failed event with Branch invocation context and no
operation identity. Existing operation events and completion/cleanup boundaries
are unchanged.

## Python frontend

Compilation remains Rust code using CPython's parser through PyO3. It never
executes source, imports, decorators, annotations or workflow function bodies.
`ast.If` becomes a Branch; `elif` is an If nested inside the preceding else
Sequence. The frontend's symbol table resolves references before emitting IR.

Supported conditions are boolean parameters, prior boolean results, explicitly
mapped typed properties, scalar literals/comparisons, `and`, `or`, `not` and
parentheses. The AST supplies precedence. Comparisons support exactly `==`, `!=`,
`<`, `<=`, `>`, `>=`. Conditions are never constant-folded: even `if False` emits a
Branch and its body must compile and validate. Existing literal-data defaults
are unchanged; expressions in defaults are rejected rather than evaluated as
configuration. Local literal assignments remain compiler bindings to expressions.

Every name assigned in either arm becomes unavailable after that branch. This
includes rebinding a pre-existing name: the compiler must not silently use its
old value afterward. Reassigning a fresh value afterward makes the name usable
again. A use requiring a merge receives source-located `branch_result` diagnostics.
A sibling-arm or forward use receives `unavailable_value`. Inside an arm, normal
assignments and earlier operation results remain available. A final top-level
return is supported; early/nested returns are not.

Unsupported syntax includes chained comparisons (write explicit comparisons with
`and`), `is`/`in`, truthiness, arithmetic, arbitrary calls/attributes, awaited calls
inside conditions, ternaries, comprehensions, loops, mutation, exceptions and
nested workflow definitions. Errors retain file, line, column and source span;
IR validation errors also retain their IR location.

Frontend metadata adds `aixand.verifier.verify` → `verifier.verify@1.0.0`, with
`result` as the assignment output and mapped `passed`, `summary`, `issues`
properties. Types and signatures still come from the existing Verifier catalog.
This is compiler API metadata; it does not add an executable SDK decorator or
Verifier implementation to aixand-python. The existing native Rust Verifier
binding performs the operation through the same runner used by the SDK bindings.

Generated IDs use one deterministic counter per operation suffix or `branch`
across the whole workflow. Existing sequential sources still emit v0.1 unchanged;
source containing branches or the new expressions emits v0.2.

## Web and interoperability

The existing Workflows page stores the Workflow IR record directly. A recursive
SequenceEditor displays operation cards and nested THEN/ELSE sequences. New
expression editors author compare/and/or/not records; comparison type selectors
are transient reference-picker filters, not serialized semantics. Validation and
reference compatibility remain Rust responsibilities. Adding a v0.2 construct
upgrades the document version; merely importing/exporting v0.1 does not. Removing
a branch does not silently downgrade an already-v0.2 document. Terminals and its
transport remain separate and unchanged by this extension.

The [branching example](../examples/branching/README.md) supplies independently
hand-authored IR, Python source and checked compiler output. Tests compare parsed
IR directly, import/export both fixtures in Web, create branches visually and
execute the exact serialized Web document through the existing bridge/runner.
No Python execution path, graph scheduler or second Web workflow model is added.
