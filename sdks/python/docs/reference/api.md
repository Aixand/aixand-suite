# Public API and contract map

The public surface is deliberately small. This table maps the names exported by [__init__.py](../../src/aixand/__init__.py) to their actual implementation; it does not define a second client object or a Runner facade.

## Operations

| Public surface | Inputs and result | Owner |
| --- | --- | --- |
| `connect(**options)` | Synchronous construction of optional `Connection`; async context supported | [_connection.py](../../src/aixand/_connection.py) |
| `close(connection=None, stop_agents=None)` | Close selected or existing per-loop default; does not create default | [_connection.py](../../src/aixand/_connection.py) |
| `agents.spawn(...)` | Provider/profile/native launch; `Agent` on known successful setup | [agents.py](../../src/aixand/agents.py) |
| `agents.get(run_id, provider="codex", ...)` | Cached/attached `Agent`; no binding reconstruction | [agents.py](../../src/aixand/agents.py) |
| `agents.restore(run_id, manifest=..., ...)` | Same live external Carrier binding under strict evidence checks | [agents.py](../../src/aixand/agents.py) |
| `agents.profiles(...)` | Native manager result | [agents.py](../../src/aixand/agents.py) |
| `agents.budgets(auth=None, ...)` | Native manager result | [agents.py](../../src/aixand/agents.py) |
| `messaging.mailbox(address, credentials=None, ...)` | Native `carrier.Client`; ordinary application ownership | [messaging.py](../../src/aixand/messaging.py) |

`Agent`, `Connection`, and `CarrierConfig` are exported types. `InputReceipt` is re-exported from Undercurrent without conversion. Exported errors are `AixandError`, `ConnectionClosed`, `ConsumerError`, `AcceptanceTimeout`, `DeliveryUncertain`, and `AgentSetupError`. The old `IntessioError` alias exists in [errors.py](../../src/aixand/errors.py) but is not in package `__all__`.

## Handle and scope inspection

| Object | Surface | Contract |
| --- | --- | --- |
| Agent | `run_id`, `session_id`, `provider`, `profile`, `labels` | Manager identity and copied labels |
| Agent | `metadata()` | Explicit manager metadata read |
| Agent | `address`, `consumer_active` | Optional binding identity and currently active consumer task |
| Agent | `last_receipt` | Last successful direct input with revision |
| Agent | `send`, `wait`, `inspect`, `read_screen`, `stop` | [Lifecycle contracts](../lifecycles/agent-lifecycle.md) |
| Connection | `context`, `with_context` | Context defaults and borrowed views |
| Connection | `agents`, `errors`, `closed`, `directory` | Local handles, consumer failures, lifetime, evidence location |
| Connection | `open`, `runtime`, `manager` | Lazy resource access; native client returned |
| Connection | `check`, `wait_for`, `close` | Scope health, supervised await, cleanup |

`CarrierConfig(url="http://127.0.0.1:8765", database=None, mode="external")` validates mode as external/private. `CarrierConfig.private()` selects the owned local service. Duration validation rejects booleans, nonfinite numbers and negatives; zero is allowed only for connection `stable_for`. Underlying observation calls validate their own per-call readiness options.

There is no conversation-history CRUD, message store wrapper, prompt/skill/resource CRUD, workflow submission, or automatic task-result extraction here. Conversation interaction means native agent sessions; ordinary message operations come from the returned Carrier client. See [native configuration limits](../integrations/native-launch.md) before interpreting retained launch parameters as supported resource APIs.
