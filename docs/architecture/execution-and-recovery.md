# Execution and recovery

Interpret each receipt by what it confirms:

| Observation | Confirms |
| --- | --- |
| Launch/submission receipt | Operation accepted or recorded |
| Runtime ready | Process can accept input |
| Finished turn/process | Execution ended |
| Accepted task report | Authenticated result claim for that task/attempt |
| Delivery receipt | Addressed message delivered/accepted as specified |
| Verified result | Evidence satisfies the requested checks |

A completed workflow can return `passed: false`. Final chat text, report files,
and zero exit codes do not replace a delegated task's required report.

## Task reports

Each child gets a scoped reporter. Sender, recipient, task, and attempt come from
private host context. The host validates them and commits acceptance before
acknowledging Carrier.

Each attempt has a stable publication retry key. Identical retries return the
original message; changed content conflicts. Lost acknowledgments use the retained
message identity.

A finished execution without a report can remain `awaiting_report`. Execution
failure can fail a task without inventing a report. Accepted reports do not stop
the process or prove their claims correct. See the
[task contract](../../mcps/orchestration/docs/delegation-workflows.md).

## Retry and cancellation

Keep operation IDs, targets, captured resources, and receipts across retries.
After an event gap, refresh the authoritative snapshot. Inspect uncertain work
before resubmitting; a timeout does not prove no effect occurred.

Cancellation is cooperative and does not roll back effects. Cancelled tasks reject
late reports. Shared workers require explicit owner-aware handling.

Resumable native workflows reconcile checkpoints and existing chats. Opaque SDK
and standalone IR executions may remain uncertain after interruption; they do not
support generic replay.

[Runner outcomes](../../workflow/runner/README.md#outcomes-and-restart-behavior) ·
[Application recovery](../../apps/server/agent-bridge/application/README.md)
