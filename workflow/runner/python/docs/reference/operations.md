# Operation map

All methods below call the same synchronous request path. Parameters not described as client defaults are transmitted unchanged. Return values are decoded JSON, not dataclasses. Engine and state validation belong to Runner.

## Admission and observation

| Python call | Wire fields | Returned value |
| --- | --- | --- |
| `health()` | `op=health` | service, version, protocol, engine_digest, workers, capabilities |
| `submit(workflow, inputs=None, *, key, metadata=None)` | `op=submit`, nested submission | `{job, replayed}` |
| `list(*, after=0, limit=100)` | `op=list`, after, limit | `data.jobs` array only |
| `inspect(job_id)` | `op=inspect`, id | Full Job |
| `lookup(key)` | `op=lookup`, key | Job or null |
| `result(job_id)` | `op=result`, id | Result projection |
| `events(job_id, *, after=0, limit=100)` | `op=events`, id, after, limit | Event page |
| `follow(job_id, *, after=0, poll_interval=0.25)` | Repeated `events` requests with default limit | Generator yielding individual retained events |

`list.after` is a job sequence; `events.after` is an event sequence. Runner requires nonnegative cursors and limits of 1–500. `list()` discards the response wrapper and does not automatically fetch another page.

## Control, edits and continuations

| Python call | Wire operation and fields | Return/meaning |
| --- | --- | --- |
| `cancel(job_id)` | `cancel`, id | Updated Job; cancellation request is not rollback |
| `cancel_key(key)` | `cancel_key`, key | Job or null; prevents late admission under that key |
| `resume(job_id)` | `resume`, id | Job after supported reconciliation admission |
| `plan(job_id)` | `plan`, id | Plan snapshot |
| `amend(job_id, workflow, *, key, expected_revision, authoring=None)` | `amend`, id, key, expected_revision, workflow, authoring | Amendment receipt from Runner |
| `hold(job_id)` | `hold`, id | Held plan snapshot |
| `enable_edits(job_id, *, key, authoring=None, groups=None, identities=None)` | `enable_edits`, id, key, authoring, groups, identities | Adopted/existing plan snapshot; maps default to `{}` |
| `release(job_id)` | `release`, id | Released plan snapshot |
| `continue_with(job_id, target, *, key, input_map=None)` | `continue`, id, key, target, input_map | Continuation record; input_map defaults to `{}` |
| `continuations(job_id)` | `continuations`, id | `data.continuations` array only |
| `cancel_continuation(continuation_id)` | `cancel_continuation`, id | Continuation record |

`target` is a complete submission object, including its own key, workflow, inputs and metadata contract; it is not just a workflow. Runner validates then replaces its admission key with a deterministic continuation identity. The registration key and parent ID identify the continuation.

`request(op, **fields)` also exposes protocol operations without wrappers. Runner has `runs` with offset/limit, but Python has no `runs()` convenience method. Unknown operations/fields are service errors, not a client extension registry.

Source: [all wrappers](../../runner_client.py), [tagged request enum](../../../src/model.rs), [dispatch and return shapes](../../../src/service.rs), [plan receipts](../../../src/plans.rs). Continue with [plan lifecycle](../lifecycles/plans.md).
