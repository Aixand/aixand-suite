# Web implementation status

A retained component or fixture test establishes a frontend contract. Availability of its Server handlers and downstream services must be checked separately.

## State and boundaries

| Concern | Contract |
| --- | --- |
| Core workspace | App, authentication, chat, resources and terminal source exist; qualify runtime behavior against the selected host. |
| Supervision | Command UI remains; the current agent-bridge Adapter explicitly rejects command operations. |
| Connect remote work | Remote chat/project run/comparison UI remains while corresponding legacy Server handlers are absent. |
| Native workflows | Retained native workflow UI is not the current Runner gateway; inspect the requested execution path. |
| Conversation tools | Normalized conversation tools exist, but removed legacy orchestration services are not restored by a Web view. |
| Vox | Capability gating is implemented; live audio/provider availability needs separate qualification. |

See the [Server implementation status](../../server/docs/implementation-status.md) for the corresponding current-source gaps.

## Source and verification

[src/command/supervision.ts](../src/command/supervision.ts), [src/connect/RemoteChatDialog.tsx](../src/connect/RemoteChatDialog.tsx), [src/workflows/builder/useNativeWorkflowRun.ts](../src/workflows/builder/useNativeWorkflowRun.ts).

