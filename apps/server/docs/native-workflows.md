# Native chat workflows

Runner schedules native project chats and checkpoints their dependencies. Suite
executes idempotent chat and Carrier effects. Carrier retains addressed requests,
correlated stage submissions, and the final human delivery.

Claude SDK and Antigravity SDK controllers with Suite tools also support this
pipeline. Select an existing SDK controller in Run; every project-chat stage
retains that controller's provider/backend and inherits its profile unless a
specific profile is chosen. SDK runs capture `sdkApprovalPolicy: ask | deny`
instead of Codex sandbox access, and quota Auto is unavailable. The builder,
pending-stage edits and run inspector preserve these policies. Exact-turn SDK
terminal artifacts supply final reports; children read dependency reports through
the same scoped MCP broker and Carrier identities. Rebuild/restart Runner with
`sdk_chat_workflows: [1]` and use updated SDK workers. The native access presets
described below apply to Codex workflows.

Choose **Workflows → New workflow → Project audit → main inbox**. Architecture
and security audits run concurrently. After both successful reports, a planning
chat receives both complete reports and its final task list goes to **Main inbox**.
The saved example opens in the normal editable builder with audit chat nodes,
a Collector inbox, task planning, and Main inbox. Select nodes to edit their
instructions, add/remove nodes, and draw report dependencies. In **Run**, select
a saved project and controller conversation, or create a controller using Auto/a
saved Codex profile. **Start run** snapshots the graph and returns after durable
Runner acceptance. New runs support explicit changes to upcoming steps, while
started steps retain their accepted instructions and access permissions.
Every saved canvas uses the same node library and Run panel. A normal empty canvas can combine project chats, managed agents/advisers, explicit Spawn/Send/Wait steps, Collector joins, Carrier messaging, Result, Done, Main inbox and Previous workflow result. Templates supply starting graphs only. New canvas submissions use `aixand.workflow-graph` version 2 through `/api/workflow-jobs/ws` when Runner advertises support; older hosts use version 1. Runner schedules the dependency graph and executes both IR and native chat effects. Adviser side connections grant optional messaging access and never require an answer before a task can finish. Project chat nodes consume required reports; their access follows the captured spawn policy or an explicit stage override.

Native graph outputs are checkpointed and resume across Runner restarts. Graphs with live SDK session handles preserve the existing IR uncertainty policy and are not blindly replayed after a crash. The shared Run panel can reconcile resumable native graphs using Runner’s `resume` operation. Old chat-created plans and saved native attempts remain supported without rewriting their accepted submissions. Earlier audit forms migrate into editable canvases with backed-up originals; opening a saved attempt never resubmits it.

You can also ask a controller chat to audit architecture/security in separate chats,
combine the results into tasks, and send them to the main inbox. Its workspace tools
resolve the saved project and call `start_project_audit_workflow`.
`get_workflow_status` inspects progress; `cancel_workflow` cancels owned stages.
Launch tools return after Runner durably accepts the job, with `accepted`, a run ID,
and a workflow link. The controller acknowledges scheduling and finishes its reply;
it only polls or waits when the user explicitly requests monitoring. Finishing the
controller turn does not cancel any workflow stages. Existing idle controllers
receive the updated tool instructions on their next attachment/turn.

Chat-created runs appear automatically under **Workflows → Runs**, alongside the
saved workflow library. **View workflow** in a chat or audit editor opens the saved
run in the normal workflow builder's run mode, sharing its canvas, nodes, toolbar,
minimap, and inspector. Select nodes to inspect the accepted instructions or
open their chats, including pending input requests. Moving/arranging nodes saves only
the browser's layout, without recompiling or changing the accepted plan. The Progress
panel shows stage status, confirmed delivery, and explicit reconciliation/cancellation
actions. Collector joins count only successful correlated dependency reports and
become ready after Carrier acknowledgment. Main inbox delivery displays the confirmed
message ID. The graph uses the submitted stage IDs, dependencies, and delivery stage;
it does not require the controller to remain active.
Backend workflow events update progress, and reconnect/reload restores it through
read-only paginated discovery and run opening. Opening an unaccepted run never submits
it; **Reconcile progress** remains an explicit recovery action. Run history remains
viewable after the initiating chat is deleted. Full report bodies and credentials
are excluded from these public progress responses.
`start_project_workflow` supports other sequences/joins with up to 16 named stages,
`dependsOn`, and a `deliveryStep`. For sequential audits, give security
`dependsOn: ["architecture"]`. Stages inherit the controller's project/model and, unless a profile policy overrides it, its profile,
use the saved spawn access default unless `permissionMode` overrides it on the run
or a stage, and cannot spawn more chats through workspace tools. Suite freezes the
resolved presets in Runner’s explicit `permission_mode` step fields. `full-access`
means no sandbox and no approval prompts. Older accepted jobs retain their saved
permissions; changing the default does not upgrade them. Runner health must
advertise `chat_permission_modes`; rebuild and restart an older process before
reconciling an unaccepted run. A failed run that already created read-only chats
needs a new launch to use different permissions.

## Spawn access and profile selection

Settings → Spawned agents → Default access supports the four runtime presets and
**Manual**. A saved YOLO default also applies to audits and reviews. Describing a
task as “no code changes” does not change its runtime access. Under Manual, provide
one workflow-wide `permissionMode` or an explicit mode on every stage; missing
stage IDs are reported before worker creation. Manual is never sent to a provider
as a runtime permission. Standalone and remote test launches use the same default.
Accepted choices survive settings changes, append/amend, retries and restarts.
Appended native stages inherit the captured workflow default; a workflow accepted
under Manual requires an explicit mode for each new stage.

`profileSelection` accepts `{"mode":"controller"}`, `{"mode":"auto"}` (optionally
with `eligibleProfiles: ["work", "backup"]`), or
`{"mode":"specific","profile":"backup"}` on a workflow or a stage. Omit a stage
policy to inherit the workflow. The Run panel and stage inspector expose these
choices, plus selected profile/auth, effective access, quota time and routing reason.
Auto chooses when each stage becomes ready. Agent Manager ranks remaining weekly
percentages, rejects exhausted short-term limits and unknown/stale observations,
and uses account load and stable names for ties. Auth aliases exposing the same
Codex account ID share one allowance. Prompt/skill/MCP compatibility and the
requested model are checked; no compatible candidate is an error. Only local
Codex quota routing is supported. A remote device must use its own quota adapter.

Suite saves the resolved profile, auth/account identity, resource requirements and
quota decision before creating a worker. Reconciliation reuses that decision;
changing settings or quota cannot silently reroute a retry. A changed saved auth
or resource assignment rejects launch instead of replacing the selected identity.
Server Manager forwards captured sandbox and approval settings on native resume.

Canvas clients call `chat-workflow-prepare` with a stable `key` and compiled graph
before submitting it to Runner; the normal builder does this automatically and
retains the prepared graph for retries and continuations. Raw legacy Runner plans
retain their original concrete-policy behavior. Runner must advertise
`chat_spawn_policy: [1]`; rebuild Runner and restart Suite after installing this
contract update. Older accepted workflow payloads remain valid.

## Upcoming work and follow-up workflows

New canvas and chat-created runs have a versioned execution plan. In the canvas,
choose editing the current run or the saved definition. **Apply changes to run**
updates pending work only; saving the definition controls future launches. The
combined apply-and-save action explicitly does both. You can edit pending
instructions, add a dependent step, insert a step before pending consumers, remove
pending work and change its dependencies. Started nodes lock their instructions,
permissions and prerequisites. Existing chats and SDK resources retain their
identities and live scope. Updates compare the last accepted revision; a racing
dispatch or another editor can require refreshing the plan.

**Pause upcoming steps** holds new dispatch while current work finishes. It also
keeps the run open for an append until **Resume upcoming steps**. Pauses, accepted
revisions and current plans survive reload and restart. Final delivery closes
editing before the human message is sent. An older resumable native/graph run can
use **Enable editing**: Runner preserves recorded effects, creates a version 2
execution plan, and pauses upcoming work. Started legacy SDK scopes cannot be
adopted. The original submission remains available unchanged for recovery.

**Add follow-up workflow** selects a saved workflow and snapshots it into a durable
continuation. Register it during a run or after completion. It starts after the
parent completes successfully; failed/cancelled parents skip waiting links. Add
a **Previous workflow result** input node to the target and connect it to the next
task. The default `previous_result` mapping selects `/result`, the complete final
output before human delivery. You can select another named export or supply
additional literal JSON inputs. Pending links can be cancelled; submitted children
appear in Runs with their parent link and normal cancellation controls. Inputs are
full JSON results, never preview snippets or live SDK handles.

Controllers expose `amend_workflow`, `append_workflow_step`,
`pause_workflow_steps`, `resume_workflow_steps`, `enable_workflow_edits` and
`continue_with_workflow`. These require an owned controller workflow and persist
their exact request before sending it to Runner. Repeating a tool request after
lost acceptance recovers the same edit or child. Tools return durable acceptance
without waiting unless monitoring is requested. Loops remain future work.

## Configuration

Build the sibling Runner with `cargo build --locked`. Configure Suite using the
actual paths for your installation:

```dotenv
WORKFLOW_RUNNER_HOME=/absolute/private/runner-home
AGENTS_STATE_DIR=/absolute/private/chat-state
SUITE_WORKFLOW_SOCKET=/absolute/private/chat-state/native-workflows.sock
CARRIER_URL=http://127.0.0.1:8765
CARRIER_DATABASE=/absolute/path/to/the/database-served-by-carrier.db
CARRIER_STATE_DIR=/absolute/private/suite-carrier
CARRIER_WORKSPACE_ID=local
CARRIER_USER_ADDRESS=suite/local/user
```

Run Carrier with that database and Runner with that socket:

```sh
carrier serve --db /absolute/path/to/the/database-served-by-carrier.db
runner --home /absolute/private/runner-home serve \
  --suite-socket /absolute/private/chat-state/native-workflows.sock
```

Restart Suite with its updated build. When `CARRIER_DATABASE` or
`SUITE_WORKFLOW_SOCKET` is configured, Suite starts its adapter at backend startup
and reconnects after a worker crash, independently of browser connections.
Carrier must be available to both Suite Python environments. `CARRIER_SOURCE`
selects the sibling Carrier source for both bridges. Existing SDK/IR workflows
can use Runner's `--sdk-config`; native chat execution does not need that flag.
If the existing Runner uses `--sdk-config`, build with `--features sdk` and retain
that configuration when restarting it. Rebuilding the executable does not update
a running process: restart Runner through its process manager after the build.
`runner --home /absolute/private/runner-home health` must advertise
`capabilities.native_chat_workflows: [1, 2]`, `workflow_graphs: [1, 2]`,
`workflow_amendments: [2]`, `workflow_continuations: [1]` and
`workflow_edits_adoption: [1]`. Suite checks capabilities before using them.
An IR-only or older Runner produces a configuration error before any chats start;
after updating Runner, **Reconcile progress** retries the saved submission key.
After a lost acceptance response, Suite looks up that key to recover an already
accepted job. This read-only recovery never submits unaccepted work automatically.

Runner home defaults to `RUNNER_HOME`, then `$XDG_STATE_HOME/runner`, then
`~/.local/state/runner`. The native socket lives in `AGENTS_STATE_DIR`, otherwise
`$XDG_STATE_HOME/aixand/chats` or `~/.local/state/aixand/chats`. Main inbox uses
`CARRIER_USER_CREDENTIALS` or `CARRIER_STATE_DIR/user.json`. Automatic provisioning
requires the exact `CARRIER_DATABASE`; `CARRIER_AUTO_PROVISION=0` requires an
already provisioned main inbox. Existing credentials are preserved.

## Handoffs and recovery

Each job has a collector and per-stage sender identities. The adapter publishes a
stage's report as a reply to that exact stage request. Only successful results from
this job's declared dependencies become downstream inputs. Unrelated messages
cannot unlock stages. Runner checkpoints a result before acknowledging its message
and retries acknowledgment after restart. Acceptance and completion are separate.

Worker developer instructions require a final JSON report:

```json
{"outcome":"completed","report":"Complete Markdown report"}
```

Use `outcome: "failed"` when blocked. Provider turn completion alone does not prove
success. Reports are limited to 100,000 bytes in their JSON string representation;
oversized reports fail explicitly. `aixand_workflow.read_input` reads full assigned
reports in pages of up to 16,000 characters. UI previews never become task inputs.

Carrier's selector exposes the collector as an internal workflow inbox. It is
inspectable, while Suite blocks manual sends, acknowledgments, and message-state
changes from that identity. Main inbox has role `human`, is the default Home/Carrier
destination, and is never automatically consumed by Runner. Final delivery is a new
addressed message with links to all stage chats.

Closing the controller/browser or restarting Runner does not cancel its chats.
Stable job/stage/message identities and saved chat/turn IDs reconnect to existing
work. Unknown provider effects become `uncertain`. Use **Reconcile progress** or
`runner resume JOB-ID` to inspect an existing turn. The adapter never blindly
replays an unconfirmed send or creates a replacement thread. If no identity can be
recovered, it stays uncertain for human investigation. Cancellation interrupts only
owned recorded turns. Failed prerequisites block dependents, interrupt active
siblings, and send a failure notice to Main inbox. Provider approvals/questions
appear in the stage chat; open it to respond.
Cancelling an unconfirmed submission reserves its key in Runner, preventing late
acceptance or a later retry from restarting the cancelled work.

Native plans support successful dependency joins and failure gating. Arbitrary
condition expressions/if-else branches remain IR features, outside this native
format. This does not provide global exactly-once side effects or distributed
consumers. Carrier's stable send keys deduplicate message retries.

## Verification

Build Runner, then run from the server directory:

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=../../../manager-suites/agent-manager:../../../manager-suites/mcp-manager/src:../../../manager-suites/prompt-manager/src:../../../manager-suites/skill-manager/src:../../../manager-suites/server-manager/src:../../../undercurrent/python/src:../../../carrier \
../../workflow/ir/.venv/bin/python -m unittest discover \
  -s agent-bridge/tests -p test_native_workflows.py -v
```

Tests use a real Runner process and Carrier database/SDK with a simulated chat
provider. Coverage includes reversed completion order, process/adapter restarts,
full reports, unrelated messages, failed/invalid reports, ownership, cancellation,
uncertainty, lost Carrier response deduplication, live edits, held restarts,
legacy adoption and full-result continuation handoff. They use no paid model calls.
In the web checkout run `npm run test:workflow-builder -- tests/project-audit.spec.ts`
for authoring, saved submission recovery, live progress, and accessibility.
