# Aixand server

[Desktop and terminal-only Server installation](docs/installation.md) uses the
same distributed product installation engine. The Server package has terminal
setup and maintenance, APIs and WebSockets, with no frontend or Tauri runtime.
Production `AIXAND_PRODUCTION_MODE=headless` starts without web assets; `web`
retains combined browser hosting.

[Production deployment](docs/production.md) serves the built frontend and APIs
together on port **8753**, including browser and connected Tauri desktop access.
Build with `node scripts/production.mjs build` from `aixand-suite`, then start
the managed production Suite with `./dev.sh serve --production`.

[Chat supervision](docs/command.md) adds persistent autonomous monitors for chats,
inboxes, timers, and workflows. Supervising chats show a badge with their brief,
activity, and controls. Each monitor retains its mandate and memory across browser
closure and backend restarts, using the shared Orchestration MCP services.

[Aixand Connect](docs/connect.md) adds device pairing and verified file transfers
from native project chats over NetBird. Configure it under **Settings → Devices**.

NestJS backend for Aixand with WebSocket terminal and workflow gateways. Uses
TypeScript, Express, and existing Rust SDK/IR APIs through private bridges.
Requires Node.js 24 (24.15+), npm, and Rust 1.95+ for the bridge. The current
Undercurrent runtime target is Linux.

[Native chat workflows](docs/native-workflows.md) use Runner for dependencies and
recovery, Suite for native chat effects, and Carrier for stage submissions and the
human Main inbox. The audit template runs architecture/security audits in parallel,
joins their reports into task planning, and delivers the final task list.

## Run locally

```sh
npm ci
npm run bridge:build
cp -n .env.example .env
npm run start:dev
```

First startup prepares authentication automatically. Open the frontend on loopback
and create and confirm your Suite password. Setup signs you in immediately and
opens Agents → Providers. One browser session authorizes Terminals, Agents, chats, workflows,
and Carrier. The password grants access as the daemon's OS user; there is no
per-user or per-session account authorization.

See [password setup, deployment, upgrades, and host-only recovery](docs/authentication.md).

See [MCP setup and Suite integration](docs/mcp.md) for shared profile attachments,
Sonar/Lore project preparation, per-launch selection, and workflow contracts.

## Memory usage

Linux measurements on **2026-10-13**, using local CPU speech models:

| Workload | Observed RAM |
| --- | --- |
| Vox worker during ten sequential browser calls | ~882 MiB peak RSS |
| App services plus one Chromium tab in the same test | ~1,529 MiB (~1.49 GiB) combined PSS |

Vox reuses Whisper and Kokoro engines across calls and releases each call's audio
pipeline. Its cached engines stay loaded until the worker exits. The earlier
four-call browser test reached about **2.4 GiB RSS for Vox alone**.

The combined figure includes Nest, Vox, Undercurrent, Agent Manager supervisors,
the chat/Carrier bridges, the browser, a static Vite preview, and an offline
agent-protocol fixture. It excludes the OS, build/test tooling, real agent-provider
processes, development watchers, and additional workloads. RSS counts resident
process pages; PSS apportions shared pages to avoid counting them repeatedly.

**4 GB is the full Suite target, not a verified minimum requirement.** One Vox
call and several active agent chats, including the OS and browser on the same
machine, still need validation on a 4 GB host. See
[Vox's memory breakdown and regression check](../aixand-vox/README.md#ram-and-vram-usage)
and [RAM per profile and loaded chat](docs/chat-memory.md) for measurement scope.

## Configuration

The server defaults to `http://127.0.0.1:3000`. Process environment variables
have precedence over `.env`.

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | HTTP/WebSocket bind address and port |
| `CORS_ORIGINS` | Exact browser origin allowlist for HTTP and WebSocket connections |
| `AIXAND_AUTH_DATABASE` | Private password/session database; initialized automatically on first startup |
| `AIXAND_AUTH_DEV_HTTP` | Set to `1` only for loopback HTTP development |
| `AIXAND_TRUST_PROXY` | Exact trusted HTTPS reverse proxy peer IP addresses |
| `UNDERCURRENT_HOME` | Existing daemon home; defaults to `~/.aixand/undercurrent` |
| `TERMINAL_BRIDGE_PATH` | Bridge executable; defaults to `bridge/target/debug/aixand-terminal-bridge`, relative to server working directory |
| `TERMINAL_SHELL` | Program for new shells; defaults to `/bin/bash`, invoked with `-i` |
| `TERMINAL_CWD` | Initial working directory for new shells; defaults to the server user's home |

Run the bridge under the same OS user and on the same machine as Undercurrent.
The SDK performs the daemon's local IPC identity checks. Existing session input
and resize affect other clients attached to that session too.

`GET /api/health` returns `{ "status": "ok", "service": "aixand-server" }`.
It reports server liveness, not Undercurrent readiness. Terminal connection errors
are reported on the WebSocket and shown on the page.

## Architecture

```text
aixand-web / xterm.js
    ↕ WebSocket /api/terminals/ws
aixand-server / NestJS (origin + session checks)
    ↕ private child-process stdin/stdout
Rust bridge / public Undercurrent SDK
    ↕ authenticated local IPC
Undercurrent daemon / PTY sessions
```

Each authenticated browser connection owns one bridge process, one shared SDK
connection, and up to sixteen independent terminal output subscriptions keyed
by pane ID. Attaching or detaching one pane leaves other streams intact. Session lists
are paginated. New shells run under Undercurrent and survive browser disconnects.
Closing the browser stops the bridge, not the shell. Use `exit` in the shell or
`uc stop <name>` to stop a session.

The gateway validates session listing/creation, attachment, input, resize,
inspection, event subscriptions, output acknowledgement, and explicit group
operations (list, create, assign/move/remove membership, delete, reconcile, restore). Input is ordered and delivered as raw bytes. Output
uses bounded base64-encoded byte chunks; the bridge waits for acknowledgement
from each pane's xterm write callback before consuming its next chunk. Requests, frames,
queues, and concurrent browser connections are bounded. No commands or terminal
contents are logged by the gateway.

Reconnect resumes from the last parsed output byte offset while the page remains
open. A page reload or session switch rebuilds from retained output starting at
zero. Missing history is explicit: the user can restore the current screen, with
a warning that earlier scrollback and some terminal mode state are unavailable.
Mutations with uncertain delivery are never retried automatically. Input queued
in the browser is discarded when detaching or losing the connection.

The terminal options menu exposes `clean` with explicit confirmation. It uses
the same `FiniteCliExecutor::clean_selected` operation as `uc clean -y`, selecting
all stopped, exited, and failed sessions regardless of the browser's current
filter. Running sessions and saved group restoration slots remain available.
The response reports successful removals and per-session failures; the browser
reconciles its catalog after either success or an uncertain outcome.

## Build and checks

```sh
npm run lint
npm test
npm run test:e2e
npm run build
npm run bridge:build
cargo clippy --locked --manifest-path bridge/Cargo.toml -- -D warnings
npm run start:prod
```

For a release bridge, run `npm run bridge:release` and set `TERMINAL_BRIDGE_PATH`
to the absolute release executable path. The bridge's Cargo manifest currently
uses the `../../undercurrent` checkout for the public SDK/protocol and
`undercurrent-cli::GroupClient` library API. The headless group API reuses the CLI's
registry locks, endpoint scoping, creation receipts, and restoration service;
it never launches an interactive `uc group attach` view. The bridge resolves the
same configuration/endpoint as the CLI. No daemon database access is introduced.

Group reads do not start or restore processes. Membership moves use an expected
source group and one locked update, preserving saved restoration recipes. A saved
shell cannot move into a non-persistent group. Deleting a group only forgets
metadata; the browser has no group-stop/delete-and-stop operation. Group-created
shells use saved defaults; `TERMINAL_CWD` and `TERMINAL_SHELL` supply defaults when
creating an empty group or an ungrouped shell. Changes made by `uc group` become
visible during the browser's five-second catalog refresh.

The real-browser integration check lives in `aixand-web`:

```sh
cd ../aixand-web
npm run test:terminals
```

It requires `uc`, `uc-daemon`, and `uc-session-host` in the sibling Undercurrent
`target/debug` directory (or set `UNDERCURRENT_BIN_DIR`). It creates a disposable
daemon home and tests real shell input/output, Unicode paste, Ctrl-C, resize,
detach/resume, exit, shared CLI/browser groups, atomic membership moves, saved
terminal restoration, and deletion without process termination. It stops its own
sessions and services afterwards.

For deployment, serve the frontend and `/api` on the same origin using a reverse
proxy that forwards WebSocket upgrades. Use HTTPS/WSS for network access, set the
exact origin allowlist, and keep the bridge and daemon socket private. The Vite
proxy is a development convenience, not a production server.

## Workflows

The DAG canvas uses `/api/workflow-jobs/ws` to submit Aixand IR sequences to the
existing sibling [Runner](../../runner/README.md). This gateway reuses
the workspace session and the origin allowlist. It forwards `health`,
`submit`, `events`, `result`, and `cancel` through Runner’s newline JSON Unix
socket protocol. Runner owns preflight, ordering, durable events, execution and
`StopOwned` cleanup; the gateway adds no scheduling or agent execution logic.
Disconnecting the browser leaves the durable job running.

Build Runner with `cargo build --locked --features sdk` in `../../runner`, then
start `runner --home /absolute/runner-home serve --sdk-config /absolute/sdk.json`.
Set `WORKFLOW_RUNNER_HOME` to the same home; it defaults to `RUNNER_HOME`, then
`$XDG_STATE_HOME/runner` or `~/.local/state/runner`. Runtime configuration belongs
to Runner. Browser requests cannot choose a socket or SDK configuration.
Submissions carry a persisted idempotency key so a lost response can recover the
same job. Gateway limits are 1 MiB per browser frame, eight connections, and 32
concurrent requests per connection. Runner’s structured errors pass back to the UI.

`npm run test:e2e -- test/workflow-jobs.e2e-spec.ts` checks authentication,
strict requests, and durable disconnect behavior using an isolated socket fixture.
The web checkout’s `npm run test:workflows:sequence` performs the opt-in real
two-agent sequential browser test against an already running SDK-enabled Runner.

The earlier sequence editor’s bridge API remains available separately:

The new `/api/workflows/ws` gateway reuses the terminal origin allowlist and
the authenticated workspace session. That session also authorizes running
workflows as the server OS user. Browser frames contain IR and ordinary workflow
inputs; runtime configuration and credentials stay on the server.

```text
React sequential editor
  → authenticated Nest WebSocket gateway
  → workflow-bridge (Rust)
  → existing aixand-ir validator / catalog registry / runner
  → existing verifier or aixand-python runtime bindings
  → Agent Manager / Undercurrent
```

Build from this directory (requires the sibling `aixand-ir` checkout):

```sh
npm run workflow:build
cargo test --locked --manifest-path workflow-bridge/Cargo.toml
cargo clippy --locked --manifest-path workflow-bridge/Cargo.toml --all-targets -- -D warnings
```

The bridge links PyO3 and needs a supported CPython development installation.
The current prepared environment uses Python 3.14. No SDK credentials or running
daemon are needed for authoring, validation, export, or the native verifier.

| Variable | Purpose |
| --- | --- |
| `WORKFLOW_BRIDGE_PATH` | Defaults to `workflow-bridge/target/debug/aixand-workflow-bridge` |
| `WORKFLOW_CWD` | Defaults to sibling `aixand-ir`; base for relative SDK paths and workflow operation `cwd` |
| `WORKFLOW_CATALOG_PATHS` | Optional OS path-list of portable catalog JSON files, loaded through `CatalogRegistry`; unset uses the existing Aixand and verifier catalogs |
| `WORKFLOW_SDK_CONFIG` | Existing `aixand_ir_aixand::Config` JSON file; omit to leave agent bindings unavailable |
| `WORKFLOW_PYTHON_BIN` | Optional Python environment `bin` directory prepended to the bridge PATH, including Agent Manager's supervisor interpreter |

To use the already prepared authenticated `backup` profile, add absolute paths
to the existing `aixand-ir/examples/real-agent/runtime.example.json` and
`aixand-ir/.venv/bin` as `WORKFLOW_SDK_CONFIG` and `WORKFLOW_PYTHON_BIN`. Keep
`WORKFLOW_CWD` at `aixand-ir` for the checked-in examples. Start Undercurrent
as usual and open Workflows in the existing Web app. Agent Manager continues to
own profile authentication and directory trust. See the
[existing SDK example setup](../aixand-ir/examples/real-agent/README.md).

The private JSONL protocol supports `catalogs`, `example`, `validate`, `references`,
`run` and `cancel`. Validation passes the original source string to the core
parser, preserving duplicate-key/numeric checks. Canonical export uses the core
canonicalizer. Reference suggestions use core type compatibility, not a separate
TypeScript type system. Catalog contracts and runtime handlers remain separate;
adding a catalog alone never installs executable code. Changed or missing runtime
contracts fail the existing runner's binding checks before workflow effects.

Each authenticated connection owns one Rust bridge and at most one active run.
Runs call `Runner::run_scoped_json` with existing `StopOwned` cleanup. Rust forwards
the runner's events and emits a final result only after scope cleanup. Cancellation
uses its existing token; stdin EOF requests cancellation and waits for cleanup.
The Nest gateway allows 30 seconds after disconnect before a last-resort kill,
which cannot confirm cleanup. Browser disconnects are reported as uncertain,
never silently retried. There is no scheduler, stored run history, persistence,
new workflow representation, or new IR control flow.

Frames are limited to 1 MiB, bridge output to 4 MiB, pending requests to 64, and
connections to eight. Private SDK stderr is drained rather than logged. SDK
inputs/configuration do not enter access logs. `WORKFLOW_CWD` and other host
configuration can only be set by the server environment, not browser requests.

`npm run test:e2e` includes origin/authentication and missing-bridge boundary
checks. The Web browser suite builds this bridge and exercises actual validation,
reference filtering, canonical round trips, verifier runner events/results and
missing bindings, with SDK execution disabled. The Web's opt-in
`npm run test:workflows:live` executes the six-step compiled fixture through this
gateway using the existing authenticated profile and records events/results.

## Rebrand verification

`npm run test:workflows:protocol` builds the server and workflow bridge, starts
a private local gateway on an available port, checks legacy-draft migration,
and executes a deterministic verifier workflow. It uses no model provider and
shuts down its test server afterward. Use `npm run test:e2e` for authentication
and transport failure checks, and the sibling web project's
`npm run test:terminals` for isolated real-terminal browser coverage.

## Agents

### Saved session history

The history library is separate from the existing `sessions` managed-run
operation. `session-list` discovers provider-owned conversations in every
registered home, including `default`, and returns bounded pages, home/project
scopes, and state counts. It accepts `home`, `cwd`, `view`, `query`, `offset`,
`limit`, and `refresh`. Archives and OpenCode child sessions remain discoverable.

`session-transcript` takes `{provider, profile, id, before?, limit?}`. Codex reads
canonical JSONL response items and tool receipts; OpenCode V2 reads its
`session_message` table. History paths are resolved by server-side identity and
checked against the selected home. Neither reader launches or resumes agents
or reads credential tables. Transcript pages include a backward cursor and
explicit partial-history notices.

`session-start` takes a durable `key`, provider/profile, `expectedAuth`, and
either a new-session `cwd` or saved `id` with optional `sourceProfile`. Optional
`auth`, `model`, and `mcp` select launch settings. Login changes require an idle
home. Original-home Codex resumes use the SDK's structured `thread_id`;
OpenCode resumes use its configured resume arguments. A different Codex profile
starts a linked thread, imports supported compacted context without sending a
model turn, and opens a managed terminal. Source history remains intact.
Interrupted creation is journaled and never automatically replayed.

### Command chat

New Codex conversations expose the `aixand_workspace` dynamic-tool namespace:
`list_projects`, `start_project_chat`, `get_chat_status`, and `open_terminal`. A general Command
chat can resolve a saved project and start a separate audit without selecting
that project in its composer. The launch inherits the source conversation's
resolved profile and model, creates a fresh thread using the saved access default
or explicit launch override, and submits its
first task. The audit has its own transcript and controls; its creation is
broadcast to connected browsers. Source conversations show durable linked cards
with progress, input requests, and completed response previews. Links use
`#/command/<chat-id>` and survive reloads.

New attached spawns automatically return their assigned task report to the source
chat. The parent ends its turn after launch acceptance; the backend later queues
the report and starts a separate parent turn. This works without an open browser
or Carrier configuration, including after backend restart. Stop and paused queues
hold returns; detaching cancels undelivered returns. Detached and older launches
retain their original behavior. Results are frozen against the exact assigned
turn, with full reports available through `read_delegation_result`. See
[automatic chat returns](docs/conversation-tools.md#automatic-returns-from-spawned-chats).

Spawned sessions are attached to their parent by default. The child header links
back to the parent, and the parent's **Spawned sessions** cards track attached
children. For an explicitly independent session, `start_project_chat` accepts
`detached: true`; the agent uses that option only when requested. The child's
**Detach** button also removes an existing relationship. Detaching is a local,
durable metadata change: it preserves the thread, history, selected access and
running work, removes parent progress/result tracking, and broadcasts the change
to connected browsers. Detached sessions remain accessible through History and
their direct URLs. The original launch provenance and retry identity remain in
the ledger; retries cannot reattach or duplicate a detached session. Existing
spawned sessions stay attached without a database migration.

The backend validates tool arguments and derives source identity from the live
Codex request. Only registered project IDs can supply a directory. Audit chats
do not receive these launch tools, and source transcript history is not copied.
The tool returns when the first turn is accepted. Leaving or stopping the source
chat does not stop an accepted audit. Stopping the shared profile process still
affects all threads using it. Each chat’s saved sandbox and approval policy are preserved on resume.

The launch ledger wraps the existing create/send journals. Repeated tool delivery
and identical dispatches within the same source turn reuse the same destination.
Provider timeouts or interrupted delivery are recorded as uncertain and never
automatically resubmitted. Known destinations can be reopened and reconciled;
definite first-message failures retain their chat for manual continuation.
Launches are limited to 20 per source conversation, with 16 concurrent tool
handlers. `chat-launches` reads/reconciles linked launches, while `chat-created`
and `launch-updated` events keep connected browsers current. `chat-detach` uses
the usual mutation key and requires no provider connection; `chat-updated`
broadcasts relationship changes.

Spawned chats and chat-driven workflow stages use a persisted access default, initially
`read-only`. **Settings → Spawned agents → Default access** changes it for future
launches across browsers. `spawn-settings-get` returns `{defaultMode, revision}`;
`spawn-settings-set` accepts `{defaultMode, expectedRevision}` and broadcasts
`spawn-settings-changed`. Stale revisions are rejected. The default lives in the
same scoped SQLite database as Suite chat state.

**Settings → Approvals → Automatically approve requests** enables Suite's own
approval handling, independently of the access presets below. It is off by
default, persists in the scoped chat database, and is shared across browsers.
When enabled, Suite approves command, file-change, and permission requests for
connected local, remote-device, and managed-backend chats, including requests
already waiting and requests recovered on reopen. It continues while browsers
are closed if the bridge remains connected. Questions and MCP elicitation still
require user input; provider sandbox and operating system restrictions still apply.
ACP permission choices use the adapter's exact allow option ID, preferring
`allow_once`. Providers that do not identify an allow option remain manual.
Automatic delivery reuses a durable operation key so replayed requests and
uncertain responses cannot dispatch a second approval. Delivery errors appear on
the request with the manual response controls available.
`approval-settings-get` returns `{autoApprove, revision}`; `approval-settings-set`
accepts `{autoApprove, expectedRevision}` and broadcasts
`approval-settings-changed`. Stale revisions are rejected.

| Preset | Sandbox | Approval policy |
| --- | --- | --- |
| `read-only` | `read-only` | `on-request` |
| `workspace-write` | `workspace-write` | `on-request` |
| `workspace-auto` | `workspace-write` | `never` |
| `full-access` (YOLO) | `danger-full-access` | `never` |

`start_project_chat`, `start_project_audit_workflow`, `start_project_workflow`, and
`chat-workflow-start` accept an optional `permissionMode`. Custom workflow stages
can override it individually with their own `permissionMode`. An omitted mode uses
the saved default. Workflow modes are frozen at scheduling in each Runner step's
explicit `permission_mode` field, so later settings changes and restarts cannot
change queued stages. Suite checks Runner's `chat_permission_modes` capability
before submission; a process without it must be rebuilt and restarted. Older
metadata snapshots remain supported by the updated Runner and Suite. Existing conversations and older scheduled workflows
keep their original access. Child instructions, launch cards and chat details
reflect the resolved mode. Agent Manager must support `approvalPolicy` in
`resume_thread(native_settings=...)` to preserve the selection after reconnecting.

Set `AGENTS_WORKSPACE_TOOLS=0` to disable model-invoked workspace actions. Ordinary chats,
saved conversations and the explicit terminal button remain available. Previously
enabled conversations acquire the updated tool schema when next attached while
idle; conversations created without workspace tools need a new chat to use them. Agent Manager's optional
`capabilities` initialization argument enables Codex's experimental dynamic-tool
API. The integration is verified against Codex 0.160.0; this protocol remains
experimental. An MCP transport is not required or installed.

Command's Codex chat API shares `/api/agents/ws`, the authenticated workspace session and
the origin allowlist. Install the updated sibling `agent-manager[sdk]` in the
selected `AGENTS_PYTHON` environment, start the existing Undercurrent daemon,
and use Codex supporting `app-server --listen unix://PATH` (verified with 0.160.0).
The prepared local Python environment is selected automatically when present.

Claude SDK and Antigravity SDK packages must be installed into this same Python
environment. Installing them into Manager Suite's development environment alone
does not enable them in a running Suite bridge. From this directory, install the
qualified versions into the default prepared environment with:

```sh
uv pip install --python ../aixand-ir/.venv/bin/python \
  'claude-agent-sdk==0.2.168' 'google-antigravity==0.1.22' 'mcp>=1.30,<2'
```

If `AGENTS_PYTHON` overrides the default, use that interpreter instead. Refresh the
chat backend catalog after installing. New drafts choose an available backend when
the provider's preferred ACP adapter is missing. Existing conversations keep
their captured backend; a failed creation offers a new draft on an available
backend while preserving its prompt. Claude profiles can explicitly select
**Edit profile → SDK authentication → Use this profile’s Claude Code login →
Save authentication method** to use their assigned saved login or profile's native
Claude sign-in. API credentials remain available as a separate mode. Antigravity
SDK profiles use separately assigned Chat API credentials. Existing chats retain
their captured authentication; switching methods applies to new chats.

Agent Manager starts one app-server per active profile with its existing
authentication lease. Undercurrent owns process supervision; a private Unix
socket carries Codex RPC. The browser receives messages and activity through
Nest's authenticated gateway. Carrier is optional for these conversations.

Opening a saved local Codex conversation restores its original thread if the
previous app-server has ended, including chats using the managed `native-codex`
backend. Suite retains the conversation ID, account, saved home, confirmed
settings, and captured resources while updating its runtime binding. Restoring
history sends no model turn and never replays a previous request. If the old
process is still alive, Suite rejoins it; an unavailable daemon alone does not
authorize a replacement. Saved messages and drafts stay visible during recovery.
Interrupted tasks receive an informational notice, and their queued follow-ups
remain paused. Confirmed-ended owners release stale terminal and voice ownership;
temporary outages retain it. Background status checks observe existing runtimes
without launching replacements. Approval replies and Stop keep their exact
original run and turn targets.

See [RAM per profile and loaded chat](docs/chat-memory.md) for measured usage with
1, 2, 5, and 10 loaded chats, the cost of additional empty chats, and memory
planning assumptions.

The conversation's **Spawn terminal** button opens the exact native thread in
an Undercurrent terminal using Agent Manager's `spawn(thread_id=...,
app_server_run_id=..., idempotency_key=...)`. The browser sends only a chat ID and
mutation UUID; the backend resolves the original profile, thread, directory and
shared app-server. It does not copy history into a new prompt. Codex's terminal
uses the same process, model, permissions and dynamic tools. The `open_terminal`
workspace tool supports requests such as "spawn a terminal" in the conversation.
Requests during a running or waiting turn queue until that turn completes.

`chat-terminal-open` and `chat-terminal-release` accept `{key, chatId}`;
`chat-terminal-status` accepts `{chatId}`. Snapshots contain sanitized `terminal`
metadata, and `chat-event` with `kind: terminal` broadcasts association changes.
The durable association stores the original launch key and source run; repeated
requests, multiple tabs and worker restarts reuse its terminal. Unknown launch
outcomes and runtime outages retain the association until inspection establishes the
result. A failed original process is not silently replaced for a queued launch.

Chat and terminal can both submit input to the same thread. Chat retains its
composer, steering, durable follow-up queue, Stop, settings, and approval controls
while a terminal is open. Existing active-turn and expected-turn checks still
apply; `chat-interrupt` accepts an optional `expectedTurnId` so a stale Stop
cannot target a later terminal turn. Terminal status does not hide turn progress
or pending requests. The original native approval policy and Suite's persisted
automatic approval setting remain in effect. Native request resolution clears
pending approvals in both clients; a resolved request cannot be answered again.
After a worker restart, terminal-backed chats rejoin their original live thread
without configuration overrides. This subscribes the new connection to native
requests and replays approvals that were already waiting; a history read alone
does not recover those requests. Suite's saved automatic approval setting still
applies to recovered requests.
**Stop terminal client** stops only the terminal client after Undercurrent
confirms termination. It does not interrupt the shared thread or stop the
app-server. Closing a terminal pane or browser leaves the client running;
**Open terminal** reattaches to its existing session. This supports Codex with
Unix sockets and `resume --remote`; native shared turns and approval responses
are verified with 0.162.1.

### Independent chat recovery

`src/recovery/recovery.service.ts` owns a separate Python process in
`recovery-worker/main.py` and restarts it independently of the agent bridge. Its
private Unix socket lives in a mode-0700 temporary directory and is passed to
the bridge as `SUITE_RECOVERY_SOCKET`. It uses the same trusted Python/SDK source
configuration as Agents; `RECOVERY_WORKER_PATH` can override the worker path.
There is no separate daemon to configure. The frontend's `/recovery.html` entry
point and outer recovery dialog use authenticated HTTP rather than Agents WS:

- `GET /api/recovery/sessions?q=&profile=&project=&cursor=&limit=` lists and searches recent persisted metadata.
- `GET /api/chats/:chatId/terminal` checks the original process and terminal association.
- `POST /api/chats/:chatId/terminal` and `/release` accept only `{key: UUID}` and require the existing session and CSRF token.

`shared/chat_state.py` provides SDK-free reads from the same scoped SQLite
database as chat (`AGENTS_STATE_DIR/<scope>.sqlite3`, default
`~/.local/state/aixand/chats`). Titles, projects, and recent ordering therefore
remain available when bridge startup or SDK import fails, and do not depend on
browser storage. Tombstones are excluded. `history=true` optionally scans the
native provider history read-only; unmapped sessions are saved-only and cannot
launch an unverified app-server. Storage failures are reported as unavailable,
not an empty history.

Terminal intents, their frozen native source/context, operation receipts, and
voice leases share this database. Per-chat advisory file locks coordinate the
bridge and recovery process. The worker checks the actual native turn before
launching, then calls Agent Manager with the original thread and explicit
app-server run. Lost responses reuse the original idempotency key; runtime
outages retain ownership. The bridge polls durable association changes even
when no browser opened a chat, and rejects competing input/settings changes.
Worker or bridge shutdown detaches callers and leaves native sessions running.
Recovery never silently replaces an app-server or resumes saved-only history.
Local Codex is supported; remote devices and managed routes are listed as
unsupported. Suite dynamic tools still need their bridge handlers to be online.

Verify the isolated catalog/API and worker:

```sh
python3 -m unittest discover -s recovery-worker/tests -p test_recovery.py -v
npx vitest run src/recovery/recovery.spec.ts
```

`recovery-worker/tests/test_recovery_live.py` is an opt-in real Codex/Undercurrent
check using a local model fixture, with no paid model calls. Set `UC_TEST_BIN`
to the directory containing `uc-daemon` and `uc-python-bridge`, `CODEX_TEST_BIN`
to Codex, and use the prepared Python environment with sibling SDKs on
`PYTHONPATH`. It verifies disconnected-chat attachment, the exact native thread,
duplicate requests, worker restart, and terminal-only release. Bridge integration
is covered by `agent-bridge/tests/test_recovery_bridge.py` using those SDK paths.

Command defaults to **Auto**, which uses the same Agent Manager profile selector
as `agent codex start`: the viable Codex profile with the most weekly budget
remaining, with ties preferring `default` and then alphabetical name. Profiles
without assigned auth, unavailable or exhausted budgets, or conflicting active
auth leases are skipped. `chat-create` and `chat-connect` accept `profile: null`
for automatic selection. Selection happens for each new conversation; Suite
persists the resolved profile and auth so retries, follow-ups and reopening keep
the original identity. Explicit profile selection remains available.

Command's **Model** picker loads Codex choices with the selected profile's
`model/list` RPC and OpenCode choices through Agent Manager's model discovery.
Auto previews the catalog from a saved Codex profile while leaving budget-based
profile selection until launch. **Profile default** omits the model override.
An explicit choice applies to the new conversation, survives reopening, and
does not change the saved profile configuration. Switching profiles clears the
choice; existing conversations display their model with the picker disabled.

Projects are saved in the same private, workspace-scoped metadata store. Create
one with a name and an absolute local directory path; the backend checks that the
directory exists and is accessible. `project-list` and `project-create` work without
an active Undercurrent session. Selecting a project creates Work conversations in
its saved directory, and projects with no conversations still appear in Command.
Identical name/path creation retries reuse the existing project. Project changes
refresh connected browsers through `projects-changed` events. Command starts
with empty history; sample conversations, drafts and project names are removed.

Project discovery stays in this backend's Python bridge. `project-discovery-start`
accepts a durable UUID `key`, an explicit `root` (absolute or `~/…`), `mode`
(`preview` by default, or `add`), optional `includeNested`, and up to 32 `exclude`
patterns. It returns a saved job promptly; two dedicated filesystem workers keep
chat and voice responsive. `project-discovery-get`, `project-discovery-list`, and
`project-discovery-results` inspect jobs and page candidates. Pages contain at most
100 entries; job lists also respect a response-size budget and return `nextOffset`.
`project-discovery-cancel` stops scanning or pending registration. `project-import`
accepts a durable `key`, `jobId`, and `selection` (`recommended`, `all`, `filtered`, or candidate
UUIDs from that scan). These operations use the existing authenticated agents socket
and do not require an active provider or Undercurrent daemon.

Live onboarding is coordinated by `src/onboarding`, with revisioned progress in
the authentication database. `GET /api/auth/onboarding/status` checks Agent
Manager's provider catalog and the project registry. Pending progress is compared
with current profile readiness and registrations; `POST /api/auth/onboarding/reconcile`
accepts `{expectedRevision}` to save that observation without repeating setup actions.
Ready profiles are reused, and old automatic selections of untouched providers are
deferred. Explicit selections and edits are preserved. Already configured workspaces
clear stale pending setup, while manually reopened setup stays open.
Otherwise setup is needed when both are unconfigured. Discovery failures remain
errors. `POST /api/auth/onboarding/start` accepts `{manual?: boolean}`, and
`POST /api/auth/onboarding/complete` accepts `{expectedRevision, skipProjects}`.
Completion checks current Manager profile identities, account readiness and
unfinished operations before registering directories. Each registration result
is saved so a partial failure or lost reply can be reconciled on retry.

The generic directory API belongs to this server's `src/filesystem` module:
`GET /api/filesystem/locations` and `GET /api/filesystem/directories?path=…`.
Directory queries support `base`, `prefix`, `cursor`, `limit`, `hidden` and
`suggest`; replies contain canonical location, breadcrumbs and directory entries.
These endpoints require a Suite session, return no file contents and create no
folders. Onboarding writes also require the existing origin and CSRF checks.
Provider definitions, installer recipes, sign-in validation and profile readiness
come from Agent Manager's `provider_catalog` and `provider_operations` modules.
Orchestration's retained operation worker delegates provider execution to Manager;
it owns no onboarding or directory browsing API.
The worker relays Manager's versioned installation `progress` payload through the
existing operation events and saves the latest snapshot with the operation, including
after completion. Stage interpretation and download measurements belong to Manager.

`project-discovery-filter` takes a durable `key`, `jobId`, and optional `scope`
(`all` or `roots`), case-insensitive name/path `query` (512 characters), and
`candidateIds` (up to 2,000 saved candidate UUIDs). It replaces the saved display
filter, emits a new revision for the same job/card, and preserves all candidates
and registrations. Roots exclude ordinary nested packages but include independently
marked Git/Pathspec roots. Conditions combine; an empty ID list matches nothing.
Omitting query/IDs with scope `all` clears the filter. Result pages apply the filter
before pagination; job views include matched/total counts and five matching previews.
Filters survive restart. Replaying a filter key returns the current view without
reapplying an older filter. `selection=filtered` explicitly imports that view's
matching candidates; `recommended` and `all` remain scan-wide, including automatic
add-mode registration, so a display-only request cannot change an accepted import.

The scanner recognizes Git roots/worktrees, package/build manifests,
`.pathspec/manifest.yaml`, and explicit `.aixand/project.json` roots. The latter
requires schema `aixand/project-1`, accepts an optional name, and up to 2,000 relative
member paths within the root. Names are bounded to 128 characters; absolute member
paths, parent traversal, invalid JSON/schema, symlinks, and oversized metadata are
rejected. Declared members are nested even when they have their own Git/Pathspec
markers. Suite's [root marker](../.aixand/project.json) groups its five components
under `aixand-suite`; ordinary collection directories remain unregistered.
Outermost projects and independently marked nested roots are recommended;
ordinary nested packages and declared members are optional.
It skips directory symlinks, dependencies, build output, and caches, and reads only
bounded regular metadata files. Limits are depth 32, 100,000 directories, one million
entries, 2,000 candidates, 120 seconds, and 64 KiB per metadata file. Missing access,
invalid metadata, and reached bounds produce `scanComplete=false`, coverage reasons,
and bounded warning details. An add-mode scan may register its discovered eligible
roots while explicitly reporting incomplete coverage.

Candidate paths are revalidated before import. Registration deduplicates by resolved
path, preserves existing IDs/names, and qualifies colliding folder names.
Project rows, import outcome, and retry journal commit in one SQLite transaction.
The 200-project cap is preflighted: an oversized selection adds nothing. A committed
batch emits one `projects-changed`; revisioned `project-discovery-updated` events
report progress and results. Job/candidate records live in the same workspace-scoped
database as projects. Backend restart marks unfinished jobs interrupted and never
automatically repeats registration. Replaying an operation key returns its saved
job/result; using it with different arguments fails.

Ordinary top-level Codex chats expose `add_project`, `remove_project`, `discover_projects`, `get_project_discovery`,
`filter_project_discovery`, `add_discovered_projects`, and `cancel_project_discovery` in `aixand_workspace`.
Vox exposes the same operations in `aixand_vox`. Tool job access is scoped to the
originating conversation/session; audited child and Runner chats do not receive
discovery tools. Explicit discover-and-add requests set `add=true`; discovery alone
previews. Accepted jobs continue independently, and the model acknowledges dispatch
without polling unless asked for progress. Existing eligible idle chats acquire
the current tool schema on attachment. A schema upgrade creates a replacement
native thread, imports model context without replaying tool operations, and retains
the Suite chat ID, timeline, project, and model. MCP reconnect also reports the
Suite tool inventory. No separate MCP server or scanner service is installed.

`add_project` takes a name and explicit absolute local directory or `~/…` path and
uses `project-create` under the registry lock. It supports existing directories
without Git or manifests, performs no scan or directory initialization, and emits
`projects-changed` after insertion. Name/path retries reuse the same saved project;
names are unique without ASCII case distinctions, and resolved directory paths are
unique. Registering an existing path under another name fails with the saved name;
symlinks, trailing slashes and `..` do not create aliases. Parent and child paths
remain independent projects and can be added in either order. Startup merges legacy
path aliases into the oldest registration, retaining redirects for their IDs so
saved chats and workflows remain usable. Chat views use the canonical project name
without rewriting conversation history. The 200-project capacity limit still applies.
If the user supplies only a path, the tool instructions derive its folder
name. Workspace/Vox active-call checks also apply to this tool.

`remove_project(projectId)` unregisters exactly one project when explicitly asked.
Models resolve the UUID with `list_projects` and clarify ambiguous names/paths.
The authenticated `project-remove` socket operation takes that UUID and a durable
retry `key`. It deletes only the registry row, retaining files, stored chat history,
child registrations, and scan candidates. Existing chats keep their saved
directory and remain usable; new project launches require a registered project ID.
Removal and its result journal commit under the registry lock in one transaction.
Retries return their saved outcome, including after restart or later re-registration;
an already absent ID returns `removed=false`. A successful removal emits one
`projects-changed` and new revisions for discoveries containing that path so their
live candidate registration status refreshes. Original import counts remain historical.
Removing a registration does not cancel chats or workflows or exclude its folder
from future explicitly requested imports.

Run `python3 -m unittest discover -s agent-bridge/tests -p test_projects.py` with the
SDK sources on `PYTHONPATH` for scanner/import/recovery tests. The agents gateway
integration test covers real bridge discovery, events, paging, and reconnect retries.

The gateway supports `chat-connect`, `chat-list`, `chat-create`, `chat-open`,
`chat-send`, `chat-interrupt` and `chat-answer`. `chat-event` frames stream message
deltas, activity, turn status and requests for questions or approvals. Without a
selected project, each new Codex chat gets its own workspace at
`~/.aixand/aixand-suite/codex/<conversation-id>/`. `AGENTS_SCRATCH_DIR` can override
the parent directory. The backend creates these folders automatically, retains
them for follow-ups and reopening, and ignores client-supplied directories for
general chats. Selecting a project uses its saved path. Both kinds of conversation
create `workspace-write` threads with `on-request` approvals, so general chats can
produce files in their own workspace. Existing threads keep their saved directories
and permissions. Stopping a turn leaves its conversation available for
follow-ups; Terminals can stop the whole profile process.

Suite persists profile, saved-login identity, project directory, thread ID,
bounded transcript snapshots and mutation retry keys. `AGENTS_STATE_DIR` selects
the private metadata directory; it defaults to `$XDG_STATE_HOME/aixand/chats`,
or `~/.local/state/aixand/chats`. State is scoped to the manager and runtime home.
Codex remains the source for thread history. Browser disconnects leave the
Python protocol connection and managed process running. Reopening a saved chat
resumes its original thread. A saved-login reassignment cannot silently move an
existing conversation to another login. Codex saves thread history after its
first turn; an empty conversation that loses its protocol connection may need
to be started again.

Each mutation has a caller-chosen UUID key. Identical completed chat retries return
the latest snapshot without resubmitting a turn. Snapshot revisions prevent older
responses from replacing newer streamed content. An unconfirmed provider response is never replayed; inspect
the conversation before continuing. This also covers bridge interruptions between
submitting an RPC and recording its response. Command provides outcome inspection
and continuation controls for this case.

`npm run test:chats` in the sibling web checkout exercises the complete browser,
gateway, SDK, Undercurrent and offline app-server path, including streaming,
follow-ups, questions, approvals, Stop, lost-response deduplication, backend
restart, project Work threads, saved history and mobile accessibility. It makes no model calls.

The chat browser check also covers agent-launched audits, repeated dynamic-tool
delivery, independent source/audit interruption, concurrent browser history,
direct chat links, linked completion cards, and recovery after refresh. Python
bridge tests include launch argument validation and uncertain-delivery recovery.
For an opt-in check using the installed Codex harness against a local Responses
fixture (no OpenAI requests), run from this directory:

```sh
UC_TEST_BIN=../../undercurrent/target/debug CODEX_TEST_BIN="$(command -v codex)" \
  PYTHONPATH=../../manager-suites/agent-manager:../../undercurrent/python/src \
  ../aixand-ir/.venv/bin/python -m unittest discover \
  -s agent-bridge/tests -p test_workspace_codex.py -v
```

`/api/agents/ws` is the local Agent Manager gateway. It shares the existing workspace
key and origin allowlist. One lazily started Python worker belongs to the Nest
application and serves authenticated connections. Closing a browser only detaches
that browser; manually launched agents continue running.

The worker imports the sibling `../../manager-suites` checkouts, including
`resource-sources/src`, and `../../undercurrent/python/src` by default.
It uses `../aixand-ir/.venv/bin/python` when available, otherwise `python3`.
For installed SDK packages, source paths can point to nonexistent directories:
Python will still discover packages installed in the selected interpreter.
`AGENTS_PYTHON`, `AGENTS_MANAGER_SOURCE`, `AGENTS_RUNTIME_SOURCE`,
`RESOURCE_SOURCES_SOURCE`, and `AGENTS_BRIDGE_PATH` can select an existing installation.
Refresh editable package installations when their dependencies change; see
[Manager Suites configuration](docs/manager-suites.md#configuration). No package installation,
daemon startup, or provider login happens implicitly.

Use the same `AGENT_MANAGER_HOME`, `AGENT_MANAGER_CONFIG`, and `UNDERCURRENT_HOME`
as the CLI and workflows. `UNDERCURRENT_PYTHON_BRIDGE` selects the matching
`uc-python-bridge`; provider binaries must be available on the server PATH.
`AGENTS_CWD` selects the default launch/model-discovery directory, falling back to
`TERMINAL_CWD` and then the server user's home. Restart the worker/backend after
changing provider configuration; profile assignments and models refresh normally.

Profiles and saved logins remain in Agent Manager. Runtime observations and
terminal sessions remain in Undercurrent. The worker's catalog reads do not need a
running daemon or fetch allowance. Allowance requests run separately, coalesce
concurrent requests, and use Agent Manager's existing cache. OpenCode model
discovery and saved selection use the SDK; Codex supports launch overrides and its
native profile default.

Requests expose profiles, saved-login management, provider inspection and
maintenance, models, budgets, managed launches, and runtime observations.
Browser-selected environments, arbitrary provider arguments, storage roots, and
SDK configuration are rejected. Profile/login mutations use the manager registry
lock, protect active credentials, and roll back directories on failed writes.
SDK records are sanitized before crossing the boundary. Credential bytes are not
returned through the Agents API; interactive sign-in and maintenance output are
available through their authenticated retained terminals. Session reads show up to 250 managed records per implementation,
including pending/uncertain launches and retained history. Runtime-offline reads
retain administrative records while marking observations unavailable.

The boundary limits frames to 64 KiB, bridge output to 4 MiB, connections to eight,
per-connection pending requests to sixteen, and worker requests to thirty-two.
Completed mutation IDs are retained per connection (up to 4096); repeating the same
ID returns its response, and changing its arguments is rejected. These IDs are not
a durable launch idempotency API. After a lost response or restart, discover the
existing managed runs and reconcile them before explicitly launching again.
Login creation, renewal, import, and verification plus provider install/update/repair
use durable `agent-operation-start` keys. Records, private worker specifications,
and completion receipts live in a scope beneath `AGENTS_STATE_DIR/agent-operations`
(or the user state directory). Native Undercurrent terminals own the work; browser
or bridge shutdown detaches it. Unconfirmed starts recover by a saved terminal
name and are not replayed. Maintenance can wait for idle profiles and blocks new
Suite terminal/app-server launches while starting, running, or unconfirmed.
Queued maintenance and login jobs can be cancelled. A started installer runs to
completion; resolving a missing terminal acknowledges uncertainty without
claiming success. Provider checks report published npm release metadata; actual
updates reuse the detected installation method and retain Homebrew pin behavior.

Backend shutdown drains the worker for up to ten seconds, then may force its exit.
This detaches SDK callers; detached Agent Manager supervisors and Undercurrent
sessions retain their existing ownership and recovery behavior.

Verify the bridge and real SDK boundary:

```sh
PYTHONPATH=../../manager-suites/agent-manager:../../undercurrent/python/src python3 -m unittest discover -s agent-bridge/tests
npm run test
npm run test:e2e
```

The sibling web app's `npm run test:agents` runs the complete browser/gateway/SDK
path with disposable Agent Manager storage, a real isolated Undercurrent daemon,
and an offline provider. It verifies exact terminal attachment, login isolation,
backend restart, worker recovery on Linux, lost-response recovery, multiple tabs,
and stop/finalization. It makes no model calls and cleans up its own sessions.

## Chat voice

The global **Vox** assistant uses the separate authenticated `/api/vox/ws`
gateway and a private `aixand-vox` Python worker. It combines Pipecat, local
Whisper/Kokoro, and the managed Codex app-server SDK. Its Suite tool dispatcher
reuses the existing projects/profile/chat lifecycle and persists investigation
receipts. See [Vox setup and configuration](../aixand-vox/README.md).
Optional auto-call uses a separate WebRTC input and a local Sherpa ONNX keyword
model; idle listening needs neither Whisper nor a Codex thread. The validated
`wake-offer`/`wake-stop` requests and keyword events are owned by the authenticated
browser connection. Spoken mute disables the call microphone; the opt-in wake
listener stays available for unmute/end. Going offline or disconnecting releases
both peers. `VOX_WAKE_MODEL_DIR` can override the keyword model cache directory.
The browser's Settings page controls diagnostics per connection. `wake-offer`
accepts an optional boolean `debug` flag (default false); authenticated
`wake-debug` requests update only that owner's current listener. With debug off,
the keyword processor skips audio measurements and its diagnostic monitor does
not run. Wake and call commands remain available. Diagnostic events use the same
owner filtering as other Vox events.

Codex chats have a microphone button in the composer, including new chats. The
browser requests microphone permission on click and connects audio with WebRTC;
the authenticated agents gateway and Python adapter negotiate the session on the
chat's existing Codex thread. Credentials stay in the managed profile. Mute,
stop, audio playback recovery, and live captions are available in the chat UI.
Captions show the current voice session; the Suite does not record audio.

This uses Codex's experimental `thread/realtime/*` protocol with
`experimentalApi` enabled and `version: "v3"` for WebRTC. It was checked with
Codex 0.162.1. The active profile needs voice access; unsupported versions or
accounts report an error while typed chat remains usable. Browsers need HTTPS
or localhost and a working microphone.

Only the browser connection that starts voice receives its negotiation and
transcript events. Stop, chat navigation, page exit, microphone revocation, and
connection loss release browser capture. The backend requests session stop on browser
disconnect. Voice and a terminal client cannot own the same chat simultaneously.

Run `npm run test:voice` in `aixand-web` for local WebRTC browser checks using a
fake microphone and an isolated transport. Python voice lifecycle checks live in
`agent-bridge/tests/test_voice.py`, and gateway ownership checks run with
`npm run test:e2e -- test/agents-voice.e2e-spec.ts`.

## Prompts

The Web's `#/prompts` page uses the authenticated `/api/agents/ws` gateway and its
existing lazy Python worker. Install the updated sibling Prompt Manager and
`agent-manager[prompts]` in `AGENTS_PYTHON`, or use their default local source paths.
No Undercurrent daemon or model provider is needed for catalog reads, previews,
authoring, releases, profile bindings or saved instruction inspection.

`PROMPT_MANAGER_HOME` is forwarded to the worker so the Web and CLI use the same
release store. `PROMPTS_MANAGER_SOURCE` selects the Prompt Manager Python source
directory, defaulting to `../../manager-suites/prompt-manager/src`. `PROMPTS_PACK_PATHS` is an OS
path-list of durable authoring roots; when absent, `PROMPT_MANAGER_PACKS` is used.
When both are absent, no authoring roots are added. Applications register their
owned defaults through Agent Manager’s application API. Explicit roots remain an
advanced authoring option; existing registrations remain until explicitly removed.
The configured Agent Manager installation is also registered on first Prompts use.

Operations are `prompts-catalog`, `prompts-show`, `prompts-preview`,
`prompts-validate`, `prompts-diff`, `prompts-save`, `prompts-release`,
`prompts-history`, `prompts-snapshot`, `prompts-bind`, and `prompts-unbind`.
Browser requests select server-discovered IDs rather than filesystem or SDK roots.
Mutations retain the gateway's duplicate-request handling and broadcast
`prompts-changed`. Draft edits and publishing require the opened content digest;
binding changes require the observed binding digest. The existing 64 KiB incoming
frame and 4 MiB worker response limits apply. The page edits existing assets up to
32,000 characters; larger authoring changes can use the filesystem/CLI workflow.

Each catalog refresh re-reads registered files and consumer metadata. The page also
refreshes on window focus and after Web mutations. New releases do not advance
profile bindings, and saved conversation instructions are immutable. Suite Chat's
application-owned developer instructions continue through their existing launch
path; profile bindings apply only to launches that explicitly opt into managed
instructions. The library distinguishes task prompts from eligible instruction
recipes instead of treating every prompt as a profile binding.

Verify with the following and the Web's `npm run test:prompts`:

```sh
PYTHONPATH=../../manager-suites/agent-manager:../../manager-suites/prompt-manager/src:../../undercurrent/python/src \
  python3 -m unittest discover -s agent-bridge/tests -p test_prompts.py
npm run test:e2e -- test/agents.e2e-spec.ts
```

## Carrier

The `/api/carrier/ws` gateway connects the web inbox to the local Carrier service
through one persistent Python SDK adapter. Inbox preferences, message history,
retry-safe sends and agent bindings survive browser disconnects. Setup, defaults,
additional mailboxes, agent recovery and verification are documented in
[Local Carrier integration](docs/carrier.md).

## Agent labels and metadata

Suite follows the shared [launch-context contract](../../manager-suites/agent-manager/docs/launch-context.md).
New Codex servers receive `session.kind=server` and
`service.name=codex-app-server`. Agent terminals receive `session.kind=agent`
and private native-thread/server references. New ordinary and group-created
shells receive `app=aixand-suite`, `feature=terminal`, `session.kind=shell`;
new maintenance/login jobs receive `session.kind=job` and operation references.
Saved group shell recipes retain these attributes on restoration. Existing
sessions and threads are not rewritten or restarted to add these defaults.

For Suite's own services launched manually through Undercurrent, use:

```sh
# Run from aixand-server after building and completing authentication setup.
uc start aixand-server --label app=aixand-suite --label feature=backend --label session.kind=server --label service.name=aixand-server -- npm run start:prod
# Run from aixand-web for the development frontend.
uc start aixand-web --label app=aixand-suite --label feature=web --label session.kind=server --label service.name=aixand-web -- npm run dev
```

These commands create new sessions; inspect existing sessions rather than
running them again when a service is already managed.

Suite terminal, chat, workflow, Carrier and Vox launches receive
`app=aixand-suite` and a feature label. Project launches add common project
identity plus `suite.project_id`. Workflow threads add the run and stage IDs;
Vox controllers/investigations add the voice session ID. Child project chats
inherit workflow context and record their source turn/call privately. Shared
Codex processes keep app-level context, with separate durable thread context.

`launch` and `chat-create` accept validated `labels` / `metadata` string maps;
`sessions` and `chat-list` accept exact label filters. `run-metadata` and
`chat-metadata` explicitly read private metadata. Normal responses and events
omit metadata. Terminal retry intents freeze context before submission. The UI
shows labels, offers automatic terminal filters by app/project/workflow/role,
and fetches chat metadata when requested in conversation information. Saved
terminal groups keep their existing behavior.

`AGENT_MANAGER_LABELS` and `AGENT_MANAGER_METADATA` reach the agent/workflow/voice
workers. Runner submissions stamp Suite defaults into `metadata.agent_context`,
and supplied context is validated before dispatch. Full artifact data stays in
application records; session metadata contains references and bounded strings.

Shared prompt, skill and MCP requests use Agent Manager 0.1.1's
`resource-request-1` contract. Suite forwards `resources` for new chats, terminal
launches and workflow stages; profile defaults are read and atomically saved via
`profile-resources-get` / `profile-resources-set`. `launch-preview` stays offline.
The SDK owns merging, version pins, optional/required policy and delivery reports.
Accepted user content remains active while publisher changes await reconciliation.

Connect advertises `resourceRequestVersion`. Managed requests resolve on the paired
device with that device's manager stores and capabilities; store paths must refer
to that machine. Direct native chats report unsupported optional extras and reject
required extras. A remote request never switches execution routes. MCP delivery
reports describe configuration separately from live connection status. Rebuild
the companion download with the existing build script after updating Connect.
