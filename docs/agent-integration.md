# Agents page integration

The Agents page composes independent managers. Its navigation groups profiles and
native session history alongside resource libraries; navigation does not imply
that Agent Manager owns those libraries.

| Area | Authoritative owner | Suite responsibility |
| --- | --- | --- |
| Providers, installation, accounts, profiles, model defaults, native runs | Agent Manager | Present inventory, readiness and guarded administration; link native terminals |
| Chat startup, turns, history, approvals and delivery queues | Conversation Manager | Compose Codex/OpenCode chats and retain application associations |
| Prompt packs, managed copies, immutable versions, app integrations | Prompt Manager | Present authoring, local creation/import, review and selection |
| Skill content, releases, source imports and retained source jobs | Skill Manager | Present its library and lifecycle without claiming unsupported chat delivery |
| MCP definitions, reconciliation, preparation and source jobs | MCP Manager | Present definitions and resolve registered Suite project IDs into paths |
| Per-chat resource selection and captured provenance | Suite composition over the resource owners | Capture explicit selections before Conversation Manager startup |

Profiles do not own prompt, skill or MCP bindings. Profile settings edit accounts
and supported model defaults without reading any resource store. Resource library
links respect the same unsaved-change guard as profile navigation. New chats select
managed instructions and MCP tools explicitly. Existing chats retain their captured
configuration; changing the library does not update a running chat.

The library bridges construct their owning managers directly. They use the same
manager defaults/environment overrides as chat resource capture:
`PROMPT_MANAGER_HOME`, `SKILL_MANAGER_HOME`, and `MCP_MANAGER_HOME`. They do not derive
library paths from a selected provider's profile home. Existing stores are not
moved, deleted or automatically imported. If a previous installation used another
store, point the corresponding override at that store explicitly.

Prompt Manager's current public SDK provides synchronous `create_managed` and
`import_local`; the prompt add flow calls those APIs directly. Skill and MCP source
operations use their managers' retained jobs, including recovery, cancellation and
operation keys. The Suite only translates request fields and does not create a
second source-job service. GitHub import availability follows manager capabilities.

Library editing, review, guarded saves and immutable releases remain available.
Native provider instruction files are separate from managed prompt-library
selections and are not rewritten by library changes.

Native skill delivery to Conversation Manager chats still needs a qualified
provider discovery path. The skills library supports authoring and source lifecycle;
it does not expose profile assignment controls or imply that a skill was delivered.
Provider-native terminal history remains separate from retained Conversation
Manager chat history.

## Native sign-in while chats are retained

Profile sign-in is a durable, environment-scoped handover. The Suite queues it
before opening an interactive terminal and shows the conversations or tasks that
block it. New independent chats and messages are blocked; already-running work,
approvals, queued messages and its delegated children may finish. Cancelling the
sign-in releases its admission restriction without cancelling that work.

Conversation Manager advertises `signin_handover_version: 1`. Its
read-only `signin_activity` preflight keeps child admission open while existing
work finishes. Its `prepare_signin_stop` API seals an idle worker only after
checking active turns,
requests, delivery queues and native loaded threads, goals and background
commands. Missing activity observations do not authorize stopping a worker.
`cancel_signin_stop` releases only the matching operation's seal. The Suite
persists exact worker identities before requests and confirms their owners have
stopped before starting login. Saved chats reconnect through their existing
restore path; prompts and completed tasks are never replayed automatically.

Agent Manager's native login requests exclusive access without an unbounded
lock wait. A remaining external lease therefore reports busy before login is
launched. Shared native servers and externally owned terminals remain explicit
blockers; the Suite does not terminate them through a standalone-worker handover.
Older workers without the handover capability require a component update or
explicit session closure. Update Server, Agent Manager and Conversation Manager
together to activate this flow.

The sign-in terminal action becomes available when the login worker reports its
interactive phase. Preparing, waiting and verifying phases retain their actual
messages instead of being presented as a request for user input. The handover
and its restrictions survive a bridge restart and can be reconciled or cancelled
using the same operation identity.

Validation uses disposable manager stores, fixture browser connections, protocol
validation, chat capture regression tests and mobile accessibility checks. It does
not sign in to providers, make live model calls or migrate production stores.

## Preserve retained environments when removing aliases

Deleting an Agent Manager profile removes only its alias. Its native environment
and retained execution references remain available. Suite records the manager's
exact deletion receipt and does not mark chats unavailable by matching a reused
display name. Removing an environment or its native data is a separate manager
operation with its own explicit scope.
