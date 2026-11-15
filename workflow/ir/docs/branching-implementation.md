# Conditional branching implementation and verification

Conditional workflows now compile, validate, edit, round-trip and execute through
the existing stack. The normative [v0.2 extension](branching-v0.2.md) defines the
new behavior. All original sequential fixtures remain v0.1.

| Responsibility | Implementation |
| --- | --- |
| Representation | `crates/aixand-ir/src/model.rs`: Step::Branch and Compare/And/Or/Not expressions; new `workflow-0.2` and `shared-0.2` schemas |
| Validation | `crates/aixand-ir/src/conditions.rs`, `validation.rs`, `schema.rs`: strict scalar comparisons, booleans, nested scope checks, global IDs and version dispatch |
| Runner | `crates/aixand-ir-runner/src/runner.rs`: recursive sequential block execution, one condition evaluation, one selected arm, existing cancellation/cleanup |
| Events | BranchEvaluated carries invocation, boolean result and selected arm; existing failures retain branch or innermost operation context |
| Python | `crates/aixand-ir-frontend/src/lib.rs`: ast.If, Compare, BoolOp and Not lowering; lexical symbols, deterministic IDs, located diagnostics |
| Frontend mappings | `mappings/aixand.json`: verifier.verify result properties added as frontend metadata; portable operation contracts and real bindings unchanged |
| Web | `apps/web/src/workflows/SequenceEditor.tsx`: nested IR sequences and THEN/ELSE; ExpressionEditor adds conditions; existing page, IR types/helpers and RunPanel extended |
| Bridge | `apps/server/workflow-bridge/src/main.rs`: sequence-path reference discovery through core visibility, branch fixtures and runner events |
| CLI | Schema selection accepts `--ir-version 0.2`; existing compile/validate/run commands handle branches |

Step IDs are globally unique. Pre-branch values enter both arms; values produced
inside an arm are visible only later in that arm and its descendants. All names
assigned by Python in either arm become unavailable afterward, including rebound
outer names. There are no branch outputs, automatic merges or phi nodes. Explicit
resource operations and the existing workflow Scope retain lifetime ownership.

Python supports boolean parameters/results/mapped properties, six scalar comparison
operators, and/or/not, parentheses, if/elif/else and nested conditionals. It does not
execute or fold conditions during compilation. Chained comparisons, truthiness,
arithmetic, is/in, arbitrary Python, loops and early returns are rejected with
source spans. Equality is scalar; ordering is numeric. These deliberate limits
are shared by IR validation where applicable, not silently implemented in Web.

## Fixtures

- [Python source](../examples/branching/workflow.py), [independent hand-authored IR](../examples/branching/workflow.json), and [generated IR](../examples/branching/generated.json) compare as equal parsed IR documents.
- The existing Verifier binding selects `verify_2` or `verify_3`, followed by `verify_4`; the original `verify_1` publishes the final passed/summary outputs.
- Browser tests create a workflow visually and assert that the transmitted run source exactly equals its exported IR, using the real bridge and Verifier binding.

## Tests

Relevant coverage is located in:

| Suite | Coverage |
| --- | --- |
| Core `tests/branching.rs` (4) | v0.1/v0.2 schemas, malformed structures, comparison/type matrix, and/or/not, short circuit, nested visibility, duplicate IDs, cross-arm and forward references |
| Runner `tests/branching.rs` (6) | Both outcomes, exactly one branch event/evaluation, ordered selected effects, missing else, nested branches, selected failure, cancellation, cleanup and binding preflight |
| Frontend `tests/branching.rs` (6) | If/elif/else, properties, comparisons/boolean syntax, scope escape/rebinding, rejected syntax/source locations, no constant folding, fixture equality and real Verifier execution |
| Web `tests/branching.spec.ts` (9) | Import/export/round trip, visual creation, arm edits/order, comparisons/booleans, lexical filtering, missing else, condition errors, actual run events/outputs/failures, accessibility and narrow layouts |
| Bridge unit tests (1) | Both branching fixture round trips and block-local reference discovery using Rust core |

Run the relevant Rust, bridge and browser suites against the current checkout.
Use the SDK fixture environment where required; fixture coverage does not
establish live provider or production deployment qualification.

## Compatibility and deferred work

No unexpected IR, runner or SDK architecture issue was found. Structured control
flow requires v0.2, as v0.1 intentionally excluded it; no existing semantic rule
was weakened to accommodate the UI. Catalog contracts and production SDK bindings
remain unchanged. Rust consumers now match the Step enum (`Operation` remains an
alias); identity/input accessors return Option because a Branch has neither.
Serialized v0.1 compatibility and sequential behavior are preserved.

Branch-result merging is intentionally deferred. No loops, parallelism, joins,
retries, exceptions, triggers, subworkflows, checkpoints, durability or DAG
scheduler were introduced. The Web draft/run-history and JSON-interface limits
are unchanged. Python remains one frontend for portable IR.
