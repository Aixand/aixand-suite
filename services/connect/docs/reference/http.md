# Transport and message contracts

The companion serves protocol 1 JSON control requests and fixed-length binary uploads. All operations except pairing require the saved bearer credential. Operation path IDs use canonical lowercase UUID strings, checked by parsing and exact string comparison.

| Method and route | Input | Result or constraint |
| --- | --- | --- |
| `POST /v1/pair` | Pair code bearer; `{token}` body | Receiver info; 1–2048 body bytes |
| `GET /v1/info` | Device bearer | `protocol`, `instanceId`, `receiveDir`, `os`, `maxBytes`, capabilities |
| `POST /v1/validate` | `{name,size}` | `{ready:true}`; advisory check, not a filename reservation; 1–2048 bytes |
| `PUT /v1/transfers/{id}` | Bytes, `Content-Length`, percent-encoded `X-Filename`, lowercase `X-SHA256` | Persistent receipt; no replay of existing ID |
| `GET /v1/transfers/{id}` | UUID | Receipt, or HTTP 404 if never received |
| `DELETE /v1/transfers/{id}` | UUID | Cancellation observation/tombstone; does not delete a completed file |
| `GET /v1/codex/status` | None | Installed/authenticated/version/roots; cached 30 seconds |
| `POST /v1/codex/directory` | `{cwd}` | Validated directory and readiness |
| `POST /v1/codex/sessions/{id}` | `{cwd}` | Ensure/resume live direct session |
| `GET /v1/codex/sessions/{id}` | Optional `turnId`, `operationId` query | Read-only retained observation; never ensure/resume |
| `GET /v1/codex/sessions/{id}/events` | `after` integer query | Snapshot, sequence events, generation and `gap` |
| `POST /v1/codex/sessions/{id}/rpc` | `{key,method,params}` | `{result}` or `{rpcError,uncertain}` |
| `POST /v1/codex/sessions/{id}/respond` | `{key,requestId,result}` | Journaled native answer |
| `GET /v1/managers` | None | `aixand-connect/managers-1` inventory |
| `POST /v1/managers/sessions/{id}` | Exactly `{method,args}` | Managed facade result or RPC uncertainty |
| `GET /v1/projects/{id}` | UUID | Workspace receipt or `{id,status:"missing"}` |
| `POST /v1/projects/{id}` | Exactly `{transferId,sha256,snapshotId}` | Prepared workspace; 1–4096 bytes |

Codex POST and manager session bodies are limited to 256 KiB. Requests reject transfer encoding and duplicate Content-Length headers. Control responses are connection-close JSON. Unknown transfer routes return 404 and unsupported transfer methods 405; validation errors generally map to 400, authentication to 401, filesystem failures to 500. An HTTP 200 can contain a failed transfer receipt or RPC error: inspect the body, not just HTTP success.

## Bounds and portable names

| Value | Constraint |
| --- | --- |
| Shared JSON response read | At most 2 MiB; non-2xx error text truncated to 300 characters |
| Streaming chunk | 256 KiB |
| File source | Regular file, at most 20 GiB in sender |
| Receiver limit | Default 20 GiB; CLI `--max-gib` permits 1–1024, independent of sender cap |
| Filename | At most 200 UTF-8 bytes; no separators, controls, trailing dot/space, Windows device names, or `.aixand-connect` prefix |
| Direct mutation key | Canonical UUID; signature must match prior method/arguments |
| Managed mutation identity | `suite-send:`, `suite-cancel:`, `suite-answer:`, `suite-command:`, `suite-config:` or `connect-create:` plus constrained UUID-shaped suffix |

[Handler](../../aixand_connect/companion.py) is the wire authority. [protocol.py](../../aixand_connect/protocol.py) supplies bounded client requests and portable validators; [codex.py](../../aixand_connect/codex.py) and [managers.py](../../aixand_connect/managers.py) add method-specific checks. Use [test_connect.py](../../tests/test_connect.py), [test_codex.py](../../tests/test_codex.py) and [test_managers.py](../../tests/test_managers.py) as executable contract examples.
