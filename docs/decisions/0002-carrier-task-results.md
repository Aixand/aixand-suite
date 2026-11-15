# ADR 0002: Domain tool groups and Carrier-backed task results

- Status: Accepted
- Related: [Suite composition](0001-suite-composition.md)

## Decisions

Keep one Orchestration MCP package with SDK-free domain contracts in `tool_groups/`:
conversations, tasks, workflows, observations, queues and native terminals.
`execution_tools.py` remains an import compatibility facade. `shared` is the
existing discovery/observation alias. Select groups explicitly for each connection;
transport mode and capability availability still gate their tools.

Carrier owns durable inter-agent messages, publication retry keys and inbox
acknowledgments. Conversation Manager owns chat delivery queues. Runner owns task
scheduling and workflow dependencies. Orchestration owns assignment identity,
execution associations, result correlation and acceptance. Do not add another
messaging system, prompt queue or Python workflow scheduler.

New delegated tasks use a versioned task/attempt identity and a dedicated Carrier
sender/receiver pair. A child gets a private one-tool MCP instance from this same
package: `submit_task_result`. Its authenticated identity, task, attempt and
recipient come from its private host-created context, never tool arguments.
Generic agent messaging continues to use Carrier's existing SDK/MCP.

The host accepts a result only after checking Carrier's authenticated sender,
recipient and the task/attempt envelope. Acceptance and its receipt/event commit
in one SQLite transaction before acknowledging Carrier. A lost acknowledgment is
retried by its recorded message ID even if Carrier's pending inbox is already
empty. Publication has one stable retry key per attempt: a repeated identical
result returns the original message; changed content conflicts.

Final chat text, JSON in a final answer, report files and successful process exit
cannot complete new tasks. Execution failure can fail a task without a report;
that observation is labeled `failure_source=execution` and has no fabricated
result. A task report is an accepted claim, not proof of correctness. Verification
can be a separate dependent task.

Keep task outcome and execution lifecycle separate. An accepted result does not
implicitly terminate its conversation/process. Missing reports leave normally
finished executions in `awaiting_report`. Cancellation rejects late results.

Persistent hosts restore a bounded report-consumption monitor. Parents inspect
accepted results and cursor-based task events through their authorized context.
Suite child contexts do not inherit the parent's orchestration endpoint. Native
finite tasks without MCP delivery receive an explicit scoped result-helper argv.
The helper still publishes through Carrier and does not inspect provider output.

## Configuration and limits

Provisioning currently requires an explicit `CARRIER_DATABASE` and its matching
`CARRIER_URL`. Identity checks verify both endpoints before dispatch. Missing
Carrier hides delegation/submission tools while ordinary chat/terminal operations
remain independent. Existing tasks retain their original private endpoint context
across host restarts; they never fall back to another service.

Reports are bounded; larger outputs use artifact references. References and hashes
are metadata, not automatic file reads or integrity verification.

This milestone does not implement model-driven supervisor mandates, generalized
workflow draft editing, automatic parent-turn injection or automatic publication
of aggregate Runner results into a human inbox. Those should build on the accepted
Carrier task contract and the existing owners rather than creating substitutes.

## Evidence

Tests exercise a real disposable Carrier service, actual MCP stdio submission,
real Runner/Undercurrent fixture executions, host restart, publication/ACK loss,
wrong senders/attempts, cancellation, independent execution state, and Suite's
captured task/workflow tool context. No real model accounts or production stores
are needed. These fixtures do not establish live provider/model qualification.
