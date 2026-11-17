# Use managed chat commands

The local beta uses Conversation Manager for Codex and OpenCode chats. The active
session advertises its command catalog and settings. Open a configured chat and
type `/` to inspect available actions; disabled entries retain their reason.
An advertised reference entry is not necessarily executable.

## Choose a setting

Use the command picker or model panel to choose a value supported by the active
session. Changes can require an idle session. The confirmed setting comes from
Conversation Manager, not a cached draft model catalog. Retry preserves the exact
selected value and operation identity. A model list does not establish entitlement.

Provider-native commands execute through the retained Conversation Manager
session. Suite does not synthesize provider RPC names or start a replacement
terminal when a managed operation is unavailable. Terminal-only references remain
unsupported in managed chat.

## Preserve intent and recovery

Follow-ups, approvals, questions and cancellation use the retained conversation
and turn identities. Inspect unconfirmed work before retrying. Reopening a saved
chat restores its exact native session where supported; it does not resend prior
messages or commands. See [application recovery](../../server/agent-bridge/application/README.md).

Resource libraries are independent of profiles. Choose supported managed
instructions and MCP tools explicitly for a new chat. Native skill delivery and
advanced workflow behavior require separate qualification. See
[agent integration](../../../docs/development/agent-integration.md) and
[Conversation Manager integration](../../../docs/development/conversation-integration.md).

The owning implementations are the [command catalog UI](../src/chats/commands.ts)
and [Suite chat adapter](../../server/agent-bridge/application/chats.py).
