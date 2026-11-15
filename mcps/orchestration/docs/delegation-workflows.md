# Delegation and Runner workflow effects

## Responsibility

Runner owns workflow dependency scheduling. Orchestration owns task assignments,
execution associations, resource selections and report validation. Conversation
Manager owns turns, message delivery queues and history. Agent Manager owns native
executions through Undercurrent. There is no second Python DAG scheduler and no
provider protocol parsing in the new effects.

## Delegate one task

Enable `tasks` alongside the intended execution mode. `delegate_conversation_task`
requires the provider, immutable environment ID, absolute workspace, instruction
and stable operation ID. The acceptance receipt contains a task ID, attempt ID,
execution association and exact turn ID. It is not a successful work result.

The child receives the reserved `agent_manager_task_result` stdio MCP server,
with only `submit_task_result`. The tool accepts `outcome` (`completed` or `failed`),
nonempty bounded `report`, optional `artifacts`, and a stable `operation_id`.
Task, attempt, authenticated sender and recipient are fixed by a private context;
arguments cannot override them. It publishes this versioned body through Carrier:

```json
{
  "schema": "orchestration-mcp/task-result-1",
  "task_id": "captured task UUID",
  "attempt_id": "captured attempt UUID",
  "outcome": "completed",
  "report": "Evidence and result summary",
  "artifacts": [{"uri": "project-relative-or-authorized-artifact-reference"}]
}
```

The host validates the authenticated sender/recipient and matching task attempt,
then commits acceptance, receipt and event atomically before acknowledgment.
A lost publication response reuses the same Carrier key. A lost acknowledgment is
retried from its retained receipt, including when Carrier already removed the
message from pending results. Rejected messages are recorded and acknowledged;
they never become task evidence. Cancellation rejects late reports.

`get_delegated_task` inspects current state and accepts available reports.
`list_delegated_tasks` returns retained records. `read_delegated_task_events`
requires `task_id` and accepts `after_sequence`/`limit` for bounded acceptance events.
Persistent hosts also recover report consumption automatically after restart.
Mode/ownership restrictions apply to these operations.

Normal turn/process completion without a report yields `awaiting_report`, not
success. JSON in a final response and `.orchestration-reports` files are ignored.
Observed execution failure has `failure_source=execution` and no invented report.
An accepted task result can coexist with a still-running process/conversation;
no implicit process termination occurs. Acceptance verifies correlation and shape,
not the truth of the agent's claims.

Finite native tasks still require exactly one literal `{task_prompt}` argv entry.
If the native invocation has no MCP delivery, its assignment supplies an exact
`submit-task-result` helper argv. Append `--arguments` and the JSON tool arguments.
This scoped helper publishes through Carrier; it is not an output parser.
Qualification remains subject to the provider's ability to execute that helper.

Reports are limited to 24,000 characters and 64 KB encoded, with at most 16 bounded
artifact references. Artifact hashes/URIs are metadata, not automatic fetching or
verification. Larger outputs require explicit artifact handoff instead of truncation.



## Run a conversation DAG

Install the `[workflows]` extra, provision Runner, and configure `CARRIER_DATABASE`
and its matching `CARRIER_URL` before starting the host. Provisioning uses Carrier's
public local administration API and verifies both identities against the service
before any task starts. Missing Carrier disables delegation and workflow submission
without disabling plain conversation/native execution tools. Start
an orchestration host with explicit groups and homes:

```sh
orchestration-mcp host --suite off --home /absolute/orchestration \
  --runner-home /absolute/runner --groups shared,conversations,queues,tasks,workflows
runner --home /absolute/runner serve \
  --effect-host /absolute/orchestration/execution-workflows.sock
```

Use `submit_conversation_workflow` with `name`, `provider`, `environment_id`, `cwd`,
`steps`, and `operation_id`. Each step has `id`, `instruction`, optional `title`,
and optional `depends_on`. There are at most 16 steps; identifiers and dependency
references are checked and cycles rejected before submission. Optional
`delivery_step` chooses the final report; it defaults to the last declared step.

Inspect with `inspect_execution_workflow` and read Runner's canonical result with
`get_execution_workflow_result`. `cancel_execution_workflow` cancels the exact
Runner key, including an admission race. `resume_execution_workflow` explicitly
asks Runner to reconcile the same admitted job; it does not create replacements.
A lost submit response is inspected using the recorded workflow/Runner key and
is not automatically submitted again with another operation ID.

The effect host validates each Runner plan against the registered immutable plan,
correlates job/step identities, requires matching successful dependency reports,
and delegates through Conversation Manager. Dependency reports are supplied as
explicit evidence in the next task's input. Individual task results arrive through Carrier. Aggregate workflow publication
remains a retained canonical Runner result; automatic human-inbox publication and
parent-turn injection are separate policies. Success
requires a confirmed report from every prerequisite and the selected final step.
Host restart retains task/execution identities; Runner can continue inspecting
through the same effect socket after reconnection.

This adapter uses Runner's existing native chat-workflow protocol for conversation
steps. Its compatibility `profile` field holds the captured environment ID; the
host routes through the registered environment, never by resolving a new alias.
Runner workflows with terminal steps/mixed execution modes, graph-authoring APIs,
advanced amendments and application-bound delivery still need qualification or
an extended Runner contract. They are not silently mapped onto conversation steps.

## Resource ownership and bounds

Resources no longer inherit from Agent Manager profiles. `resources.settings`
freezes explicit settings; `resources.instructions` selects a managed prompt using
`store`, `publisher`, `package`, `prompt`, optional `inputs` and optional managed
registration `revision`. Prompt Manager resolves/renders it through public APIs.
The snapshot retains rendered content and source revision with a content digest.
Changing the prompt library later does not change that captured task/workflow.
Workflow-level resources are captured before Runner admission and passed to each
task as a pinned orchestration snapshot. Model/default selection remains separate.
Conflicting settings are rejected. Frozen skill and MCP selections need qualified
public compilers; unsupported capture requests fail rather than being dropped.

Resource requests use explicit snapshots. Unsupported profile-resource requests
are rejected rather than silently dropping selections.

Conversation task inputs are bounded by the message contract. Inline Runner report
handoffs are limited to 32 KB; larger reports require an explicitly bounded handoff
rather than truncation. Resource snapshots and reports remain local to the chosen
orchestration home/workspace. No credentials or remote model quota are required by
the fixture tests.

## Verification

```sh
PYTHONPATH=src:tests \
UC_TEST_BIN=/path/to/undercurrent/bin \
RUNNER_TEST_BIN=/path/to/runner \
python -m unittest discover -s tests
```

Native tests start private daemons with temporary homes. They verify a real Runner
DAG across a host restart, input-report propagation, native terminal task report
creation, exact execution recovery, and no duplicate launches. Contract tests
cover lost submission acknowledgements, cycles, unconfirmed publication, invalid
reports and mode isolation. Static workflow bundle tests no longer import Server
Manager. Resource-manager integration is optional and explicitly skipped when its
SDK is absent.
