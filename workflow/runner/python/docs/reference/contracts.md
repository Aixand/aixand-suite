# Wire values and serialization

`request(op, **fields)` serializes `dict(op=op, **fields)` using `json.dumps(..., allow_nan=False)`, encodes the JSON and appends a newline. Runner strictly parses a tagged request enum. The client has no typed model layer or independent schema validation.

## Frame contract

| Direction | Contract | Rejection boundary |
| --- | --- | --- |
| Request | One UTF-8 JSON line, at most 4 MiB including client-added newline | Client raises `ValueError` before connecting if too large |
| Response | Read at most 16 MiB + 1 bytes; require newline and total length at most 16 MiB | Client raises `ValueError("Invalid or oversized Runner response")` |
| Success | `{"ok":true,"data":...}` | Client returns `data` without type conversion |
| Failure | `{"ok":false,"error":{"code":"...","message":"...","details":...}}` | `RunnerError` stores code/details; exception text is `code: message` |

Runner bounds serialized response JSON before adding its newline. The Python check includes the newline, so a response JSON exactly at the service limit can still be rejected by the client. Large event pages should be reduced; use references for large artifacts.

Python's encoder rejects nonfinite float values and unsupported objects before IPC. Use JSON-compatible dicts, lists, strings, numbers, booleans and `None`; paths, datetimes and SDK handles have no custom encoder. Python does not enforce string-only mapping keys or numeric ranges beyond encoder behavior. Runner validates the resulting schema. Response decoding uses plain `json.loads`; there is no explicit duplicate-key, strict-number or full-envelope validation in the client.

## Submission contract

| Field | Client behavior | Runner validation/ownership |
| --- | --- | --- |
| `key` | Required keyword-only argument | Nonblank text, at most 256 bytes; admission identity |
| `workflow` | Passed unchanged | Engine preflight validates supported workflow |
| `inputs` | `None` becomes `{}` | Must be JSON object |
| `metadata` | `None` becomes `{}` | Must be JSON object; retained in digest |
| `metadata.agent_context` | Passed unchanged | Only labels/metadata string maps, at most 64 entries each; keys at most 64 bytes, label values 256 bytes, metadata values 4096 bytes; no controls or reserved `agent_manager.*` keys |

Keep secret runtime configuration outside submissions: Runner retains inputs and metadata. The service computes a canonical SHA-256 digest; Python does not compute an admission digest from its own serialization.

## Returned records

| Record | Fields callers can inspect |
| --- | --- |
| Job | `sequence`, `id`, `state`, `submission`, `request_digest`, `engine_digest`, nullable `attempt_id`, `created_at`, `updated_at`, `cancel_requested`, nullable `result`, nullable `error` |
| Job summary | `sequence`, `id`, `key`, `state`, timestamps, `cancel_requested` |
| Event | `sequence`, `job_id`, `recorded_at`, `kind`, JSON `data` |
| Event page | `events`, `state`, `next_after`, `has_more` |
| Result projection | `id`, `state`, nullable `result`, nullable `error` |

Timestamps are Unix milliseconds. Sequences are cursors; job sequence and event sequence have separate uses. Optional values decode as `None` when represented by JSON null. A successful `result()` request can report a failed or uncertain job without raising `RunnerError`.

Source: [Python framing](../../runner_client.py), [Rust models and limits](../../../src/model.rs), [service envelopes](../../../src/service.rs), [error shape](../../../src/error.rs).
