# Reconnect and crash recovery

Recovery keeps workspace failures visible and lets readers return to authoritative state without silently repeating work.

```mermaid
flowchart LR
  accTitle: Reconnect and crash recovery
  accDescr: Recovery keeps workspace failures visible and lets readers return to authoritative state without silently repeating work.
  Failure[Disconnect or render failure] --> Notice[Visible recovery state]
  Notice --> Inspect[Diagnostics and recovery choice]
  Inspect --> Reload[Reconnect or reload state]
  Reload --> Workspace[Resume workspace]
```

## State and boundaries

| Concern | Contract |
| --- | --- |
| Socket recovery | Use each feature connection lifecycle. Transport recovery does not prove execution completion. |
| Crash recovery | RecoveryHost and diagnostics expose component failures; installCrashCapture starts before App. |
| User intent | Keep uncertain submissions distinguishable from confirmed failures and completed work. |
| Host change | Invalidate old consumers; do not resume an old host action against the new host. |

## Source and verification

[src/recovery/RecoveryHost.tsx](../../src/recovery/RecoveryHost.tsx), [src/recovery/diagnostics.ts](../../src/recovery/diagnostics.ts), [src/auth/recovery.ts](../../src/auth/recovery.ts).

Relevant checks: [recovery.spec.ts](../../tests/recovery.spec.ts), [chat-recovery.spec.ts](../../tests/chat-recovery.spec.ts), [terminal-recovery.spec.ts](../../tests/terminal-recovery.spec.ts). Fixture tests verify presentation and interaction; they do not establish live service availability.
