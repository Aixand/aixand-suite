# Real managed Codex workflow

[workflow.json](workflow.json) is a hand-authored v0.1 IR document with one input,
`task`. Its six operations spawn Codex with an existing `backup` profile, send
`task`, wait after that receipt, send `Summarize your findings.`, wait after the
second receipt, and explicitly stop the same agent. The workflow returns the
run ID and both immutable readiness observations after the stop succeeds.

The implementation and example host are Rust. No Python compiler is involved.

```text
workflow.json → Rust IR validator/runner → Rust/PyO3 bindings
             → aixand-python → Agent Manager / Undercurrent
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

To run, start in the `aixand-ir` directory. Use the existing authenticated
Agent Manager configuration and running Undercurrent daemon. The checked-in
runtime example points to the sibling development bridge; change that path to
your matching installed bridge if needed. For initial SDK installation:

```sh
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python -e ../../manager-suites/agent-manager -e ../../carrier -e ../../undercurrent/python -e ../aixand-python
```

Keep an already prepared environment instead of recreating it. The Python
environment must match the interpreter linked by PyO3. Put its `bin` directory
on `PATH` when launching the Rust host: Agent Manager starts its supervisor with
Python's `sys.executable`, so that child interpreter must also have the SDKs
installed. `python_paths` alone only changes imports in the embedded interpreter.

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

The supplied workflow's `cwd: ".."` selects the parent `aixand-suite`
directory, already trusted by this machine's `backup` profile. The task reads
only the included fixture. On another machine, set `profile` and `cwd` literals
to an existing authenticated profile and suitable trusted project, then adjust
the fixture path in `inputs.json`. Authentication remains entirely managed by
Agent Manager. No credential files are copied into the example.

The final IR operation performs the normal stop. The host also selects the
existing `StopOwned` scope policy, so partial failures and cancellation close
the SDK connection and stop agents it owns. The SDK skips agents already
explicitly stopped. Cleanup errors accompany the primary operation failure;
there is no automatic workflow retry.

A real execution was verified on 2026-09-23 (Asia/Manila), using the existing
`backup` profile and local daemon. Run `9638a65fd29c48e4b4970ddb5e487358`
published all six steps. The two waits returned available, clear observations
at revisions 11 and 15. An independent post-run inspection confirmed lifecycle
`stopped` and no remaining process. The SDK connection was closed.

[evidence/run.json](evidence/run.json) records the document hashes, runner events,
ordinary results, final receipt revision and selected cleanup evidence.
[evidence/terminal.txt](evidence/terminal.txt) contains the observed responses to
both turns. These are captured execution evidence, not simulated output or a
test oracle. The first launch encountered Codex's directory-trust prompt in the
child directory; it was cancelled before delivery, and cleanup was independently
verified before launching in the already trusted parent.

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

The abstraction findings are:

| Boundary | Finding |
|---|---|
| IR semantics | All six steps and their dependencies fit v0.1. No missing semantic and no specification change. Stop remains an ordinary effect even though its result is unused. |
| Operation contracts | The four existing contracts suffice unchanged. Readiness is an observation, not proof of task success; terminal evidence independently demonstrates the two answers. |
| Runtime binding/configuration | Selective installation was added. Interpreter imports, bridge path, profile configuration and directory trust stay outside IR semantics. The startup prompt was resolved using an already trusted working directory. |
| SDK API | No API change was needed. Native delivery/wait/stop semantics remain intact. Known owned agents are cleaned up after partial failure. A launch that fails before the SDK obtains a confirmed handle may retain only an unconfirmed run ID; the existing SDK records that uncertainty for Agent Manager reconciliation, and this adapter does not promise termination of an unknown session. |

No branching, loops, parallel execution, retries, triggers, durability or Python
AST compilation were added.
