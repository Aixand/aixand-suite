# Conversation integration

Conversation Manager owns transcripts, turns, queues, requests, settings,
commands, and workers. Suite calls it through Orchestration MCP ExecutionServices
and retains application associations/operation IDs.

Agent Manager owns providers, environments, profiles, model catalogs, and launch
selection. Draft catalog discovery uses provider, environment, and project.
Connected session settings remain authoritative.

## Commands and recovery

Project the active session's command catalog, preserving availability, unsupported
reasons, setting IDs, argument hints, idle requirements, and scope/completeness.
Only ready, available entries are actionable. Execute through Conversation Manager;
do not invent provider RPC names or launch replacement terminals.

Capture exact native identities and operation inputs. Unsupported launch options
fail before effects. Reconnect the retained session without replaying messages.

## Sources and checks

- [Chat composition](../../apps/server/agent-bridge/application/chats.py)
- [Request protocol](../../apps/server/src/agents/protocol.ts)
- [Boundary tests](../../apps/server/agent-bridge/tests/test_chat_manager_boundary.py)
- [Application recovery](../../apps/server/agent-bridge/application/README.md)

User guide: [conversations](../guides/conversations.md).
