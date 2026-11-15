# Chat supervision

Supervision is a capability of an ordinary saved chat (`/#/chat`). Describe the
ongoing responsibility in that conversation; its agent uses `create_monitor`, for example:

> Watch the checkout implementation chat. After each turn, check these
> requirements, ask for missing work, and launch an independent audit when it
> appears ready. Continue until the requirements are verified. Keep the evidence.

A monitor can converse with existing chats, launch helpers, read their complete
reports, and create or amend workflows. A fixed workflow is optional. The saved
mandate drives the supervisor's decisions, and the supervisor can create
workflows when dependencies or parallel execution help.

Requests such as “audit Undercurrent, wait for it, independently verify its claims,
then ask the original auditor for a brief” also use a persistent monitor. The source
chat saves the complete mandate and ends its turn. Each evaluation dispatches useful
work, checkpoints its exact target IDs and next steps, and ends. A report wakes the
next evaluation; waiting never requires a model to repeatedly read chats or poll status.
The supervisor can still choose its own investigations and follow-ups.
The handoff rule is included in the controller's developer instructions and in
accepted spawn/status responses, including responses served to older captured
tool contracts. One quick status snapshot may confirm dispatch. The agent must
then produce a final reply to end its turn; a commentary update saying “I will
wait” does not end a model turn. Status confirmation does not open full worker
history; only explicit inspection of an uncertain launch attempts a bounded refresh.

The originating conversation stays in Chat history. It shows **Supervising** while
responsible for work, including periods when no model turn is running. Other
labels are **Needs you**, **Paused**, **Completed**, and **Stopped**. Click the
badge to inspect the brief, watched resources, activity, evidence, and controls.
The **Show supervising chats** icon beside **Recent** (`/#/chat/supervising`)
filters that list to ongoing responsibilities. Project folders and history search
continue to show all conversations. A watched implementation chat instead shows **Supervised by**
with a link to its supervising conversation.

User conversation and provider history remain usable while background evaluations
run. Settled progress is retained in SQLite and appears as Supervisor messages
anchored beside the conversation that was current when it arrived. The reader
shows the latest 100 supervision updates, alongside the existing provider history
pagination. Internal evaluation prompts are hidden from the transcript, while
execution details remain available in the panel. Background evaluation chats
and their rotations are grouped under their owning conversation. Directions sent
directly to an execution chat update the durable mandate instead of steering an
old autonomous turn. A fresh execution chat preserves the visible conversation.

There is no separate Command destination. Legacy `/#/command` opens the Chat
supervision filter; `/#/command/<chat-id>` opens that chat; old
`/#/command/monitors/<monitor-id>` bookmarks resolve to the owning conversation
and open its supervision panel. The existing `command-*` API and monitor tool
names remain compatible.

## Execution and persistence

The implementation lives in the shared
`mcps/orchestration/src/orchestration_mcp/services/automations.py`
service. Suite's Python bridge owns it alongside Chats. Nest provides the
authenticated API and the private mailbox adapter; the web page is a client.
Normal controller chats and supervisors use the same shared MCP handlers.

Each monitor has an independent mandate, memory, observations, wakeups, execution
history, and action journal in the existing scoped chat SQLite database.
Supervisor conversations execute individual evaluations. They are not the source
of monitor identity or durable state. The host runs independent async monitor
tasks, with at most four simultaneous evaluations. Idle watches do not retain an
active model turn. A new chat can replace a supervisor without losing the monitor.

An evaluation reads the mandate and new observations, takes useful actions, and
calls `checkpoint_monitor` before finishing its turn. The host applies that
checkpoint only after the assigned provider turn ends. A failed turn, missing
checkpoint, unavailable source, or ambiguous submission requires attention.
Completion requires evidence references. The model remains responsible for
assessing whether those references substantiate the mandate.
Final briefs belong in the checkpoint's progress text, which is published into the
originating chat. Larger deliverables include a summary and a full evidence reference.

SQLite journals observations and stable action identities before dispatch. Chat
follow-ups use the existing durable queue and exact destination turn receipts.
On restart, Command reconciles the original supervisor turn and pending work.
An unconfirmed action is retained for inspection rather than automatically sent
again. This is not a claim of exactly-once execution for arbitrary external tools.

Attached spawned tasks already have a durable report return, so waiting for them
does not require another chat watch. Supervisor `send_chat_message` calls register
an exact-receipt completion watch atomically with queue admission, before provider
dispatch. This includes new follow-ups to an already completed auditor. Its original
spawn report stays immutable; the new receipt supplies a separate completion event
and full, paginated report evidence. Fast results that arrive before checkpointing
remain queued as observations and cannot strand a waiting evaluation.

## Watches and controls

Supported observations are chat turn/status changes, exact message receipts,
workflow settlement, retained Carrier inbox messages, one-shot timers, and recurring
intervals (minimum 30 seconds). Native chat events wake monitors; periodic
reconciliation also catches completion while a connection was absent. Inbox
watches begin at the current cursor unless `includeExisting` is requested.
Observing an inbox does not acknowledge or move its messages. Independent
delegations and monitor-owned workflow reports return directly to the monitor;
their full evidence is retained and can be read in pages.

Chat offers natural-language creation, history search and filtering, and badges.
The supervision panel offers progress, saved memory, watched resources, activity,
evidence and action inspection, pause/resume/stop, new directions,
evaluation-limit extension, and a fresh execution chat. Home shows monitors
that completed or need input. The API also supports deadlines and per-evaluation
action limits. Defaults are 100 evaluations and 30 actions per evaluation;
checkpointing remains available when the action limit is reached.

Pausing, cancellation, or updated directions revoke the previous evaluation's
tool authority. Command requests interruption of its exact supervisor turn.
Implementation chats and previously accepted independent jobs keep running.
Uncertain receipts and failed interruptions remain visible. `watch_monitor` and
`unwatch_monitor` let the supervisor change its observation strategy.

## Workflow library

The Workflows library's **Make available to supervisors** action explicitly compiles
a browser draft into an executable graph and saves it in the server library.
Browser storage alone is not a server workflow definition.
`save_command_workflow`, `list_command_workflows`, `get_command_workflow`, and
`run_command_workflow` expose the same library to ordinary chats and supervisors.
Definitions are revision checked. Runs use Runner's existing durable submission
and Suite effect protocol.

Both version 2 native chat workflows and executable workflow graphs are accepted.
Native templates bind project and controller identity at launch, preserving
explicit access, profile-selection, and resource policies. Saved native templates
with named inputs are rejected; executable graphs support named inputs. Runner
validates executable graph semantics at submission. Monitor workflow reports use
a private monitor inbox instead of generating a human Main-inbox message for
every internal stage.

## Setup and current support

Build/restart the backend and frontend using their usual commands. No separate
Command daemon or new environment variables are required. Leave the backend
running for monitoring to continue; closing the browser is supported. Stopping
the backend stops evaluations until the same state directory is opened again.
Use the existing native Codex profile/login and access configuration. Supervisors
currently require the local native Codex backend. Other provider chats can be
watched through the existing conversation interfaces when available.

New controller chats receive monitor tools automatically. Existing captured
contracts retain their original tools until **Update Suite tools** is used or a
new chat is created. When an existing native controller is explicitly adopted as
a supervisor, Command upgrades its captured tools while idle and preserves its
history through the existing tool-upgrade mechanism.

Runner and Carrier are needed for the workflow features that already depend on
them. Inbox watching uses Suite's configured Carrier bridge through private IPC;
another embedding application must inject an `automation_source` adapter.
Chat-only monitoring and delegation do not require Carrier or Runner.

The authenticated Agents WebSocket exposes `command-list`, `command-get`,
`command-activity`, `command-create`, `command-update`, `command-pause`,
`command-resume`, `command-cancel`, `command-evidence`, `command-action`,
`command-capabilities`, and the workflow-library requests. Browser clients cannot
impersonate supervisor checkpoints or private source responses. Mutations retain
their original durable request key for safe inspection/retry. Lists, activity,
evidence, and action bodies are bounded or paginated.

## Validation

`aixand-web` provides `npm run test:command:ui` for browser/accessibility tests
and `npm run test:command` for a real Nest/Python/Agent Manager/Undercurrent test
using an offline provider fixture. The latter performs follow-up, exact-turn
observation, independent audit, full-report reading, browser closure, and backend
restart recovery without paid model calls. Python tests in
`agent-bridge/tests/test_automations.py` cover lifecycle, stale evaluations,
interruption races, idempotency, evidence ownership, limits, and recovery. Existing
Runner/Carrier integration tests cover monitor-owned workflow delivery and graph
library execution.
