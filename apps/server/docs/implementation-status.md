# Server implementation status

Use this map to distinguish current source entry points from retained integration
contracts. It records this checkout's source coverage, not installed-release or
live-provider qualification.

| Area | Current evidence | Documentation consequence |
| --- | --- | --- |
| Core conversations | [SuiteChats](../agent-bridge/application/chats.py) uses execution/Conversation Manager APIs | Follow actual normalized conversation capabilities and receipts |
| Scoped orchestration | [Tool adapter](../agent-bridge/application/tools.py) uses backend/broker APIs | Inspect captured context; do not infer legacy resource defaults |
| Runner transport | [Jobs gateway](../src/workflows/jobs.gateway.ts), [workflow adapter](../agent-bridge/application/workflows.py) | Transport presence does not qualify every legacy native effect |
| Connect | [Companion](../../../services/connect/aixand_connect/companion.py) exists; legacy Server remote-chat/project adapters are absent | Keep companion behavior separate from unqualified Suite orchestration claims |
| Legacy shared chat tools | [Retained JSON contract](../../../mcps/orchestration/src/orchestration_mcp/contracts/aixand_conversations.json); older service/stdio adapter absent | Legacy automatic returns and follow-up semantics require requalification |
| Current conversation tool catalog | [Conversation Manager tools](../../../mcps/orchestration/src/orchestration_mcp/tool_groups/conversations.py) | Use advertised normalized operations rather than assuming legacy tool transport |
| Supervision | [Bridge dispatch](../agent-bridge/main.py) rejects `command-*`; legacy automation source/test absent | Retained monitor contract is not an implemented runtime claim |
| Default resource presets | Bridge rejects `suite-resource-presets`; legacy service implementation absent | Verify supported launch-resource paths and actual tool assessment |
| Carrier | [Service](../src/carrier/carrier.service.ts) and [bridge](../carrier-bridge/main.py) exist | Inspect SDK/interpreter and configured dataset; historical live evidence is not a new test result |

## Validation rule

| Evidence | Establishes |
| --- | --- |
| Retained documentation or schema | A described contract; implementation still needs a traced handler |
| Source handler and meaningful tests | Coverage of the tested boundary and environment |
| Fixture pass | Only the exercised fixture behavior |
| Live/provider/native run | Only its recorded target, credentials, version, and outcome |

Missing handlers or tests remain explicit gaps. Do not recreate old architecture
from prose, silently fall back to another execution route, or claim a test passed
because its command is documented.

[Server documentation](README.md) · [Source map](development/README.md)
