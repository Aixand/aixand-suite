# Implementation status and integration gaps

This map describes the inspected checkout, not a release certification. The companion and retained sender library have concrete implementations. Current Server routing, UI schemas and historical documentation must not be combined into an unsupported claim of working remote orchestration.

| Subsystem | Present source | Gap or interpretation |
| --- | --- | --- |
| Pairing and file receiving | [companion.py](../../aixand_connect/companion.py), [protocol.py](../../aixand_connect/protocol.py) | Real bounded receiver API; network policy and actual tunnel reachability remain external |
| Sender registry/transfers | [service.py](../../aixand_connect/service.py) | Embeddable implementation, not independently proof of active Server wiring |
| Direct Codex | [codex.py](../../aixand_connect/codex.py) | Device-local native process API; current Suite remote-chat adapter absent; Windows native execution unverified |
| Managed conversations | [manager_helper.py](../../aixand_connect/manager_helper.py), [managers.py](../../aixand_connect/managers.py) | Conversation Manager retained worker implementation; incompatible older route bindings explicitly rejected |
| Snapshot/workspace | [snapshot.py](../../aixand_connect/snapshot.py), [project_workspace.py](../../aixand_connect/project_workspace.py) | Build, verify and publish source; no project matrix scheduling or parent report implementation here |
| Download | [connect.module.ts](../../../../apps/server/src/connect/connect.module.ts) | Current Server endpoint serves existing archive |
| Suite requests | [protocol.ts](../../../../apps/server/src/agents/protocol.ts) | Retains pairing/transfers, inspections, project copy/start/compare and activity schemas; validation is not dispatch |
| Bridge dispatch | [main.py](../../../../apps/server/agent-bridge/main.py), [chats.py](../../../../apps/server/agent-bridge/application/chats.py) | `connect-*` forwards to chat store, but current chat implementation has no corresponding legacy Connect handlers |
| Web projections | [Connect module guide](../../../../apps/web/docs/modules/connect.md) | Device/transfer/remote-chat/comparison components and fixtures remain; backend availability separate |

## Device trust

The companion validates private IPv4 literals and pairs one device credential; tunnel confidentiality and policy are external. See [pairing and trust](../architecture/trust.md) for credential replacement, identity pinning and direct HTTP constraints.

## Transfer outcomes

Verified publication requires a matching receipt. Lost acknowledgment stays uncertain; no offset resume or automatic replay is implemented. Cancellation preserves already delivered files. See [transfer lifecycle](../lifecycles/transfers.md).

## Remote execution

The companion implements [direct Codex sessions](../integrations/direct-codex.md), [managed conversations](../integrations/managers.md) and [snapshot publication](../lifecycles/projects.md). Current Server orchestration does not supply the removed remote-chat/project-run integration. A prepared workspace or retained native turn is not an accepted parent report.

## Historical contracts to preserve without overstating

The [receiver setup](../development/setup.md) retains launch commands and a scoped human qualification procedure. [Retained UI examples](retained-ui.md) preserve useful prompts, labels and a provenance-qualified historical note. The [Server integration guide](../../../../apps/server/docs/integrations/connect.md) owns remote chat/project/comparison and parent-return contracts. None is new evidence of current end-to-end availability.

In particular, comparison target selection, project-run check/cancel, workflow/deleted-conversation activity inspection and return-to-parent reports need current Server orchestration and integration qualification. Companion session UUIDs and workspace receipts alone cannot establish those application associations. The receiver has no independently implemented remote job scheduler in this tree.

Older descriptions of managed chats requiring Server Manager, Undercurrent-backed chat runtime or explicit quota ranking differ from the current helper. Current selection delegates to Agent Manager; current worker ownership uses Conversation Manager local IPC. Undercurrent remains relevant to other Suite terminal paths, not this helper's readiness check. Optional explicit resources require compatible orchestration resource capture; no automatic fallback to direct/native credentials is implemented.

## Qualification rule

| Evidence | Safe conclusion |
| --- | --- |
| Schema or documentation | Retained contract only |
| Source plus fixture test | Tested boundary under fixture/environment constraints |
| Archive built and inspected | Packaging composition, not platform execution qualification |
| Live device/provider record | Only that recorded version, device and result |

Read [verification](../development/verification.md) and [Server status](../../../../apps/server/docs/implementation-status.md) before changing availability language. No migration, dependency installation or live-provider action was added by this documentation work.
