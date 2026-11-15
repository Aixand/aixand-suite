# Restricted Python → Aixand IR compiler

The Rust frontend uses CPython `ast.parse` to inspect source, then emits existing
v0.1 IR for sequential sources and v0.2 IR for structured conditionals. It does not execute imports, decorators,
annotations, workflow functions or operation calls. Compilation requires the
Python interpreter linked by PyO3 (tested with Python 3.14); it does not require
the Aixand SDK, credentials, runtime services or runtime bindings.

```text
Python source → Python AST → Rust frontend → portable Aixand IR
                                              ↓
                                       existing Rust runner
                                              ↓
                                       existing SDK bindings
```

The [Python fixture](managed_codex_two_turns.py) compiles to the checked-in
[generated IR](managed_codex_two_turns.json). Its operation sequence is:

```text
spawn_1 → send_1 → wait_1 → send_2 → wait_2 → stop_1
```

The fixture captures both wait observations and returns them with `agent.run_id`
to match the complete interface of the verified
[hand-authored workflow](../real-agent/workflow.json). Omitting those assignments
and the return, as in the minimal authoring example, produces the same six
effects with an empty workflow output interface.

From `workflow/ir` in the Suite checkout:

```sh
cargo run -p aixand-ir-cli --features frontend -- lower-python \
  examples/python/managed_codex_two_turns.py \
  --catalog examples/real-agent/catalog.json \
  > target/managed_codex_two_turns.json

PATH="$PWD/.venv/bin:$PATH" cargo run -p aixand-ir-aixand --example real_agent -- \
  --workflow target/managed_codex_two_turns.json \
  --sdk-config examples/real-agent/runtime.example.json
```

The first command compiles only. Explicit `--catalog` files select the complete
catalog set for `lower-python`; omitting them uses bundled catalogs. Optional
`--mappings FILE` selects frontend metadata. The second command is the existing
Rust example host and real bindings. See the [runtime setup](../real-agent/README.md)
for the SDK environment, bridge and existing authenticated profile configuration.
The generated JSON is also usable by any other conforming IR runner.

The supported Python subset is deliberately small:

| Construct | Compilation rule |
|---|---|
| Module | Optional unaliased `import aixand`, exactly one `async def` with exactly `@aixand.workflow` |
| Parameters | Ordinary named parameters with annotations; literal data defaults allowed; no variadics, positional-only, keyword-only or generic parameters |
| Annotations | `str`, `int`, `float`, `bool`, `None`, `list[T]`, `dict[str, T]`, `T \| None`, and frontend marker `aixand.Json` |
| Assignments | One simple name bound to an awaited operation result or supported value expression; rebinding and aliases are compile-time only |
| Operations | Standalone or assigned `await` on an explicitly registered function or a method on a compatible bound receiver |
| Arguments | Positional ports defined by frontend metadata; named ports and required/default/type rules supplied by operation contracts |
| Literals | `None`, bool, safe integer, finite float, string; optional unary numeric `+`/`-` |
| Construction | Lists and dictionaries with unique literal string keys; nested supported expressions |
| References | Workflow parameters, previously assigned values, explicitly mapped published properties |
| Conditions | `if`/`elif`/`else`, non-null booleans, scalar comparisons and `and`/`or`/`not`; emitted as v0.2 Branch/expressions without constant folding |
| Return | A final top-level supported expression; unannotated literal-key dictionaries name workflow outputs; other expressions produce a `result` output |
| Empty result | No return, bare return, or `return None` with no value annotation produces `{}`; typed nullable returns can publish a null `result` |
| No-op | `pass` |

Unannotated output scalars and capabilities keep their inferred type. Ordinary
container outputs use `json`; annotated returns publish one `result` port with
the declared type. Thus an annotated dictionary return is an IR `Object`
expression under `outputs.result`, while an unannotated dictionary return names
the separate workflow ports. Return names must satisfy IR interface-name rules.
A value return annotation requires a final return. `@aixand.workflow` and
`aixand.Json` are frontend syntax markers; the compiler does not require or
add executable SDK implementations for them.

[Frontend mapping metadata](../../crates/aixand-ir-frontend/mappings/aixand.json)
contains Python API spellings, exact operation identities, positional-port
ordering, primary result ports, nominal receivers and published-property maps.
For example:

```json
{
  "python": "send",
  "receiver": {"port": "agent", "id": "aixand.agent", "version": "1"},
  "operation": {"id": "aixand.agent.send", "version": "1.0.0"},
  "positional": ["text"],
  "result": "receipt"
}
```

These records are separate from portable operation contracts and runtime
implementations. They contain no callables, SDK imports, handlers or connection
settings. On use, the frontend verifies receiver, positional, result and
property ports against the selected catalog. The core validator checks the
emitted operation arguments, required inputs, types and references. Missing
exact versions fail compilation. Existing prototype mappings for other agent
and Carrier calls were moved into the same metadata without adding contracts.
Custom metadata can map independent packages. The bundled `aixand.verifier.verify`
mapping publishes typed `passed`, `summary` and `issues` properties from the existing
Verifier contract; the branch fixture uses the ordinary runner and verifier binding.

The compiler symbol table stores an IR expression, catalog-derived type and
any mapped properties. For this fixture:

| Python binding | IR reference |
|---|---|
| `task` | Workflow input `task` |
| `agent` | `spawn_1.agent` |
| First `receipt` | `send_1.receipt` |
| `task_observation` | `wait_1.observation` |
| Reassigned `receipt` | `send_2.receipt` |
| `summary_observation` | `wait_2.observation` |
| `agent.run_id` | `spawn_1.run_id`, a separately published ordinary output |

Assignments emit no IR nodes. Rebinding `receipt` updates subsequent source
lookups; the already emitted `wait_1` retains its reference to `send_1.receipt`.
Aliases preserve the expression and property metadata. Arbitrary attribute
access, capability inspection and dynamic method lookup are rejected. API
namespaces cannot be shadowed. Invocation IDs use the operation's final ID
component plus a per-compilation occurrence count. Recompiling identical source
with the same metadata/catalogs produces identical IR.

Omission is preserved exactly:

| Source | Emitted `after` |
|---|---|
| `await agent.wait()` | Absent |
| `await agent.wait(after=None)` | `Literal(null)` |
| `await agent.wait(after=receipt)` | Reference to the corresponding send receipt |

The compiler rejects `for`, `while`, `try`, context managers, nested
definitions, comprehensions, lambdas, arbitrary calls, unawaited
operations, dynamic dispatch, arbitrary attributes/subscripts, mutation,
destructuring, arithmetic, formatted strings, unpacking and early returns.
Bytes, complex values, ellipsis, nonfinite floats, unsafe exact integers,
duplicate keys and heterogeneous opaque lists are also outside this subset.
These are frontend restrictions; none introduce new workflow semantics.

Compiler errors carry a stable code, filename, one-based line/Unicode column,
and exclusive end position. Errors originating in core validation also retain
the IR JSON Pointer, invocation ID and operation identity. For example,
`await agent.send(42)` reports the literal's source span with code `type`,
invocation `send_1`, and `/body/steps/1/inputs/text`. Non-boolean conditions report
`condition_type` at the expression; unsupported loops report `unsupported_statement`.
Missing names distinguish `undefined_variable` from `unavailable_value` for a local
assigned later or in a sibling arm. Using a name assigned inside a completed branch
reports `branch_result`; implicit merging is not supported.
The CLI writes structured diagnostics to stderr and exits unsuccessfully.

The acceptance test compares normalized IR documents directly. Normalization
only removes the description and consistently renames invocation IDs; all
operations, ordering, ports, literal values, references, omission, inputs,
outputs and type declarations remain in the comparison. A second assertion
compares the compiler result with the checked-in generated JSON without
normalization.

```sh
cargo test -p aixand-ir-frontend
AIXAND_IR_SDK_SITE_PACKAGES="$PWD/.venv/lib/python3.14/site-packages" \
  cargo test --workspace --all-features
```

The compiler tests and generated-workflow SDK integration
test cover equivalence, all requested syntax/lowering cases, metadata
validation, deterministic IDs, omission semantics, source diagnostics including
Unicode columns, a trap proving Aixand is not imported/executed, and execution
through existing runner/bindings. The SDK test verifies explicit stop before
scope cleanup can mask its absence. Six additional compiler tests cover native
conditions, nested elif, branch-local names, source diagnostics, literal conditions
and exact branching-fixture equivalence/execution. Live launches remain an example path.

The sequential fixture needs no change to v0.1 IR semantics or runtime bindings.
Conditional control flow is the explicit v0.2 extension described below. Python
assignments, API spellings and return conventions remain frontend concerns.

## Conditional workflows

Existing sequential fixtures still emit v0.1 unchanged. The Rust frontend now also
compiles native `if`/`elif`/`else` and explicit boolean/comparison expressions to
v0.2. See the [branching example](../branching/README.md) and
[conditions, scopes and diagnostics](../../docs/branching-v0.2.md). Branch-local values cannot escape or merge; loops and control flow other than
structured conditionals remain unsupported.
