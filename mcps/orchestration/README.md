# Orchestration MCP

The Python distribution is `aixand-suite-orchestration-mcp`; import `orchestration_mcp`
and run `orchestration-mcp`.

One package exposes smaller selectable tool groups. Contracts live in
`src/orchestration_mcp/tool_groups`; `execution_tools.py` is the compatibility facade.

| Group | Owner and purpose |
| --- | --- |
| `shared` / `observations` | Discovery, retained associations and operation receipts |
| `conversations` | Conversation Manager startup, messages, turns, settings and approvals |
| `queues` | Conversation Manager message queues and delivery evidence |
| `tasks` | Assignments, exact cancellation, Carrier result acceptance and task events |
| `workflows` | Runner DAG submission, inspection, cancellation and recovery |
| `terminals` | Agent Manager/Undercurrent native execution and explicit input/output |

Use one MCP connection for controller operations and a scoped one-tool reporter
for each child. Generic inter-agent inbox tools remain in Carrier MCP.

Install `[conversations,tasks]` for conversation delegation, `[terminals,tasks]`
for finite native delegation, or `[workflows]` for conversation tasks plus Runner.
Plain conversations and terminals do not require Carrier. All mutations require a
stable `operation_id`; new task results have a canonical Carrier retry key per attempt.

New delegated results are submitted through authenticated Carrier identities.
The host commits acceptance before acknowledgment. It does not parse final chat
text, scrape terminal output, or read report files to establish task success.
See [the task/workflow contract](docs/delegation-workflows.md) and
[the architecture decision](../../docs/decisions/0002-carrier-task-results.md).

Example controller configuration, with a matching running Carrier service:

```sh
export CARRIER_DATABASE=/absolute/carrier.db
export CARRIER_URL=http://127.0.0.1:8765
orchestration-mcp host --home /absolute/orchestration --suite off \
  --groups shared,conversations,queues,tasks,workflows --runner-home /absolute/runner
runner --home /absolute/runner serve \
  --effect-host /absolute/orchestration/execution-workflows.sock
```

Existing explicit group lists need `tasks` for delegation and `queues` for chat
queues. These tools no longer reside implicitly in the conversation/shared groups.
Advanced workflow editing and application-bound routes require separate
qualification. The active exporter and application services remain in this
package while their Server consumers are refactored; see
[Suite architecture](../../docs/architecture.md).

Standalone MCP tools and shared workspace services for projects, agents,
conversations, durable tasks and workflows. Aixand Suite is an optional consumer
of these services. The package never imports the Suite server or its source tree.

Persistent autonomous monitors use the same workspace services. `create_monitor`
stores a mandate, independent memory, resource watches, wakeups, and an action
journal. The running workspace host dispatches bounded native Codex supervisor
evaluations and recovers their exact turns after restart. Normal controller chats
can manage monitors through the same tools. Supervisors choose conversation,
delegation, or workflow actions, then checkpoint and release their model turn.
Application-owned inbox sources are injected through `automation_source`.

The base wheel depends only on the shared filesystem and local-runtime libraries. Project registration, filesystem
discovery and discovery receipts work without any manager installed. Profile tools
need the `agents` extra (Agent Manager and its JSON Schema validator). Sessions and terminal attachment need Agent Manager's runtime
extras and a running Undercurrent daemon. Workflow execution needs Runner, a
configured effect-host socket, and Carrier for the current inbox-delivery plans.
Managed workflow-input tool delivery also needs the MCP Manager integration.
Device operations need Connect and its paired companion. Capabilities are reported
independently; unavailable optional tools are omitted from new MCP connections.

From the Suite root:

```sh
python -m pip install ./mcps/orchestration
orchestration-mcp capabilities --suite off
orchestration-mcp call add_project --arguments '{"name":"Work","path":"/absolute/work"}' --suite off
orchestration-mcp serve --suite off
```

Install extras such as `aixand-suite-orchestration-mcp[agents]`, `[resources]`, `[runtime]`,
`[runner]`, `[carrier]`, or `[connect]` only for the features needed. Installing an
extra does not start daemons, install a provider binary, copy credentials, or pair
a device.

For persistent discoveries and workflow execution, run one foreground host:

```sh
orchestration-mcp host --home ~/.local/state/aixand/orchestration --suite off
```

MCP and CLI clients using that home connect through its private `connection.json`
descriptor. The host owns the SQLite workspace and background jobs; disconnecting
a client leaves host-owned work running. An embedded `serve` process also works,
but its jobs stop when that process exits. Configure Runner's existing
`--effect-host` option with this host's `native-workflows.sock`. The effect
handler lives in this package and requires no Suite process.

`ORCHESTRATION_HOME` or `--home` chooses workspace state. `--manager-home`,
`--config`, `--runtime-home`, `--provider`, and `--profile` choose the local execution
environment. The application preserves project IDs, conversation IDs, receipts,
provider history references and captured resources. Suite continues using its
existing database path through a compatibility adapter; extraction does not copy
or rewrite its production database. Standalone workspaces have separate explicit
state paths.

`--suite off` uses independent services. `--suite auto` uses an explicitly
configured `ORCHESTRATION_SUITE_CONTEXT`/`--suite-context` when present; otherwise it
uses independent services. `--suite required` requires that private context.
Selecting a context or host fixes routing for that connection. A lost response
never falls back to another workspace or backend. Suite contexts still enforce
the originating role, active turn and captured contract.

The MCP contract freezes at initialization. Durable CLI mutations accept
`--request-id`; reuse that identity to inspect/retry the same intent. Unknown
outcomes are retained and never submitted again automatically. Standalone launches return acceptance receipts. Delegated results are read through
`get_delegated_task` or `read_delegated_task_events` after Carrier acceptance.

`publisher.publish` captures immutable stdio adapters in an optional MCP Manager
library. The default publisher is `orchestration`; Suite explicitly keeps
`aixand-suite`. Native and stdio delivery use the same contracts and shared
handlers. Accepted copies and pending publisher reconciliation retain their
captured contract and operation identity.

Suite's voice/UI adapter, current-conversation binding, notifications and browser
links stay in Suite. Its former coordination source entry points delegate to this
package. Applications can consume `services.chats.Chats`, `ProjectHost`, and
`RuntimeAdapter` directly without communicating through an MCP transport.

Applications with an existing Agent Manager terminal parent can register and bind it through
the authenticated host RPC methods `controllers/register` and `controllers/bind`. A private
`--controller-file` (schema `orchestration-mcp/controller-1`, UUID `id`) selects that parent on
a remote stdio connection. Binding verifies the managed run/session and cannot be repointed.
`controllers/status` returns compact workflow/delivery state; `controllers/cancel` cancels
owned workflows and suppresses late return prompts. An optional `planner_profile` keeps
Codex workflow writing separate from an OpenCode terminal parent.

Bound workflow results go through a private Carrier inbox, then to the same terminal only
when input is stably available and execution is idle. The host journals sends before effect,
acknowledges Carrier after confirmed delivery, and retains ambiguous outcomes without replay.
Failed/blocked workflows also return diagnostic reports. No Suite process is involved.

## Resource capture timing

`start_project_workflow`, `start_project_audit_workflow` and
`continue_with_workflow` accept `resourceCapture: "stage" | "workflow"`. Native
plans use `resource_capture`; graph context uses `resourceCapture`. Omit the field
to retain existing behavior. The workflow editor exposes the same choice.

`stage` resolves accepted resource content when each stage starts. `workflow`
resolves profile resource selections before submission and stores explicit homes
and immutable revisions in each stage policy. Existing captured requests survive
retry and amendments; new stages are captured when added. Required unavailable
resources block capture. Optional unavailable resources are omitted. Strict capture requires immutable managed MCP targets. Application-generated workflow-input tools are still bound at stage
launch. Task text already present in a plan is immutable plan data.

Quota-based Auto profile selection still happens at stage launch; workflow
capture freezes resource content, not account eligibility. Strict capture needs a
Runner advertising `resource_capture_policies`; rebuild and restart an older
Runner before reconciling the same submission. Runner accepts `--effect-host`
with `--suite-socket` retained as an alias. No Suite server is required by a
standalone orchestration host.

See [delegation and Runner workflows](docs/delegation-workflows.md) for task reports,
resource capture, effect-host setup, and current limitations.

Shared utilities are packaged from `../../../aixand-libraries/filesystem` and
`../../../aixand-libraries/local-runtime` in the sibling library checkout. Installed wheels declare these
package dependencies; release installers bundle them. No `aixand-platform`
package or external platform checkout is required.

## Local developer commands

Inside the mcps source checkout, run from this directory with
Python 3.11+ and uv:

```sh
./dev.sh develop --local
./dev.sh check
./dev.sh test
./dev.sh build
```

Use `.\dev.ps1` on Windows. Each package owns its development environment and
helper; these commands do not invoke suite-wide checks. See the
[development guide](docs/development.md) for wheel-based setup without sibling
sources, lock updates, build outputs, and the separate suite release lifecycle.

## Project tools and project conversations

The `projects` group exposes `list_projects` (query and pagination), `get_project`,
`register_project`, and `create_project`. It needs no agent runtime. Registrations
use the existing project registry; `add_project` in the older workspace contract
continues to register existing directories. Names default to the directory name.
`get_project` resolves retained alias IDs. Listings report directory availability.

`register_project` requires an existing accessible directory. `create_project`
creates only the final directory under an existing parent, then registers it; it
rejects existing destinations and does not initialize Git or scaffold files.
Both mutations require a stable `operation_id`. Inspect retained progress with
`inspect_execution_operation` from the `shared` group. Registration failures keep
the created directory and allow the same operation to recover. An ambiguous mkdir
checkpoint is reported as uncertain and never assumed to establish ownership of
an existing directory. Inspect that path before explicitly registering it.

`start_conversation` accepts exactly one of `project_id` or `cwd`, alongside its
provider, environment ID, settings and operation ID. Project selection captures
the canonical ID, name and directory before launch; retries retain that target.
Conversation startup does not send an initial message. Use
`send_conversation_message` afterward.

Suite exposes the project group through newly captured tool contexts and uses its
application registry directly. Explicit project conversation launches use the
selected project's directory and association, retaining the captured worker
identity, permissions and resources. Directory-only launches keep the existing
parent workspace restriction and project inheritance. Delegation and workflow
project targeting are unchanged. Existing captured MCP contracts remain frozen;
start a new Suite tool context to receive the new tools.
