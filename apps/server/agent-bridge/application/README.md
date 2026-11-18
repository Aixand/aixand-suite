# Suite application services

The JSONL entry point dispatches managed operations to `chats.SuiteChats.execute`.
This directory owns Suite chat associations, UI operation intent, resource
composition (`resources.py`) and scoped tool context (`tools.py`). Conversation
Manager owns transcripts, queues, settings, requests and worker lifecycle.

| Read or change | Canonical guide / source |
| --- | --- |
| Saved defaults, automatic approvals and unread markers | [Conversation lifecycle](../../docs/lifecycles/conversations.md) |
| Saved-chat reconnect and exact-session restore | [Recovery](../../docs/lifecycles/conversations.md#recover-or-remove) |
| Native onboarding and profile readiness | [Onboarding contract](../../../../docs/development/onboarding.md), `onboarding.py` |
| Conversation read and mutation scope | [Conversation tools](../../docs/integrations/conversation-tools.md) |
| Workspace persistence and projects | `chat_state` imported by [chats.py](chats.py), [projects.py](services/projects.py) |
| Execution adapter and remaining Orchestration dependencies | [Manager boundaries](../../docs/integrations/managers.md), [Suite architecture](../../../../docs/architecture/README.md) |

Suite MCP conversation reads can target confirmed chats retained in the same
workspace by UI chat ID or execution ID. Reads grant no mutation ownership;
task, terminal, workflow and operation access remain scoped to the originating
tool context. Unknown chat IDs are denied.

Workspace persistence and project behavior are local Suite application concerns.
The reusable execution SDK adapter remains in Orchestration MCP; this boundary
does not establish complete separation or full orchestration qualification.
