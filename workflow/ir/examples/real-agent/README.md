# Real managed Codex workflow

[workflow.json](workflow.json) is a hand-authored v0.1 IR document with one input,
`task`. Its six operations spawn Codex with an existing `backup` profile, send
`task`, wait after that receipt, send `Summarize your findings.`, wait after the
second receipt, and explicitly stop the same agent. The workflow returns the
run ID and both immutable readiness observations after the stop succeeds.

The implementation and example host are Rust. No Python compiler is involved.

```text
workflow.json → Rust IR validator/runner → Rust/PyO3 bindings
             → aixand-suite-python → Agent Manager / Undercurrent
```

[catalog.json](catalog.json) selects exactly four existing `1.0.0` operation
definitions from the completed Aixand catalog. Their definitions and nominal
types are unchanged; the test suite checks exact equality.

| Operation | SDK call | Published outputs |
|---|---|---|
| `aixand.agents.spawn` | `aixand.agents.spawn(...)` | Opaque `aixand.agent@1`, ordinary `run_id`, nullable `address` |
| `aixand.agent.send` | `Agent.send(text, ...)` | Opaque `aixand.input_receipt@1` |
| `aixand.agent.wait` | `Agent.wait(...)` | Selected ordinary observation fields |
| `aixand.agent.stop` | `Agent.stop(force=False)` | Empty record |

`install_catalog` and `install_connection_catalog` in the
[Rust adapter](../../crates/aixand-ir-aixand/src/lib.rs) install only selected
contracts. Unknown identities/versions and changed definitions fail resolution.
The runner prepares all bindings before the first workflow effect. Existing
full-catalog installation remains available to other applications.

The adapter retains the SDK's native Agent and InputReceipt objects. References
preserve identity. No client, loop, lock, credential, journal or consumer enters
the workflow. An absent `after` keyword remains absent, explicit null becomes
Python `None`, and an explicit receipt is forwarded unchanged. The SDK owns the
latest-direct-send boundary, receipt affinity checks, input delivery, stability
observation, process management and cancellation. Direct input needs no Carrier
mailbox; this workflow leaves `address` absent.

To run, start in `workflow/ir` in the Suite checkout. Use the existing authenticated
Agent Manager configuration and running Undercurrent daemon. The checked-in
runtime example points to the sibling development bridge; change that path to
your matching installed bridge if needed. For initial SDK installation:

```sh
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python -e ../../../manager-suites/agent-manager -e ../../../carrier -e ../../../undercurrent/python -e ../../sdks/python
```

Keep an already prepared environment instead of recreating it. The Python
environment must match the interpreter linked by PyO3. Put its `bin` directory
on `PATH` when launching the Rust host: Agent Manager starts its supervisor with
Python's `sys.executable`, so that child interpreter must also have the SDKs
installed. `python_paths` alone only changes imports in the embedded interpreter.

Packaged embedded hosts instead supply the runtime-only `python_interpreter`
object shown in `runtime.embedded.example.json`. Replace its executable and home
with absolute installation paths. `home` is `sys.base_prefix`, the stdlib/base
installation matching the CPython library linked into the host. Standalone
installations need only `executable` and `home`. For a selected virtual environment,
also supply `prefix` from its `sys.prefix` and `base_executable` from its
`sys._base_executable`; `executable` remains the selected venv Python. Discovery
captures these values from that interpreter rather than guessing its layout.
For an accepted CLI wrapper, discovery preserves the wrapper for CLI use and
uses the probe's actual `sys.executable` for embedded interpreter configuration.
The selected executable must belong to its declared prefix (a Unix symlink into
the base home or a copied Windows launcher is supported), and the base executable
must belong to the base home. These trusted
host settings never belong in portable workflow inputs. They configure CPython's
program name, executable and prefix before any SDK or frontend Python imports,
so SDK supervisors run the private Python rather than the Rust host. The host
disables signal-handler installation and bytecode writes. One process owns one
interpreter: concurrent scopes may reuse the same identities, while conflicting paths
or venv prefixes, even when they share one base executable, are rejected. Hosts must call
`Config::initialize_python` before any other Python APIs. Omitting the object
retains the existing PyO3 initialization behavior and the PATH requirement above;
custom configurations are not silently rewritten by the SDK.

```sh
PATH="$PWD/.venv/bin:$PATH" cargo run -p aixand-ir-aixand --example real_agent -- \
  --sdk-config examples/real-agent/runtime.example.json
```

The [Rust host](../../crates/aixand-ir-aixand/examples/real_agent.rs) loads
workflow, catalog, input JSON and runtime configuration from files. It validates,
resolves bindings and calls `Runner::run_scoped_json`; it contains no hard-coded
agent sequence. Optional `--workflow`, `--catalog` and `--inputs` select other
files. Stdout contains the ordinary JSON result. Stderr contains runner events
and structured failures. Ctrl-C cancels the runner and waits for scope cleanup.

The supplied workflow's `cwd: ".."` selects the parent `workflow` directory
in a Suite checkout. This literal and the `backup` profile are machine-specific;
the historical run used a trusted project directory. The task reads
only the included fixture. On another machine, set `profile` and `cwd` literals
to an existing authenticated profile and suitable trusted project, then adjust
the fixture path in `inputs.json`. Authentication remains entirely managed by
Agent Manager. No credential files are copied into the example.

The final IR operation performs the normal stop. The host also selects the
existing `StopOwned` scope policy, so partial failures and cancellation close
the SDK connection and stop agents it owns. The SDK skips agents already
explicitly stopped. Cleanup errors accompany the primary operation failure;
there is no automatic workflow retry.

Deterministic verification:

```sh
cargo test -p aixand-ir-aixand --test real_workflow
AIXAND_IR_SDK_SITE_PACKAGES="$PWD/.venv/lib/python3.14/site-packages" \
  cargo test -p aixand-ir-aixand --features sdk-tests
```

The six new Rust fake-binding tests cover exact catalog compatibility, missing
and incompatible bindings, opaque Agent identity, distinct receipt identity,
both explicit wait references, asynchronous sequence ordering, explicit stop,
failure at every step, cleanup before spawn publication, and secondary cleanup
errors. A new SDK test runs this same document through actual SDK objects over
controlled transports, confirms the stop before cleanup, and confirms that
unselected operations have no binding. Existing SDK tests additionally cover
omitted/null/explicit waits, foreign and revisionless receipts, uncertain
delivery, partial setup failure, and cancellation joining.

The historical example implementation findings are:

| Boundary | Finding |
|---|---|
| IR semantics | All six steps and their dependencies fit v0.1. No missing semantic and no specification change. Stop remains an ordinary effect even though its result is unused. |
| Operation contracts | The four existing contracts suffice unchanged. Readiness is an observation, not proof of task success; terminal evidence independently demonstrates the two answers. |
| Runtime binding/configuration | Selective installation was added. Interpreter imports, bridge path, profile configuration and directory trust stay outside IR semantics. The startup prompt was resolved using an already trusted working directory. |
| SDK API | No API change was needed. Native delivery/wait/stop semantics remain intact. Known owned agents are cleaned up after partial failure. A launch that fails before the SDK obtains a confirmed handle may retain only an unconfirmed run ID; the existing SDK records that uncertainty for Agent Manager reconciliation, and this adapter does not promise termination of an unknown session. |

This sequential example added no branching, loops, parallel execution, retries,
triggers, durability or Python AST compilation. Current component capabilities
are described in [implementation status](../../docs/architecture/composition.md#implementation-status).
