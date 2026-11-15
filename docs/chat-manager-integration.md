# Chat manager integration and reconciliation

## Ownership

Conversation Manager owns connected conversations: history, turn lifecycle,
queues, requests, effective session settings, slash-command discovery and command
execution. Suite calls its public SDK through orchestration-mcp ExecutionServices.
Suite retains presentation metadata and operation identities so retries target the
same conversation and operation.

Agent Manager owns provider knowledge, native model catalogs, environments,
profiles and launch selection. Draft model discovery uses the selected provider,
environment and project directory. A model catalog does not authorize commands or
confirm effective settings on a running conversation. Connected session settings
remain authoritative for changes to that session.

The UI projects the current Conversation Manager slash catalog. It preserves
availability, unsupported reasons, setting identifiers, argument hints, idle
requirements and source/scope/completeness metadata. Only ready, explicitly
available native or setting entries are actionable. A terminal reference remains
unsupported in managed chat; it does not launch a replacement provider process.
Session command execution still goes through Conversation Manager, which validates
current support when executing. Suite does not construct provider RPC names.

## Source and verification boundaries

[Suite chat composition](../apps/server/agent-bridge/application/chats.py)
projects public catalogs and captures provider/environment/project selections.
The [request protocol](../apps/server/src/agents/protocol.ts) validates transport
inputs. The [boundary tests](../apps/server/agent-bridge/tests/test_chat_manager_boundary.py)
exercise ownership. [Application recovery](../apps/server/agent-bridge/application/README.md)
explains exact-session reconnection and retained operation intent.

Onboarding must publish native profile/environment identities rather than a
second provider store. Catalog discovery does not grant execution permission or
model entitlement. Commands remain gated by current session capabilities.
Unsupported launch options fail before effects; no replacement provider process
should be created to emulate an unavailable managed-chat operation.
