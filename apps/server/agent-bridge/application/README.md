# Suite application services

The bridge's JSONL entry point dispatches managed conversation operations to
`chats.SuiteChats.execute`. This directory owns Suite chat associations and UI
operation intent, resource composition (`resources.py`), and scoped Suite tool
context (`tools.py`). Native onboarding and public Agent Manager profile/readiness
adaptation live in `onboarding.py`; see
[the onboarding contract](../../../../docs/development/onboarding.md). Conversation Manager
remains authoritative for transcripts,
queues, settings, requests and worker lifecycle.

Suite MCP conversation reads can target any confirmed chat retained in the same
Suite workspace, using its UI chat ID or execution ID. Reading does not grant
ownership: conversation mutations and task, terminal, workflow and operation
access remain scoped to the originating tool context. Unknown chat IDs are denied.

This application boundary is described in
[Suite architecture](../../../../docs/architecture/README.md). The reusable execution SDK
adapter remains in Orchestration MCP. Workspace persistence and project behavior
still imported from that package need consumer refactoring. These boundaries do not establish complete separation
or full orchestration qualification.

`behavior.py` applies saved Agent behavior settings through the public SDK.
The settings retain their existing workspace database tables and revisions.
New Codex chats and Suite worker contexts capture the saved default access.
An explicit launch value takes precedence. Existing chats keep their access.
The Manual default requires an explicit value before a new launch.

Automatic approval acts on known permission requests in retained SDK chats.
It uses a stable operation ID for each request. It leaves questions and unknown
requests for the user. Failed delivery stays visible for a manual response.
The saved switch also applies to pending requests and restored background chats.
Legacy chat records remain read-only.

Opening a saved chat calls `ExecutionServices.reconnect_conversation` before it
reads live state. This operation checks the recorded process owner. If that
owner has stopped, Conversation Manager restores the exact native session.
The binding retains its Suite ID and updates its worker reference. History and
confirmed settings remain in place. Restore does not resend messages or commands.
Background observers report stopped workers without waiting for an IPC timeout.
They do not start replacement workers for every saved chat after a reboot.

Unread completion state belongs to Suite presentation metadata. Successful results
persist `latestCompletedTurnId`; `chat-mark-read` records `lastReadTurnId` only when
the acknowledged turn is still the latest completion. The workspace account shares
this state across devices through the existing chat update broadcast. The web
reader acknowledges a completion only while visible, focused, and at the latest
loaded response. Failed and cancelled results do not create unread success markers.
