# Aixand Connect integration

The [Connect guide](../../../services/connect/README.md) covers device setup, companion
commands, transfer limits, storage, and platform verification scope.

Suite's authenticated `/api/agents/ws` gateway validates `connect-*` requests and
passes them to the existing Python bridge. No additional public Suite endpoint
or authentication bypass is introduced. The new `connect-transfer-updated` event
uses the same authorized WebSocket subscription and backpressure limits as chat.
File bytes travel directly from the Suite host to the companion, not through
the browser or model context.

`Chats.connect_store()` loads the Suite-owned `services/connect` package.
Prepare it with `./dev.sh prepare` from the Suite root. An explicit
`AIXAND_CONNECT_SOURCE` selects a source override during development.
It shares the private chat SQLite
connection on the event loop, with separate tables for settings, paired devices,
and transfer receipts. HTTP/hashing/streaming run on bounded worker threads.
At most four transfers run concurrently; progress events are throttled to four
per second per transfer. Transfer operations survive browser disconnection.

Native `aixand_workspace` tools derive the source chat from the authenticated
profile, thread, active turn, and call ID. Callers cannot supply another chat,
an arbitrary host, a receiving directory, or a credential. Source files are
restricted to that chat's saved project. Matching sends within one turn reuse
the saved operation. Status and cancellation tools only access transfers in
the same conversation. Setup is available only through Settings, not chat tools.

File transfer and direct Codex chats do not depend on Undercurrent. When started with `--project-root`,
it advertises remote Codex support. `connect-codex-inspect` verifies the paired
device's live NetBird identity, installation/login, and remote directory. A
`chat-create` with `deviceId` routes through `remote_chats.py`; its pinned device
and directory are persisted in the normal chat record. Mixing a remote target
with a local backend selection is rejected. The `start_remote_chat` workspace
tool reuses the existing durable launch journal and linked child-chat cards.

The companion owns one stdio `codex app-server` per live chat, with a four-process
limit, bounded event buffers, and durable mutation receipts. Suite forwards only
allowlisted native thread/turn requests. Browser/Suite disconnects do not kill
remote turns. A fresh Suite connection reloads native thread history and pending
approvals; an event-buffer gap requires reopening the conversation. Unconfirmed
mutations are never automatically replayed. Native commands are never sent to
the Suite host as a fallback. Remote credentials/configuration stay on the device.
The transport follows Codex's [app-server protocol](https://developers.openai.com/codex/app-server).

`copy_project_to_device` and `test_project_on_device` use `project_runs.py` to
journal packaging, verified delivery, and workspace publication. Copies finish
with the extracted `cwd`; test runs additionally start a linked remote conversation.
The `connect-project-copy/start/check/cancel` gateway operations and
`connect-project-updated` event expose the same lifecycle to the owner UI. The
tools default to the source chat's saved project. Only test runs accept execution
instructions and permissions, defaulting to Workspace write. Copy runs never
inspect or start Codex and require only the companion's `projectSnapshots`
capability. `get_project_run` exposes the confirmed directory for subsequent
requested remote work; `cancel_project_run` handles either kind. Tool status
and cancellation are scoped to their originating conversation. Device credentials,
arbitrary hosts, and destination paths cannot be supplied through these tools.

`snapshot.py` creates a bounded ZIP from current working files with a checksummed
manifest, exclusions, and portable-path validation. The companion's
`project_workspace.py` verifies a completed transfer and journals publication
under a new UUID directory inside its first project root. Repeated preparation
returns the existing workspace, preserving any later remote changes. A lost
submission response never triggers another test turn automatically. Test reports
are parsed from the remote Codex response, with a successful native command
required for a passing report; missing/malformed reports remain unconfirmed.

`test_project_across_devices` uses `project_matrix.py` and one parent journal
record with two to four target records. `list_project_test_targets` identifies
paired machines and the Suite host. Packaging happens once; every target receives
the same manifest identity and archive checksum. Target records stay inside one
parent comparison card, and their updates advance the parent's revision. A shared
semaphore bounds target execution to two jobs while remaining targets queue.

The optional Suite host extracts into a private `project-workspaces/<database>/<target>`
folder with the same snapshot verifier. The native chat uses the source profile
and model, with an internal snapshot identity checked against its journaled chat
and source project. Browser arguments cannot supply this internal override.
Neither local nor remote tests execute in the original source directory. Check,
Stop, native approval, failure, and report state remain independent per target;
`targetId` on `connect-project-check/cancel` must belong to the specified comparison.
`connect-project-compare` and `connect-project-targets` are the gateway counterparts.
Suite restarts mark unfinished targets uncertain, and Check reuses the existing
snapshot and conversations without repeating unconfirmed submissions.

## Optional device managers

`managerDiscovery` is an authenticated companion capability. The gateway's
`connect-managers-inspect` and the active-chat tool `inspect_device_managers`
inspect the paired device through `/v1/managers`. The versioned report separates
package detection, configured profiles and runtime preflight. No process is
launched and no credential contents are returned during discovery.

`chat-create` with `deviceId` and `profile: null` defaults to remote Agent Manager
Auto. `profileSelection: {mode: "specific", profile: "personal"}` selects a named
profile; `{mode: "direct"}` explicitly uses the device's native Codex login.
The legacy `remoteProfile` field remains an exact-profile alias. Managed chats use
`remote_managed.py` and the existing `Backends` controls. The companion's
`/v1/managers/sessions/<chat UUID>` accepts only the fixed managed-operation
allowlist. Python selection, local stores, connection references and runtime
addresses are device-owned; callers cannot override them. The optional helper
runs in the discovered or explicitly configured `--manager-python` environment,
so the downloadable base companion remains dependency-free.

Agent Manager owns launch/resource preparation; Server Manager owns normalized
sessions, operation receipts, event replay and native approval mapping;
Undercurrent owns the retained processes. Connect persists the interpreter and
manager/runtime binding before delivery. Stable launch/create IDs, pinned session
references and an operation journal prevent retries from changing routes or
creating replacement sessions. Helper/client exit only disconnects its client.
Read-only recovery does not launch a worker. Linked managed tasks resolve their
assigned native turn through the retained normalized send receipt before returning
a report, rather than guessing from the latest conversation status.

Remote chats and project tests share the same selection policy. Agent Manager's
quota router runs **on the selected machine** and ranks eligible accounts by
remaining weekly percentage, checking short-term exhaustion and fresh quota
observations. Unknown/exhausted quota or unavailable managers never trigger a
fallback. The decision is persisted before launch and contains only public
profile/auth labels and quota observations in Suite; credential contents stay on
the device. Retries retain the original profile, account, runtime and session.

`connect-project-start` / `test_project_on_device` accept `profileSelection`.
`connect-project-compare` / `test_project_across_devices` also accept
`targetProfiles: [{deviceId, profileSelection}]` for selected-device overrides.
Omitted selection means Auto independently on every target, including the Suite
host. Direct on the host explicitly retains the controller profile. Readiness
is checked before uploading each target; quota is selected at agent launch.
The shared snapshot, independent cancellation and result cards work with both
managed and direct targets. Cards show the selected profile and allowance at
selection. Managed passing reports require actual command execution from the
assigned native turn's retained history. File-only project copies require no
agent or profile selection. Existing saved runs retain their original route.

`test_remote_managers_live.py` exercises the complete Suite/HTTP/helper/native
Codex path using isolated stores, an isolated real Undercurrent daemon and a local
model fixture. Set `UC_TEST_BIN` to the installed runtime bin directory and
`CODEX_TEST_BIN` to Codex, using a Python environment with the Manager SDKs (and
native Server Manager dependencies). It covers a lost create response, streaming,
approval across both Suite and companion restarts, exact session identity,
cancellation, automatic report return, highest-quota selection, pinned retries,
exhausted-account rejection, and project reports with native command evidence. No real model
credentials are used by that test. `services/connect/tests/test_managers.py` covers
authentication, argument validation, unavailable runtimes, route/interpreter
pinning, ambiguous delivery and loading the helper from the downloadable bundle.

## Checks

From `apps/server`:

```sh
npm run build
npm run lint
npm test -- src/agents/connect-protocol.spec.ts src/agents/protocol.spec.ts
PYTHONPATH=../../../manager-suites/agent-manager:../../../undercurrent/python/src:../../../manager-suites/prompt-manager/src:../../../carrier:../../../manager-suites/mcp-manager/src:../../../manager-suites/server-manager/src \
  python3 -m unittest discover -s agent-bridge/tests -p 'test_remote_chats.py' -v
PYTHONPATH=../../services/connect:../../../manager-suites/agent-manager:../../../undercurrent/python/src:../../../manager-suites/prompt-manager/src:../../../carrier:../../../manager-suites/mcp-manager/src:../../../manager-suites/server-manager/src \
  python3 -m unittest discover -s agent-bridge/tests -p 'test_project_runs.py' -v
PYTHONPATH=../../services/connect:../../../manager-suites/agent-manager:../../../undercurrent/python/src:../../../manager-suites/prompt-manager/src:../../../carrier:../../../manager-suites/mcp-manager/src:../../../manager-suites/server-manager/src \
  python3 -m unittest discover -s agent-bridge/tests -p 'test_project_matrix.py' -v
```

From `apps/web`:

```sh
npm run build
npm run lint
npm run test:connect
```

The chat integration test invokes the real workspace tool dispatcher, paired
receiver, streaming sender, receipt journal, and snapshot/event path. It supplies
a local NetBird peer fixture and does not contact a model provider or real account.
Browser tests exercise pairing, companion download, credential clearing, progress,
cancellation, uncertain-delivery checks, stale events, reloads, mobile layout, and
accessibility, plus remote chat creation, pinned location, streaming, Stop, and
retries with the same creation identity. They use mocked WebSockets. Separate
live verification on the paired Mac exercised the real bridge, NetBird transport,
native Codex commands/file writes, reconnect after bridge restart, and Stop.
Project tests additionally cover current source and exclusions, archive validation,
publication without overwrites, original-chat progress/report cards, test failure
and missing reports, lost preparation/submission acknowledgements, cancellation,
restart recovery, mobile layout, and accessibility.
Live snapshot verification copied modified and untracked Linux source to the
paired Mac, ran four real `unittest` checks there, returned a passing parent-card
report, and reopened the same native conversation after recreating the isolated
Suite bridge. The live account database was only read to populate that isolated
test; no test conversations were inserted into the owner's history.
Copy-only checks exercise extraction without Codex installed, deduplication,
lost publication acknowledgements, cancellation racing completed publication,
folder-card persistence, and rejected execution arguments.
Live copy-only verification sent the owner's Lore project through the workspace
tool dispatcher over NetBird and verified all 645 extracted files against the
manifest on the Mac. The receiver's Codex session count remained unchanged.

Comparison checks cover one frozen snapshot despite subsequent source edits,
separate local/remote workspaces, different test outcomes, an offline target,
queued-target cancellation, independent Stop, scoped controls, lost extraction
receipts, and restart recovery without duplicate turns. The combined browser card
is checked for per-machine controls, partial results, reloads, and accessibility.
Live comparison verification ran the same three standard-library tests through
native Codex on the Suite Linux host and paired Mac. Both passed with matching
snapshot identities and archive checksums, and original files stayed unchanged.
This smoke test used an isolated Suite database; it did not insert test chats into
the owner's history. Windows execution has not been verified on a live device.


## Conversation deletion and retained work

Deleting a conversation is a local history change, including while a paired device,
Runner, or Carrier is unavailable. The shared orchestration backend retains frozen
execution references in `chat_deletion_details`; project runs and workflow effects
keep their existing durable records. Terminal attachments retain their explicit
control-release requirement. Parent-only and confirmed subtree deletion remain
atomic and idempotent.

`connect-activity-list`, `connect-activity-check`, and `connect-activity-stop` expose
unresolved work independently of conversation visibility. `workflow-run-action`
controls an accessible workflow by run identity after its origin is deleted.
`chat-delete-stop` is a separate, explicit action: it validates the selected family
and captured work, requests cancellation, and verifies execution outcomes before
the browser performs ordinary deletion. A cancellation acknowledgment is not a
confirmed stopped task.

The companion's `GET /v1/codex/sessions/<id>` inspects an existing identity without
calling `ensure`. Optional `turnId` and `operationId` query parameters recover a
saved terminal turn or original operation receipt. Terminal turn evidence is
persisted in `codex_turns`. Background observation never submits input or creates a
replacement runtime. Existing companions must be updated to provide this endpoint.

Workflow inspection saves terminal execution evidence and an immutable pending
report before contacting Carrier. Report delivery retries the existing
`native_messages` identity and does not need a live provider. Runner still owns
dependencies and advances only after the report handoff. Deleting a worker chat
preserves only its assigned workflow report-read capability until execution ends.
Deleted chats reject ordinary user input and are excluded from chat broadcasts;
workflow and project views suppress their chat links.

Regression checks include `test_history_activity.py`, `test_suite_resources.py`,
`test_sdk_workflows.py`, companion `test_codex.py`, browser `chat-delete.spec.ts`,
and `background-work.spec.ts`.
