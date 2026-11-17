# Agent and resource integration

| Area | Owner | Suite responsibility |
| --- | --- | --- |
| Providers/environments/profiles | Agent Manager | Inventory, readiness, native administration |
| Chats/turns/approvals/queues | Conversation Manager | Application associations and controls |
| Prompts | Prompt Manager | Authoring, import, review, selection |
| Skills | Skill Manager | Library lifecycle; preserve delivery limits |
| MCP definitions/preparation | MCP Manager | Definitions and project-path resolution |
| New-chat resources | Suite over resource owners | Explicit capture and provenance |

Profiles do not own prompt/skill/MCP bindings. Library changes do not update
running chats or rewrite provider instruction files. Native skill delivery to
managed chats still needs qualification.

Library bridges use `PROMPT_MANAGER_HOME`, `SKILL_MANAGER_HOME`, and
`MCP_MANAGER_HOME`, independently of profile homes. Existing stores are not moved
or imported automatically. Prompt creation/import uses `create_managed` and
`import_local`; retained source jobs use their owning manager's IDs and recovery.

## Native sign-in while chats are retained

Suite queues an environment-scoped handover before login. New independent chats
and messages wait; existing work, approvals, queues, and delegated children can
finish. Cancelling sign-in releases the restriction without cancelling that work.

Conversation Manager's `signin_handover_version: 1` contract provides:

| API | Behavior |
| --- | --- |
| `signin_activity` | Read-only preflight; existing child admission stays open |
| `prepare_signin_stop` | Seals an idle worker after checking turns, requests, queues, threads, goals, and background commands |
| `cancel_signin_stop` | Releases the matching operation's seal |

Missing observations do not authorize stopping a worker. Suite persists exact
worker identities and confirms termination before login. Retained chats restore
without replaying prompts. Shared servers, external terminals, and remaining
Agent Manager leases remain explicit blockers.

Older workers require a component update or explicit closure. Update Server,
Agent Manager, and Conversation Manager together. The login terminal action is
available only in the interactive phase. Handover survives bridge restart using
the same operation ID.

## Preserve retained environments when removing aliases

Deleting a profile removes its alias, not its native environment or retained
execution references. Keep the manager's deletion receipt; never mark chats
unavailable by matching a reused display name. Environment/data removal is separate.

Verification uses disposable stores, browser fixtures, protocol/chat capture
checks, and mobile accessibility checks; it does not log in to real providers.

[User resources guide](../guides/resources.md) · [Conversations](../guides/conversations.md)
