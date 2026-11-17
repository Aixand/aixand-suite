<p align="center">
  <img src="../../apps/web/public/favicon.svg" width="160" height="160" alt="Aixand logo">
</p>

# Aixand Python

<p align="center">
  <strong>Compose agent sessions, durable messages, and runtime handles from Python.</strong>
</p>

The ergonomic composition SDK for Aixand primitives. Install `aixand-suite-python`;
import `aixand`. Agent Manager, Carrier, and Undercurrent remain independently
usable SDKs. This package provides agent handles, shared connections, managed
Carrier inbox delivery, and resource cleanup. It does not implement a workflow
engine, task-success inference, or Python-to-IR compilation.

| Primitive | Boundary |
| --- | --- |
| Agent Manager | Agent lifecycle: profiles, authentication, budget information, and launch preparation. |
| Carrier | Messaging: identities, durable inboxes, messages, replies, and acknowledgments. |
| Undercurrent | Runtime/session control: process execution and lifecycle, input/output, observations, and stable-state waiting. |
| Aixand Python | Composition: convenient handles, shared configuration, delivery consumers, and resource management. |

## When to use this SDK

Use this package when your Python application needs to combine native agent
execution with Carrier messaging and explicit resource ownership. You do not
need the Suite desktop application to consume the SDK.

For durable queued workflows, use [Runner](../../workflow/runner/README.md) and
its [Python client](../../workflow/runner/python/README.md). For portable operation
definitions and Rust execution, use [IR](../../workflow/ir/README.md). This package
is neither the Runner client nor a Python binding to IR.

[Installation](#installation) · [First agent](#canonical-api-no-required-application-object) ·
[Scopes](#optional-connection-scope) · [Messaging](#carrier-bound-agents) ·
[Examples](#runnable-examples) · [Verification](#validation)

## Installation

In your application's Python 3.11+ virtual environment, run:

```sh
python -m pip install aixand-suite-python
```

Import it as `aixand`. Python dependency installation does not install provider
executables, authenticate accounts, or start the native Undercurrent service.
Prepare those independently before running an agent example. Carrier is needed
for messaging; plain agents without `address=` do not contact it.

## Install from this workspace

Requires Python 3.11+ and compatible published Agent Manager, Carrier and
Undercurrent Python packages. Distribution names are `aixand-agent-manager`,
`aixand-carrier-mcp` and `aixand-undercurrent-sdk`; their Python import names remain
`agent_manager`, `carrier` and `undercurrent`.

From the Suite root, run `./dev.sh prepare`, then use `.venv/bin/python` (Windows:
`.venv/Scripts/python.exe`). For SDK-only development, run `uv sync --locked` in
this directory. External packages resolve from the package index by default.

Use the compatible independently installed Undercurrent daemon and bridge.
Set `UNDERCURRENT_PYTHON_BRIDGE` and `UNDERCURRENT_HOME` to select another
installation. Aixand does not automatically start an Undercurrent daemon.

Prepare and authenticate a native environment/profile through your installed
Agent Manager, or use an existing one. The example below assumes an authenticated
profile named `research`. Use your actual profile name, or `profile=None` for
Agent Manager's automatic selection. Suite users can follow
[native onboarding](../../docs/getting-started/first-workspace.md); SDK-only users should use their
installed Agent Manager's help and profile/login interfaces. There is no separate
saved-login library to create for this SDK.

The existing `AGENT_MANAGER_CONFIG` and `AGENT_MANAGER_HOME` settings are honored.
Update your separately installed `agent` CLI from the Agent Manager repository
before mixing CLI and SDK launches against the same registry.

## Canonical API: no required application object

```python
import asyncio
import aixand

async def main():
    try:
        agent = await aixand.agents.spawn(
            provider="codex", profile="research", cwd=".",
        )
        receipt = await agent.send("Research this project without changing files.")
        await agent.wait(stable_for=2, timeout=300)

        await agent.send("Now summarize your findings.")
        await agent.wait()
        print((await agent.read_screen()).decode(errors="replace"))
    finally:
        await aixand.close(stop_agents=True)

asyncio.run(main())
```

`provider="codex"` identifies the agent provider. Undercurrent is the process
runtime. `profile=None` delegates automatic budget-based selection to Agent
Manager; otherwise the named managed profile is used.

- `send(text)` waits for stable input readiness, submits through Undercurrent,
  remembers the foreground revision, and returns the original `InputReceipt`.
  It does not wait for the requested work to finish.
- `wait()` uses the latest successful direct `send()` revision and waits for running,
  available, unconstrained runtime state to remain stable (default two seconds).
  Carrier inbox deliveries do not replace that default receipt. Before the first
  direct send it waits for current readiness. Input admission separately tracks
  the latest delivery of either kind so the next turn uses a current revision.
- `wait(after=receipt)` pins an explicit delivery, useful with concurrent code.
  `wait(after=None)` observes current readiness without a revision boundary.
- `wait()` means runtime readiness, **not task success or a verified result**.
  Use an explicit Carrier response for application completion. Screen output is
  diagnostic terminal content, not a structured Carrier reply.
- `stop()` cancels pending sends and the inbox consumer, then stops the session;
  it does not wait for a busy agent to become ready. The connection stays open.
  `inspect()` and
  `read_screen()` expose the underlying runtime observations.
- `agents.get(run_id, provider=...)` attaches a runtime handle. Repeated calls
  within one connection return the same handle and share its input lock.
  `agents.profiles()` and `agents.budgets()` delegate to Agent Manager.

Concurrent sends through one handle are serialized, including Carrier deliveries.
Independent connections and external `uc send` callers do not share that lock;
Undercurrent revision preconditions still apply. No failed input is automatically
retried. Uncertain writes block subsequent sends on that handle until inspected.
An explicit receipt from another session is rejected by `wait()`.

## Verify the first agent

Run the example from a disposable project directory after preparing its profile
and starting the selected Undercurrent daemon. It can consume provider quota and
may require native approvals. Expect diagnostic screen output and explicit owned
agent cleanup in `finally`.

`send()` returning means input was submitted; `wait()` returning means runtime
readiness. Neither proves the requested research succeeded. For a structured
completion check, use the [team example](#runnable-examples), which waits for an
explicit Carrier reply. On failure, inspect the original run/session and delivery
receipts before starting another agent. Preserve uncertain identities.

## Optional connection scope

```python
async with aixand.connect(
    runtime_home="~/.aixand/undercurrent",
    stable_for=2,
    timeout=300,
    stop_on_exit=True,
) as connection:
    agent = await aixand.agents.spawn(
        provider="codex", profile="research", connection=connection,
    )
    await agent.send("Research this project.")
    await agent.wait()
```

The module-level API stays canonical. `connect()` creates a scope; it does not
change an ambient default. Pass `connection=` to use it. Omitted connections use
a lazily created default scoped to the current event loop. Explicit connections
cannot cross event loops. Call `await aixand.close()` before the default loop
exits. No network connection or process is started at import time.

Connection options include `runtime_home`, `bridge`, `manager_config`,
`manager_home`, `state_dir`, `stable_for`, `timeout`, `carrier`, and `stop_on_exit`.
An existing `undercurrent.Client` can be borrowed with `runtime=`; Aixand never
closes a borrowed runtime. `connection.directory` contains a private run manifest,
credential files and delivery journals. Credential tokens are not in the manifest.

Closing detaches by default: it closes SDK connections and managed consumers,
while agent processes remain running. `stop_on_exit=True` or
`close(stop_agents=True)` stops only agents spawned by this scope, not attached
agents. Call `agent.stop()` to explicitly stop an attached agent.

## Carrier-bound agents

`address=` provisions a Carrier identity, configures MCP before launch, initializes
the conversation protocol, and starts a consumer bound to the runtime session.
The identity belongs to that conversation, even when multiple agents use the same
Agent Manager profile. Existing addresses are never silently reused for a new
conversation. The built-in MCP launch adapter supports Codex; another provider
can supply `mcp_arguments(url, credentials_path)` returning its launch arguments.

```python
async with aixand.connect(
    carrier=aixand.CarrierConfig.private(), stop_on_exit=True,
) as connection:
    brain = await aixand.agents.spawn(
        provider="codex", profile="backup", address="brain",
        instructions="Advise Implementer. Reply through Carrier. Do not edit files.",
        connection=connection,
    )
    implementer = await aixand.agents.spawn(
        provider="codex", profile="backup", address="implementer",
        instructions="Consult brain when needed. Do not edit files.",
        connection=connection,
    )
    await implementer.send("Review this project and ask brain about one tradeoff.")
    await implementer.wait()
    # Runtime readiness may mean Implementer is waiting for Brain. Keep this scope
    # alive until your application protocol's completion condition is satisfied.
```

The runnable team example below demonstrates an explicit final response and waits
for it before closing the scope.

Carrier consumers and direct sends share the agent's input lock. For incoming
Carrier messages, the consumer records a durable delivery intent, writes input,
waits for an authenticated acceptance receipt from the agent, acknowledges the
original message, then waits for stable readiness before accepting another turn.
The receipt is sent to a separate private mailbox and proves acceptance only.
Agents receive instructions to use Carrier MCP `send`; Python owns receiving and
acknowledgment. Agents themselves choose and send their substantive answers.

`send()` to a Carrier-bound agent still returns the terminal receipt promptly;
acceptance is checked before the next input. Bootstrap setup additionally waits
for acceptance before exposing the inbox consumer. The package never synthesizes
an answer from terminal output.

### Services and ordinary consumers

The default configuration uses the external Carrier service at
`http://127.0.0.1:8765` and its default local database. Start that service yourself:

```sh
carrier serve
```

For another local service, use
`CarrierConfig(url="http://127.0.0.1:9000", database="/path/to/carrier.db")`.
Provisioning calls Carrier's public administrative CLI, so that database must be
the database served by the URL. For a remote service, supply already provisioned
`credentials=` to `messaging.mailbox`; agent spawning additionally needs a distinct
`receipt_credentials=` file. These must be fresh identities for this conversation.

`CarrierConfig.private()` lazily starts an isolated loopback Carrier service for
the connection. It is useful for examples and tests. Closing stops that owned
service. An external service is never stopped by Aixand. Carrier is not contacted
at all when only using agents without `address=`.

Ordinary application mailboxes are native Carrier clients:

```python
mailbox = await aixand.messaging.mailbox("processor", connection=connection)

@mailbox.consumer()
async def process(message):
    await message.reply(message.content.upper())
    await message.ack()

await mailbox.run()  # Your application owns this foreground consumer's lifetime.
```

A coordinator is just another application mailbox. It is optional and useful
when Python needs to assign work and collect explicit final results.

### Errors, ownership, and recovery limits

Managed consumer failures are reported through the event loop's exception handler,
stored in `connection.errors` and the manifest, and raised by subsequent managed
operations and scope exit. Use this to interrupt a pending application wait:

```python
answer = await connection.wait_for(
    coordinator.wait_for_reply(job, timeout=600),
)
```

The scope cancels and joins that wait when a managed consumer fails. It never
silently continues with a dead inbox. Stopping/exiting the agent also ends its
consumer. Connection cleanup cancels and joins consumers before closing clients.

`AgentSetupError.agent` exposes a launched handle if bootstrap fails. An uncertain
Agent Manager launch preserves its original `LaunchError.run_id`; inspect/reconcile
that run rather than spawning a replacement blindly. Journals retain uncertain
delivery records without replaying them. They are diagnostic/recovery evidence,
not an exactly-once execution guarantee.

In v0.1 consumers live in the Python process. After it exits, messages remain
durable in an external Carrier service, but delivery into terminals stops. A
private service also stops on normal scope close. Reconstructing a Carrier binding
across process restarts is explicit: use `agents.restore()` with the original
manifest and matching settings. `agents.get()` restores only the runtime handle.
Keep the scope alive for ongoing agent communication. Do not use the same
identity with another reader or conversation, and do not fork/resume a bound
conversation under its original credentials.

## Runnable examples

```sh
python examples/research.py --profile backup --cwd ../../../manager-suites/agent-manager
python examples/team.py --profile backup --cwd ../../../manager-suites/agent-manager
```

Both use the installed SDKs and real agents. The team example starts its own Carrier
service, runs Brain/Implementer, collects a final reply, saves it and cleans up its
agents. The default task is read-only. Trust/tool approvals can be handled with
`uc attach` if your profile requests them.

## Validation

```sh
python -m unittest discover -s tests -v
UC_TEST_BIN="$(cd ../../../undercurrent/target/debug && pwd)" \
  python -m unittest discover -s tests -p test_integration.py -v
```

Unit tests exercise concurrency, cancellation, receipt semantics, ownership, and
consumer failure propagation. The opt-in integration test runs real Carrier and
Undercurrent services plus real MCP clients against deterministic fake providers;
it uses isolated homes and no live credentials. The runnable examples are the live
provider validation path.

The integration suite also checks Carrier-free spawning, detach versus stop,
service-failure propagation, and fresh bridge processes across two separate
`asyncio.run()` calls. Each invocation explicitly closes its default connection
before exiting, as required by the resource-management contract above.

## Restore a live Carrier binding

`await aixand.agents.restore(run_id, manifest=original_manifest, connection=scope)`
reattaches delivery to the original still-running conversation using a persistent
external Carrier service. Use the original runtime, manager and Carrier settings.
The API verifies the managed identity, original process start time and journal,
acquires its exclusive lock and restores saved input receipts.
Ambiguous input or a `submitting` journal
entry blocks recovery without replaying terminal input. It never launches, resumes
or forks an agent. `agent.consumer_active` reports whether delivery is active.

## Inherited agent context

```python
async with aixand.connect(labels={"app": "project-x"}, metadata={"inputs.path": "/work/inputs.json"}) as connection:
    workflow = connection.with_context(labels={"workflow.run_id": "run-42"})
    agent = await aixand.agents.spawn(connection=workflow, labels={"role": "reviewer"})
    print(agent.labels)
    private = await agent.metadata()
```

Connection views share their owner's runtime, agent registry, Carrier resources
and shutdown behavior. Closing a view does not close the owner. Defaults merge
through Agent Manager; launch overrides win. `with_context` and `agents.spawn`
accept independent `inherit_labels=False` and `inherit_metadata=False` options.
Both maps are validated string maps under the [Agent Manager context contract](https://github.com/Aixand/manager-suite/blob/main/agent-manager/docs/python-sdk.md#labels-and-private-metadata).
Metadata is read explicitly and is omitted from agent handles and list views.

[Suite](../../README.md) · [Runner client](../../workflow/runner/python/README.md) · [Support](../../SUPPORT.md) · [License](../../LICENSE)
