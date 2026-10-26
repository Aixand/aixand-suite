# Local Carrier integration

The Carrier page and Home use `/api/carrier/ws`, authenticated with the existing
workspace session cookie. One backend-owned Python bridge serves
all browser tabs. It uses the public Carrier SDK and a separate Suite SQLite
database. Browser disconnects do not stop the bridge, durable sends, or agents.

## Start locally

Start Carrier separately with `carrier serve`. Its default URL is
`http://127.0.0.1:8765`. Set `CARRIER_DATABASE` in the backend's `.env` to the exact
`--db` path used by that process before allowing mailbox provisioning. This source
checkout defaults to `~/.aixand/carrier/carrier.db`; older installed services may use
`~/.local/share/carrier/carrier.db`. A localhost URL does not identify the database.
For a standalone CLI installed from source, run `./dev.sh reinstall` from the
Carrier checkout to load code updates, then restart the Carrier service. With
the provided user service, use `systemctl --user restart carrier.service`.
The service unit and any overrides must point at the updated command and the
intended database. An editable install needs only a service restart.
Restart `aixand-server` after updating the Python SDK or bridge.

Run the backend from `aixand-server` and the frontend from `aixand-web` as usual.
Sign in to Suite and open Carrier. The session cookie authorizes every page.
See [password setup and host-only recovery](authentication.md).

`CARRIER_PYTHON` must name a Python 3.11+ environment containing `carrier-mcp`
and, for agent messaging, `aixand-python`. The sibling
`aixand-python/.venv/bin/python` is selected automatically when it exists.
An editable local SDK environment can be prepared from the Suite root with:

```sh
python3 -m venv aixand-python/.venv
aixand-python/.venv/bin/python -m pip install -r aixand-python/requirements-dev.txt
```

On Windows the corresponding interpreter is `aixand-python/.venv/Scripts/python.exe`.
Packaged installations run the bridge with Suite's Python SDK environment; the
independent Carrier product's Python environment is used only for `carrier.cli serve`.
The bridge uses the shared cross-platform file lock and a bounded threaded stdin
reader on Windows, macOS and Linux. Installation failures such as a missing module
are shown explicitly and require manual Retry after repair; transient disconnections
continue to reconnect automatically.

On the first authenticated Carrier connection, the adapter provisions
`suite/local/user` through Carrier's administrative CLI if its credential file
does not exist. Credentials default to `~/.aixand/suite/carrier/user.json` and
are reused on later starts. An existing address without its original credentials
is reported as a provisioning error; the identity is never silently replaced.
Set `CARRIER_AUTO_PROVISION=0` to require preprovisioned credentials.

Set `CARRIER_DATABASE` to the **same database served by the configured URL**
before permitting provisioning, including at the default URL. Existing credential files can be used without
provisioning. The default configuration is local and single-user.

## Configuration

| Setting | Default / purpose |
| --- | --- |
| `CARRIER_URL` | `http://127.0.0.1:8765` |
| `CARRIER_DATABASE` | Explicit running-service database path required for administrative provisioning |
| `CARRIER_PYTHON` | Sibling SDK virtual environment when available, otherwise `python3` |
| `CARRIER_BRIDGE_PATH` | `carrier-bridge/main.py`, relative to backend working directory |
| `CARRIER_STATE_DIR` | `~/.aixand/suite/carrier` |
| `CARRIER_STATE_DATABASE` | `<state directory>/suite.db` |
| `CARRIER_WORKSPACE_ID` | `local`; mailbox address namespace |
| `CARRIER_USER_ADDRESS` | `suite/<workspace-id>/user` |
| `CARRIER_USER_CREDENTIALS` | `<state directory>/user.json` |
| `CARRIER_AUTO_PROVISION` | `1`; provisions only the default user mailbox |
| `CARRIER_POLL_INTERVAL` | `2` seconds; allowed range 0.1–60 |
| `CARRIER_INSTANCE_ID` | Generated and persisted with the Suite dataset |
| `CARRIER_MAILBOXES_FILE` | Optional server-only JSON array of application mailboxes |
| `CARRIER_AGENT_CONFIG` | Optional runtime, provider, budget-source and context-link JSON |

Keep Carrier's database and credentials together when restoring a backup. If its
dataset is replaced or reset, choose a fresh `CARRIER_INSTANCE_ID` so reused
numeric message IDs cannot collide with the old mirror. Changing the service URL
under an existing instance ID is rejected. Only one adapter may own a Suite
state database; an exclusive lock prevents duplicate adapter processes.

Additional application mailbox configuration:

```json
[
  {
    "id": "events",
    "address": "suite/local/events",
    "name": "Project events",
    "credentials": "/absolute/private/events.json"
  }
]
```

Each registered mailbox has separate read/archive preferences, history and outbox.
The browser selects registered IDs and cannot supply credential paths, service
URLs, Python code, launch programs or recovery manifests.

## Messages and delivery

Inbox, Unread, Pending, Archived and Sent query the persistent local mirror.
Search covers message content and sender/recipient addresses. History is paginated
and response sizes are bounded, including large Unicode messages. Cached content
remains available during an upstream outage; errors and incomplete synchronization
are displayed explicitly. Home always shows the default user mailbox's attention
list, independently of the selected Carrier view.

Read/unread and archive/restore change Suite preferences only. Acknowledge is an
explicit Carrier action and preserves history. Acknowledgment means acceptance,
not task completion. Replies carry the original numeric `reply_to` reference and
are addressed back to the original sender. Conversation views follow connected
reply relationships, including branches and partial history.

Suite persists each send intent and retry key before submitting it. A missing
response leaves an unknown outcome in the outbox. Read-only delivery-status checks
reconcile it across restarts. **Retry same send** reuses the exact original key,
content, recipient and reply reference. Editing a submitted message creates a
new operation. No mutation is automatically replayed after a disconnect.

The updated Carrier SDK exposes `receive_sent()` and the service exposes `/sent`.
They return only the authenticated sender's retained outgoing messages, including
sends made outside Suite. Against an older service, the page reports that Sent
contains Suite-recorded sends only. History cursors track new messages; a separate
bounded refresh observes acknowledgment changes on older messages.

## Agents and recovery

When `aixand-python` is installed, Codex profile discovery and its built-in MCP
launch adapter are enabled by default. Agent Manager owns profiles/authentication;
Undercurrent owns terminal processes. Configure their usual environment variables
or supply explicit connection options:

```json
{
  "connection": {
    "runtime_home": "/absolute/path/to/undercurrent",
    "bridge": "/absolute/path/to/uc-python-bridge",
    "manager_home": "/absolute/path/to/agent-manager",
    "manager_config": "/absolute/path/to/providers.toml",
    "stable_for": 2,
    "timeout": 300
  },
  "cwd": "/absolute/path/to/project",
  "providers": { "codex": {} },
  "budget_sources": ["budget/local"]
}
```

An empty `providers` object disables agent launching. Other configured providers
require an `mcp_arguments` array containing their own launch flags; `{url}` and
`{credentials}` placeholders are substituted by the backend. Configure only
providers supported by the local Agent Manager installation.

Select a configured provider profile in Chat to start a live conversation.
Each conversation receives a fresh Carrier identity,
and the initial request is sent through the durable outbox. Agent answers appear
in Command and Carrier. Work completion requires an authenticated, correlated
`task.completed` or `task.failed` message for that registered run. It is not inferred
from terminal readiness, message acknowledgment or printed output.

Carrier's agent-conversation list opens the existing terminal, stops its registered
agent, or restores an inactive delivery binding. Backend shutdown detaches agents
and closes consumers; Carrier retains messages sent while consumers are inactive.
Restart marks previously active bindings inactive until **Restore delivery** is used.

Restoration uses the public `aixand.agents.restore()` API. It validates the managed
run, provider/profile/auth/home, runtime home, live session and its original process
start time, Carrier URL, credential
identities and original journal. Its exclusive journal lock rejects competing
owners. Confirmed writes continue from their acceptance stage. An uncertain input
or `submitting` journal entry blocks recovery; no terminal input is replayed.
The API reattaches only to the original live conversation. It never launches,
resumes or forks a conversation. Keep the original manifests, journals and
credential files when preserving agent runs.

## Structured updates and budget alerts

Plain text and unknown JSON remain plain text. Recognized messages use:

```json
{
  "schema": "aixand.carrier",
  "version": 1,
  "kind": "agent.question",
  "title": "Which approach should I use?",
  "body": "Please choose an approach.",
  "project_id": "project-123",
  "run_id": "registered-run-id",
  "document_id": "document-456"
}
```

Supported kinds are `agent.update`, `agent.question`, `task.request`,
`task.completed`, `task.failed` and `project.update`. Sender identity always comes
from Carrier authentication. A registered agent/run reference can open its terminal.
Optional `context_links.projects` and `context_links.documents` in the server's
agent configuration map IDs to available Suite routes; messages cannot invent
their own navigation actions. Links are shown only when registered.

Budget monitoring uses Carrier's existing `budget-source` provisioning and
`/events/budget` ingestion. Register trusted source addresses in `budget_sources`
to render their authenticated `budget.threshold_crossed` and `budget.test` events
as readable alerts. Ingestion and deduplication remain Carrier responsibilities.

## Chat inbox references

Chat's `@inbox/` picker reads the shared Suite mirror through two authenticated,
read-only gateway operations. `message_search` accepts `mailbox`, `search`,
`limit` (1–100) and `offset`, and returns `instance`, message summaries, `total`
and `next_offset`. Summaries include ID, displayed title, sender, creation date
and a 180-character preview. It searches all incoming messages, including archived
ones, supports hyphen-separated title words, and recognizes the generated `~ID`
suffix. It excludes outgoing messages.

`message_get` requires `mailbox`, numeric `id` and the `instance` from search.
It returns one full presented incoming message, rejects a different dataset or
mailbox, and never acknowledges delivery or changes preferences. Neither
operation switches the browser's active Carrier mailbox or folder. Existing
cached messages can be read while the upstream service is unavailable.

The composer keeps selected IDs with its draft, resolves bodies before the first
submission, and freezes the resulting source context with the send operation.
Chat-create retries retain it for the initial send, and queue/steering retries
reuse the exact text and operation key. Incomplete references and context larger
than the chat text limit fail before a send or chat creation. Agent MCP identities
remain scoped to their own Carrier inboxes; this feature does not change them.

## Verification

From `aixand-server`:

```sh
npm run build
npm run lint
npm test
npm run test:e2e
../aixand-python/.venv/bin/python -m unittest discover -s carrier-bridge -p 'test_*.py' -v
```

The installed-runtime verifiers also exercise Carrier's authenticated WebSocket,
initial synchronization and SDK availability on each platform. To qualify just
the bridge against disposable services after building the backend, run from the
Suite root:

```sh
node scripts/runtime/verify-carrier-bridge.mjs aixand-server /absolute/path/to/suite/python
```

The optional fourth argument selects a separate interpreter for the upstream
Carrier service; the third argument is the bridge's `main.py` path. The stdio
tests cover Unicode, exclusive ownership, input limits and clean shutdown.

The runtime tests use matching sibling Undercurrent binaries; set `UC_TEST_BIN`
to override their location. From `aixand-web`, run `npm run test:carrier` for real
Carrier, Nest, Vite, browser, MCP and agent-delivery coverage. The runner creates
temporary services, identities and a deterministic PTY provider, uses no model
accounts, and stops only its own sessions/services afterwards. It also checks
mobile layout and accessibility in light/dark themes.
