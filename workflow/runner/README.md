<p align="center">
  <img src="../../apps/web/public/favicon.svg" width="160" height="160" alt="Aixand logo">
</p>

# Aixand Runner

<p align="center">
  <strong>Submit durable workflows. Disconnect. Return to their results.</strong>
</p>

A local Rust service that hosts Aixand IR workflows as durable jobs. Submit a
workflow, disconnect, then inspect its progress and retrieve the result.

See [product installation and shared/private ownership](docs/installation.md)
for qualified artifacts, the Python client, lifecycle, and release boundaries.

Runner uses the existing IR engine. By default one worker executes accepted jobs in
submission order. `serve --workers N` enables 1–64 concurrent workers. Workers claim jobs
in FIFO order; concurrent execution and completion order may differ. SQLite retains requests,
outcomes, and ordered IR events. A
local socket connects the CLI and Python client to the service. Windows uses
a protected loopback endpoint through the platform IPC adapters.

The service reports its worker capacity in `health`. Each active job has its own cancellation
token; cancelling one job leaves other workers running. Graceful shutdown joins cleanup for all
active attempts and retains queued jobs. `Service::open_with_workers` exposes the same pool to
embedders. Native chat workflows declare dependencies for Runner to schedule;
IR applications remain responsible for resource conflicts.

## When to use Runner

Use Runner when workflow submission, scheduling, events, and outcomes must survive
client disconnection. Use [IR directly](../ir/README.md) when your own process can
own a single execution without a durable queue. Use the
[Python client](python/README.md) to control an existing Runner service from code.

Pure verifier workflows need no agent, credentials, or Python SDK. Chat workflows
need a compatible Suite or standalone Orchestration MCP effect host, configured
providers, and the required delivery services. Installing Runner alone does not
supply those integrations.

[Installation](#installation) · [First workflow](#run-the-mvp) ·
[Python](#python-client) · [Outcomes](#outcomes-and-restart-behavior) ·
[Protocol](#local-protocol-and-storage)

## Installation

Use the [standalone Runner installer](https://installer.aixand.org/aixand-suite/runner)
for the published product, or use Runner as part of full Suite or Server.
Follow the [Suite platform requirements](../../README.md#platform-requirements)
for the published payloads. Standalone product installation preserves shared-store
ownership; it does not start a service or install login startup automatically.

For source development, the example below uses Rust 1.95+ and the sibling
`../ir` workspace. [Product installation](docs/installation.md) covers qualified
artifact builds, shared/private prefixes, state homes, and maintenance. Use a
separate explicit home for each service; never point two services at one home.

## Shared workflow graphs

Saved Suite canvases submit `aixand.workflow-graph` version 2 through the ordinary durable job protocol; version 1 remains supported. A graph contains a flat, validated IR `workflow`, a `dependencies` entry for every invocation, and optional saved project/controller `context`. Version 2 also declares `groups` mapping stable canvas node IDs to their operation IDs. Dependencies must cover referenced outputs. Runner executes ready operations concurrently in one owned resource scope; completion joins consume every prerequisite output. Portable documents cannot choose Suite sockets or runtime credentials.

Graph bindings include `workflow.value` (collect/forward JSON), `workflow.text` (render prerequisite evidence), `aixand.project.chat` (a read-only Suite chat with a correlated Carrier report), and `carrier.human.deliver` (human Main inbox delivery). Existing SDK operations compose alongside them. All bindings are preflighted before execution. Owned SDK sessions and send receipts remain live across graph stages and close at the end of the complete graph.

Native chat/helper/verifier graphs checkpoint completed JSON outputs and reconcile running chat identities after restart. SDK session graphs retain IR’s non-replayable opaque-resource policy: a crash retains uncertainty rather than launching duplicate sessions. Graph contract changes have a separate fingerprint. Suite’s socket is selected by host `serve --effect-host`, never by the workflow document. Health advertises `workflow_graphs: [1, 2]`.

`tests/graph.rs` checks sibling overlap, joins, dependency preflight, resource scope ownership, and checkpoint restoration. Suite’s deterministic integration tests exercise mixed IR/native report joins, delivery deduplication, failures and restart recovery without model calls.

## Native chat workflows

Runner accepts `aixand.chat-workflow` versions 1 and 2 through the same durable
submission protocol. They contain saved `project_id`, `origin_chat_id`, `profile`,
optional `model`, 1–16 `steps` (each with `id`, `title`, `instruction`, and
`depends_on`), and a `delivery_step`. Runner validates the DAG, dispatches ready
sibling chats before waiting, checkpoints reports, and starts dependents only
after every prerequisite succeeds and its correlated report is accepted.

Plans and individual steps accept optional `permission_mode` values:
`read-only`, `workspace-write`, `workspace-auto`, or `full-access`. A step's
selection overrides the plan's. Suite resolves its saved spawn default before
submission and writes the resolved mode into every step. Runner validates and
persists these fields and includes them in the Suite start request. Suite maps
`full-access` to `sandbox: danger-full-access` and `approvalPolicy: never`;
Runner does not launch a separate Codex CLI with `--yolo` for native chats.
Permissions stay fixed across retries and restarts. Omitted permission fields use read-only behavior.

Health advertises `chat_permission_modes` with the four supported presets.
Suite checks this capability before submitting a permission-bearing plan,
before admission. An outdated process must be rebuilt
and restarted; replacing its executable on disk does not update the process.
It must reject unsupported handoffs before creating chats rather than silently
falling back to read-only.

Use `serve --effect-host /absolute/native-workflows.sock`. Default:
`SUITE_WORKFLOW_SOCKET`, then `AGENTS_STATE_DIR/native-workflows.sock`, otherwise
the XDG Aixand chat state directory. Suite owns that private effect adapter.
Native execution needs no SDK feature; IR remains available in the same service.

Native jobs resume checkpoints after process restart. Shutdown suspends them
without stopping chats. Explicit cancellation interrupts only owned stages.
Unconfirmed provider launches become `uncertain`; `resume JOB-ID` reconciles
existing identities without blindly resending input. `lookup SUBMISSION-KEY`
finds accepted work without creating a job. Both also exist in the Python client.
`cancel-key SUBMISSION-KEY` cancels accepted work and prevents late acceptance
of an unconfirmed submission. Cancelled keys remain reserved across restarts.
Runner persists reports before acknowledgment and retries lost acknowledgments.
Failed prerequisites block dependents and produce a human inbox failure notice.

An empty or truncated Suite reply is a temporary transport failure. Runner retries
against the same saved job/stage identity, including when a worker started before
its acknowledgment was lost. It does not create replacement chat identities.
Oversized replies fail explicitly with `suite_response_limit`; complete malformed
JSON/envelopes fail with `suite_protocol`. Payload-free transport diagnostics record
the RPC operation, received byte count and newline status in Runner's stderr log.
The response limit remains 4 MiB. These transport changes preserve existing job
fingerprints and checkpoints.


See [Suite configuration and recovery](../../apps/server/docs/native-workflows.md).
Existing IR jobs retain their original fingerprints and recovery semantics.
SQLite schema version 4 adds execution revisions, operation admission, adoption requests and durable continuations to the existing checkpoints and cancelled submission keys. Complete integration coverage
is in Suite's `test_native_workflows.py`.

## Editing and chaining runs

Version 2 graph and native plans can change while queued or running. `plan JOB-ID`
returns the effective workflow, revision, held flag, admission phase and locked
groups. The original submission and its idempotency digest never change. Submit
a complete candidate with `amend JOB-ID revised-workflow.json --key EDIT-KEY
--revision N`, optionally `--authoring canvas.json`. The transaction compares the
expected revision and freezes every operation in a group when its first operation
is claimed. Pending groups may be added, removed, edited or rewired; started
definitions, dependencies, permissions and group membership cannot change.
Removed operation IDs cannot be reused. Project/controller context, workflow name
and input declarations remain pinned. Retry the exact request/key after a lost
response. Revision conflicts require fetching the current plan and a new edit key.

`hold JOB-ID` pauses admission of new work. Existing operations keep running or
reconciling after restart. `release JOB-ID` admits pending work again. Holding also
keeps a finished body open for append until released. Final delivery seals the
plan before its effect starts, and finalization races atomically with amendment.
Once finalizing or settled, use a separate continuation.

`enable-edits JOB-ID --key ENABLE-KEY` explicitly adopts a queued graph or
native plan into version 2. Resumable active graphs/native plans suspend their
Runner attempt, preserve existing chats and exact requests, then resume with new
admission held. Suite supplies authoring groups and operation aliases for old
positional canvas IDs. Release after editing. Legacy graphs that have already
started non-replayable SDK scopes cannot adopt; existing uncertainty must be
reconciled first. Standalone IR remains immutable.

`continue JOB-ID child-submission.json --key LINK-KEY --input-map mapping.json`
registers a durable child template before or after successful parent completion.
The target is a normal submission, validated without running it. An input mapping
such as `{"previous_result":"/result"}` selects a complete JSON export from the
parent result, without UI truncation. Native version 2 plans declare JSON `inputs`
and stage `input_names`; graphs reference their normal IR inputs. Native v2 results
export the final stage report as `result`. The canvas compiler exports the actual
pre-delivery result under that name. Empty pointer `""` selects the whole result;
nonempty pointers must begin with a declared export. Opaque session handles cannot
cross job boundaries.

Completion and continuation readiness commit together. A dispatcher preflights
the concrete inputs and commits child acceptance and parent/child linkage in one
transaction, then the normal worker pool runs the child. Retry keys deduplicate
lost responses and restarts. Parent failure/cancellation skips waiting children;
validation or environment errors can block a link. `continuations JOB-ID` lists
links and `cancel-continuation LINK-ID` cancels an unsubmitted link. Submitted
children have their own cancellation. `runs` exposes sanitized Suite history with
parent links and current plans. Python `Client` exposes these same operations.

Health advertises `workflow_amendments: [2]`, `workflow_continuations: [1]` and
`workflow_edits_adoption: [1]`. Rebuild and restart Runner and Suite to activate
the new capabilities. This change does not add review loops or iteration limits.

## Run the MVP

This source example uses a Unix shell, Rust 1.95+, and the `../ir` checkout.
The native product also has platform-specific IPC support, including Windows.
The included verifier example needs no Python SDKs, agent, credentials, or
Undercurrent installation. Build from this directory:

```sh
cargo build --locked
./target/debug/runner --home .runner serve
```

In another terminal, from this directory:

```sh
./target/debug/runner --home .runner health
./target/debug/runner --home .runner submit examples/verify.json \
  --inputs examples/inputs.json --key verifier-demo
./target/debug/runner --home .runner list
```

Use the returned job ID:

```sh
./target/debug/runner --home .runner inspect JOB-ID
./target/debug/runner --home .runner events JOB-ID --follow
./target/debug/runner --home .runner result JOB-ID
./target/debug/runner --home .runner cancel JOB-ID
```

Commands return JSON; `events` returns one JSON event per line. `inspect` includes
the submitted workflow and inputs. `result` returns state, outputs, and failure
details. A successful request exits zero; a protocol, validation, or lookup error
exits nonzero. A job's application result is inspected through its returned data,
not the CLI exit code.

Repeat a submission with the same key to recover a lost response. The same
workflow, inputs, and metadata return the original job. Different content under
the same key is a conflict. Keys are unique within one Runner home; callers can
prefix them with their application name.

`--home` selects an isolated service and database. Its default is `RUNNER_HOME`,
then `$XDG_STATE_HOME/runner`, then `~/.local/state/runner`. An exclusive file lock
permits one service owner per home. Newly created state directories are private;
the socket allows access only to the owning OS user. Clients do not open SQLite.

### Verify and finish the example

For the supplied inputs, expect a completed job whose exported verifier result
has `passed: true`. Inspect the actual `result`, not only a successful submit
response. The verifier checks document content; it does not launch an agent.
After a client disconnect, reconnect with the same home and inspect the same job.

When finished, press Ctrl+C in the foreground service terminal. Retain `.runner`
if you want its job history. Delete it only if it is the disposable home created
for this example and the service has stopped. Submission keys remain reserved in
that home, so use the same key for an exact retry and a new key for changed work.

## Run under Undercurrent

With an installed, configured Undercurrent, run from this directory:

```sh
uc start runner --stop-timeout 20s -- "$(pwd)/target/debug/runner" --home "$(pwd)/.runner" serve
uc inspect runner
```

Clients use the same `--home` as before. Undercurrent owns the service process;
Runner owns the job queue. The stop timeout allows Runner's shutdown and cleanup
to finish. The service also works in a foreground terminal.

SIGINT/SIGTERM stops new execution and requests cancellation of the active job.
Runner allows up to ten seconds for that execution and its cleanup to return.
Unfinished cleanup leaves the job uncertain. Pending jobs remain queued for the
next service start. This does not install an automatic process-restart policy.

## Python client

The client uses the shared local-runtime IPC library, without agent or IR
dependencies. With Python 3.11+, install the published client using
`python -m pip install aixand-suite-runner-client`. For source development from
this directory, install `python -m pip install ./python`, or use the checkout
with its declared dependencies installed:

```sh
PYTHONPATH=python python examples/submit.py --home .runner
```

```python
import json
from pathlib import Path
from runner_client import Client

client = Client(".runner")
accepted = client.submit(
    json.loads(Path("examples/verify.json").read_text()),
    {"title": "Design", "body": "A workflow invokes operations."},
    key="my-app:verify-1",
)
job_id = accepted["job"]["id"]
for event in client.follow(job_id):
    print(event)
print(client.result(job_id))
```

The client also exposes `health`, `list`, `inspect`, `events`, and `cancel`.
`RunnerError` contains a structured `code` and optional diagnostic `details`.
After a submission timeout, retry with the original key: it may already be stored.

## Operations and validation

The default binary includes the existing `verifier.verify@1.0.0` operation.
Application bindings remain installed code; job JSON cannot select arbitrary
modules or executables to load.

Before queueing, Runner uses IR's parser and `Runner::preflight_json` to check the
workflow, inputs, operation contracts, executable bindings, and JSON-only external
interface. The execution engine repeats its checks before invoking operations.
The preflight method is a small addition to the sibling IR runner; its execution
path and preflight share the same preparation implementation.

For application-specific operations, embed the `job_runner` library and construct
`IrEngine::with_bindings(catalogs, bindings, binding_version)`. Supply a new binding
version when executable behavior changes. `Service::open` and `Service::serve`
provide the same store, queue, and socket protocol to that host.

### Optional Aixand SDK operations

```sh
cargo build --locked --features sdk
./target/debug/runner --home .runner serve --sdk-config /absolute/path/sdk.json
```

This enables the existing Aixand IR SDK binding, which embeds Python. Install
the sibling SDKs and configure Agent Manager, Carrier, and Undercurrent according
to the [IR SDK integration guide](../ir/README.md#existing-sdk-integration).
For example, the host-owned configuration can contain:

```json
{
  "python_paths": ["/absolute/path/to/venv/lib/python3.14/site-packages"],
  "connection": {"state_dir": "/absolute/path/to/aixand-state"}
}
```

Use paths matching the embedded Python installation. Runtime credentials and
connection settings stay in host configuration. SDK installation during preflight
imports and checks the binding environment without launching an agent. Each
execution owns a fresh IR scope with `StopOwned` cleanup. Host configuration and
operation contracts contribute to the engine fingerprint pinned on submission.
Queued jobs become blocked if that fingerprint changes after a restart.

Put the configured SDK virtual environment's `bin` directory on `PATH` when
starting the service, so Agent Manager's child Python workers can import the same
SDKs. Successful agent spawn/get operations also retain an `ir` event with
`event: "agent_session"`, its invocation ID, provider, managed `run_id`, and
Undercurrent `session_id`. Hosts can use this exact identity to preview a terminal
while a job is active and recover the association from retained events later.
The event contains no credentials or opaque capability handles and does not
change the portable workflow contract or completion semantics.

SDK builds are tested with deterministic workflows without launching live agents.
Provider availability and live workflow behavior require the configured runtime.

## Outcomes and restart behavior

| State | Meaning |
| --- | --- |
| `queued` | Accepted and waiting for the worker |
| `running` | An attempt was durably claimed; its IR execution is active |
| `completed` | The workflow returned outputs and scope cleanup succeeded |
| `failed` | The IR execution returned an error; effects are not presumed absent |
| `cancelled` | Removed from the queue, or IR returned cancellation and cleanup succeeded |
| `blocked` | The pinned engine configuration/contracts no longer match |
| `uncertain` | Service interruption, panic, event-journal failure, or unconfirmed cleanup |

A completed workflow can return `passed: false`. Runner reports execution facts;
the caller decides whether those facts satisfy its product requirements.

Cancellation is cooperative. A cancellation request is recorded separately from
the outcome. It does not roll back effects or establish that every remote effect
has stopped. A result that wins the race with cancellation may remain completed.

On startup, previously running attempts become uncertain. Queued jobs remain
queued and completed results remain available. Repeating the original submission
returns that same uncertain job; it never launches a replacement. Existing agents
or external effects may still exist and must be inspected through their owning
systems before the caller submits reviewed follow-up work under a new key.

Standalone IR and opaque SDK execution have no automatic retry, step resumption, compensation, or generic
`reconcile` command. It retains the original workflow, attempt ID, diagnostics,
and IR invocation events for inspection. Event publication does not constitute a
checkpoint of live SDK handles. Serialization applies to workflow invocations;
it does not enforce isolation between effects left by different jobs.

## Local protocol and storage

Each Unix socket connection carries one UTF-8, newline-terminated JSON request
and response. Protocol version 1 is reported by `health`. Requests are strictly
parsed, including duplicate-key rejection. Responses are:

```json
{"ok": true, "data": {}}
```

or `{"ok": false, "error": {"code": "...", "message": "...", "details": {}}}`.

Operations: `health`; `submit` with a `submission` object; `inspect`, `result`,
`cancel` and native `resume` with `id`; `lookup` with a submission `key`;
`list` with `after` and `limit`; and `events` with `id`,
`after`, and `limit`. A submission contains `key`, `workflow`, `inputs`, and
optional `metadata`. `list.after` is a job sequence; `events.after` is an event
sequence. Events return `next_after`, `has_more`, and the state observed with the
page. Limits are 1–500 rows, default 100. Follow clients drain pages before waiting.

Requests are limited to 4 MiB, workflow outputs to 8 MiB, and responses to 16 MiB.
Use references for large artifacts. Events may be paginated by bytes before the
requested row limit. Timestamps are Unix milliseconds. Caller inputs are retained
in full; secret-bearing runtime configuration belongs outside submissions.

The state directory contains `jobs.sqlite3` and its WAL files, `service.lock`, and
`runner.sock`. SQLite transactions make job transitions and their corresponding
events atomic. The SQLite schema is versioned. Back up the stopped service's
directory or use SQLite's backup facilities. The MVP has no retention cleanup.

## Development

```sh
cargo fmt --all -- --check
cargo test --locked
cargo test --locked --features sdk
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path ../ir/Cargo.toml -p aixand-ir-runner
```

Tests cover submission races, invalid workflows and missing bindings, single-worker
execution, queued and active cancellation, cleanup uncertainty, queued persistence,
configuration drift, event pagination, exclusive ownership, strict socket parsing,
a real killed-and-restarted service, and the CLI/Python client against a real socket.

See [IR design decisions](../ir/docs/decisions.md) for execution-model rationale.

For a trusted application that needs a supervision loop, SDK hosts can configure
`applications` as a mapping from a versioned application name to an installed Python
`module:function` async entrypoint. Invoke it through `aixand.application.run@1.0.0` with
`name` and JSON `arguments`; it returns JSON `result` and shares the job's SDK scope.
The portable workflow cannot select code to import. See the
[IR application contract](../ir/README.md#host-installed-sdk-applications).
Configuration changes affect the pinned engine fingerprint; upgrade an owned service only
when there are no queued/running jobs. Application authors must handle cancellation and
uncertain effects, and version their entrypoint names when behavior changes incompatibly.

## Agent context

Submissions can carry `metadata.agent_context` with optional `labels` and
`metadata` string maps. Runner forwards only this declared context into SDK and
native workflow execution, then adds `orchestrator=runner` and `runner.job_id`.
It preserves the caller's application, project and workflow identity; standalone
SDK jobs default to `app=runner`. SDK spawn/application invocations receive
`workflow.step_id` from the IR invocation ID. Native steps receive their task ID.
Arbitrary job metadata is never copied into agent metadata. Context is included
in the normal submission digest, so changed context conflicts on a reused key.

```json
{"metadata":{"agent_context":{"labels":{"app":"pathspec","workflow.run_id":"run-42"},"metadata":{"inputs.path":"/work/inputs.json"}}}}
```

Attribute validation follows Agent Manager's bounds (64 entries per map, 64-byte
keys, 256-byte label values, 4096-byte metadata values, no control characters or
reserved `agent_manager.*` keys).

## Effect hosts and resource capture

`runner serve --effect-host /absolute/native-workflows.sock` selects a compatible
host such as standalone Orchestration MCP or Aixand Suite. `--suite-socket` is a
compatibility alias; existing wire operation identities and default socket
resolution are unchanged. A host provides chat effects and Carrier delivery.
Runner owns durable dependency scheduling and imports the versioned IR crates
directly. The optional `sdk` feature retains its existing SDK bindings.

Native plans accept optional `resource_capture: "stage" | "workflow"`; graph
context accepts `resourceCapture`. Omission retains the default capture behavior. A host must resolve every chat policy to explicit stores and immutable
resource requests before submitting workflow capture. Runner validates these
requests and advertises `resource_capture_policies` in health. It does not import
Python resource managers or re-resolve user selections. Auto account selection
still belongs to the effect host at stage launch.

The IR distribution script can build a checksum-verified combined source artifact
that relocates Runner’s development path dependencies to a bundled IR workspace.
See the IR workspace’s `docs/distribution.md`; the artifact builds without a Suite
checkout. Package registry publishing is separate from building local artifacts.

## Documentation

| Task | Guide |
| --- | --- |
| Install and maintain the native product | [Product installation](docs/installation.md) |
| Control jobs from Python | [Runner client](python/README.md) · [Runnable example](examples/submit.py) |
| Understand portable workflow contracts | [IR](../ir/README.md) |
| Integrate Suite chat workflows | [Native workflow integration](../../apps/server/docs/native-workflows.md) |
| Use an independent effect host | [Orchestration MCP](../../mcps/orchestration/README.md) |

[Suite](../../README.md) · [Support](../../SUPPORT.md) · [License](../../LICENSE)
