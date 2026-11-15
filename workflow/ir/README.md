# Aixand IR 0.1 / 0.2

A Rust implementation of the [v0.1 proposal](docs/specification.md): portable, exact-version operation invocations in ordered sequences. The [v0.2 extension](docs/branching-v0.2.md) adds structured conditional branches while preserving v0.1 documents. Workflows exchange immutable data and scoped opaque capabilities. Operation completion is defined by each catalog contract; agent readiness is not a research answer.

## Workspace

| Crate | Responsibility |
|---|---|
| `aixand-ir` | Closed document model, Draft 2020-12 schemas, strict JSON, RFC 8785 canonicalization, type algebra, catalogs, semantic validation and pure expression evaluation |
| `aixand-ir-runner` | Binding preparation, sequential execution, immutable publication, cancellation, diagnostics and scope cleanup |
| `aixand-ir-verifier` | Independent data-only package using the public binding API |
| `aixand-ir-aixand` | Rust/PyO3 bindings to the existing Aixand, Agent Manager, Carrier and Undercurrent SDKs |
| `aixand-ir-frontend` | Experimental Rust lowering of restricted Python ASTs; source is parsed, never executed |
| `aixand-ir-cli` | Validation, catalog/schema export, canonicalization, execution and optional frontend commands |

The core and runner have no SDK or Python dependency. Python is required only for the separate SDK adapter and AST prototype. All production implementation code is Rust; the Python file in the SDK tests supplies controlled transport fixtures.

[Independent source distribution](docs/distribution.md) describes versioned,
checksum-verified IR artifacts and combined IR/Runner builds outside a Suite checkout.

## Try it

Requires Rust 1.95 or newer. From this directory:

```sh
cargo run -p aixand-ir-cli -- validate examples/research-explicit.json
cargo run -p aixand-ir-cli -- run examples/verifier.json --inputs examples/verifier-inputs.json
cargo run -p aixand-ir-cli -- canonicalize examples/verifier.json
cargo run -p aixand-ir-cli -- schema workflow
cargo run -p aixand-ir-cli -- catalog aixand
```

The verifier returns a typed record containing `passed`, `summary` and `issues`. A failed verification is ordinary application data, not an invocation failure.

`validate --structural` requires no catalog. Semantic validation includes the two bundled catalogs; add external packages with `--catalog FILE`. Use `validate --operation-catalog FILE` to validate a catalog. Duplicate exact identities in the selected catalogs are rejected. Additional CLI catalogs do not load executable bindings: an embedding must register those explicitly.

## Rust embedding

```rust
use aixand_ir::{parse_catalog, parse_workflow, CatalogRegistry, VERIFIER_CATALOG};
use aixand_ir_runner::{BindingRegistry, CleanupPolicy, Runner};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
let workflow = parse_workflow(&std::fs::read_to_string("examples/verifier.json")?)?;
let catalogs = CatalogRegistry::new([parse_catalog(VERIFIER_CATALOG)?])?;
let mut bindings = BindingRegistry::default();
aixand_ir_verifier::register(&mut bindings)?;
let result = Runner::new(catalogs, bindings).run_json(
    &workflow,
    serde_json::json!({"title":"Architecture", "body":"A workflow invokes operations."}),
    CleanupPolicy::Detach,
    CancellationToken::new(),
).await?;
assert_eq!(result["result"]["passed"], true);
Ok(())
}
```

For opaque inputs/results, create a `Scope`, register bindings and call `Runner::run`. Keep that scope live while using returned capabilities and call `scope.close().await` when finished. `Scope::insert` stores native values separately from identity tokens; `Scope::get` checks registration and adapter compatibility. A cloned token preserves identity. Creating an `Opaque` token by hand does not make it valid.

`run_json` owns its scope; `run_scoped_json` consumes a scope configured by the caller. Both require JSON-only workflow interfaces, close the scope on every ordinary outcome, and supervise cleanup when the calling future is dropped. Cancellation is cooperative and never promises rollback or exactly-once effects. Bindings must implement cancellable I/O; a blocking implementation cannot be forcibly interrupted safely.

## Existing SDK integration

The SDK adapter uses one Python asyncio loop per Rust scope. It retains native handles, forwards omitted arguments as omitted, and uses the SDK's managed-failure-aware wait. It does not recreate delivery journals, readiness detection, inbox consumers or process supervision.

SDK hosts may use `install_with_session_observer` to receive the successful
spawn/get invocation's provider, managed run ID and Undercurrent session ID.
This host-only observer lets a UI attach a terminal preview during execution;
it exports no credentials or opaque handles and does not alter IR contracts.

Install the sibling SDKs into a local environment:

```sh
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python -e ../../../aixand-libraries/filesystem -e ../../../aixand-libraries/local-runtime -e ../../../manager-suites/agent-manager -e ../../../carrier -e ../../../undercurrent/python -e ../../sdks/python
```

Create a runtime configuration file, outside the workflow:

```json
{
  "python_paths": [".venv/lib/python3.14/site-packages"],
  "connection": {
    "timeout": 300,
    "stable_for": 2,
    "state_dir": ".aixand-runs",
    "carrier": {"mode": "private"}
  }
}
```

Use the actual site-packages path for your Python version. `connection` accepts SDK connection options; `mailbox_credentials`, `agent_credentials` and `receipt_credentials` are optional address-to-credential-file maps. Runtime configuration can contain service configuration and credentials; portable workflows and catalogs cannot.

```sh
cargo run -p aixand-ir-cli --features sdk -- run examples/research-implicit.json --inputs task-inputs.json --sdk-config runtime.json
```

`task-inputs.json` supplies `{"task":"..."}`. This command launches real agents using the configured SDK environment. Cleanup detaches by default. `--stop-owned` stops only agents spawned by that scope; explicitly invoking `aixand.agent.stop` can stop an attached agent. The supplied connection's `stop_on_exit` setting is overridden by the explicit Rust scope policy.

`examples/team.json` models the finite coordinator request/reply flow. It checks the authenticated reply sender, explicitly acknowledges the answer, and returns its content. `examples/research-explicit.json` returns a run ID after two explicit receipt waits. `examples/research-implicit.json` faithfully preserves omitted waits and returns no application result.

The [real-agent example](examples/real-agent/README.md) is a hand-authored,
six-step workflow with an explicit stop and a four-operation catalog. Its Rust
host was executed with the existing authenticated `backup` profile: both turns
completed, and an independent inspection confirmed the agent was stopped.
The example includes the command, captured evidence, tests and an abstraction
boundary report. `install_catalog` selects exact existing SDK bindings without
changing portable contracts. Live launches remain separate from deterministic
tests using Rust fake bindings and real SDK classes over controlled transports.

## Conditional branching

The existing validator, runner, Rust Python AST frontend and Aixand Web editor
support [structured branches](docs/branching-v0.2.md). Try the matching
[Python / hand-authored / generated fixtures](examples/branching/README.md).
Conditions use strict booleans, scalar comparisons and short-circuit `and`/`or`/`not`.
Invocation IDs are globally unique and arm-local values cannot escape or merge.
No loops, parallelism, retries or durability are included.

## Restricted Python frontend

```sh
cargo run -p aixand-ir-cli --features frontend -- lower-python examples/python/managed_codex_two_turns.py --catalog examples/real-agent/catalog.json
```

The Rust compiler inspects Python ASTs without executing source. Frontend
metadata maps recognized APIs to exact catalog identities; a typed symbol table
lowers assignments and method receivers into ordinary IR references. Omitted,
null and explicit-receipt waits remain distinct. Unsupported syntax and contract
errors include source spans. The [subset and compiler guide](examples/python/README.md)
documents annotations, values, returns, diagnostics and extension metadata.

The generated two-turn workflow is equivalent to the verified hand-authored IR,
including outputs, after consistent invocation renaming. It has also executed
through the existing runner and real SDK bindings, with both turns and explicit
stop confirmed. [Generated IR](examples/python/managed_codex_two_turns.json) and
[execution evidence](examples/python/evidence/run.json) are included. General
Python execution and control flow beyond structured conditionals remain outside this frontend.

## Specification and verification

- [v0.1 normative specification](docs/specification.md)
- [v0.2 branching extension](docs/branching-v0.2.md)
- [Branching implementation and verification](docs/branching-implementation.md)
- [Design decisions](docs/decisions.md)
- [Proposal requirement audit](docs/conformance.md)
- [Schema files](crates/aixand-ir/schemas/)
- [Portable operation catalogs](crates/aixand-ir/catalogs/)
- [Invalid document examples](examples/invalid/)

```sh
cargo test -p aixand-ir -p aixand-ir-runner -p aixand-ir-verifier
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
AIXAND_IR_SDK_SITE_PACKAGES="$PWD/.venv/lib/python3.14/site-packages" cargo test --workspace --all-features
```

The final command includes real SDK adaptation tests and the AST prototype. It fails if the SDK test environment is missing, rather than silently skipping the integration checks. No tests launch live agents or require real credentials.

## Host-installed SDK applications

`aixand.application.run@1.0.0` executes an async application installed in the SDK host
configuration. For example:

```json
{"applications": {"pathspec.cell.plan.v1": "pathspec_cli.cell_supervisor:run"}}
```

The operation accepts `name` (an allowlisted key) and JSON `arguments`, and returns JSON
`result`. The installed coroutine receives keyword arguments `connection` (the existing SDK
scope) and `arguments`. Use this for application-owned supervision and validation that cannot
be expressed as a fixed IR sequence. The host validates configured entrypoints as async
functions during installation. Portable workflow inputs cannot select modules or executables;
an uninstalled name fails without importing code. Treat host configuration as trusted executable
configuration. Its application names/entrypoints participate in Runner's engine fingerprint;
version application names when their behavior changes incompatibly.

Cancellation is forwarded to the coroutine and joined before scope cleanup. The application
must preserve uncertain effects and register spawned agents with its supplied connection.
Normal scope cleanup still distinguishes owned agents from attached agents. Applications should
explicitly stop attached agents only when their own workflow authorizes it.
