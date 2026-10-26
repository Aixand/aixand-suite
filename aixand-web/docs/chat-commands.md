# Chat command coverage

Updated local Claude and Antigravity SDK chats support queued follow-up turns and
project-chat workflows through Suite. Enter during an active SDK turn queues a
new turn; same-turn steering is unavailable. Stop and unconfirmed completion pause
the queue until explicit resume. Reconnect backfills retained manager history.
Workflow controls show SDK ask/deny tool approvals and retain the controller's
provider/backend. Antigravity `/plan` remains unavailable pending plan artifact
feedback/approval qualification; its public typed command alone is insufficient.

Mention pickers use `/` for navigation and `:` for selection. Use `@inbox/`
to browse mailboxes, then `@inbox/<mailbox>:<search>` to select a message.
Project, profile/agent, model and file selectors use `@project:`, `@profile:`,
`@agent:`, `@model:` and `@file:` respectively. Slashes within model IDs and
file paths remain part of those values.

Bare `@<name>` searches projects, profiles, the selected profile's models, inbox
names, saved prompts, skills, chats and workflows. Results show their type;
exact-name matches come first, followed by prefixes, partial names and metadata.
Recent choices break ties, and `@` alone shows shortcuts and recent selections.
File names are searched only with `@file:` or the relative-path shorthand `@.`
(including `@./src/` and `@../`). Relative traversal must stay inside the selected
project; a parent outside it shows a boundary message. Choosing a file produces
the usual `@file:` reference and includes its content on send.

`@prompt:<name>` renders a saved prompt into the draft, asking for its inputs
when needed. `@skill:<name>` inserts the saved `SKILL.md` instructions and source
path. Neither sends a message. `@chat:<name>` searches saved chats and inserts a
link labeled with the selected chat's name into the current prompt. Its target
contains the exact chat ID, including when names match. It leaves you in the
current conversation and does not read or attach the target's messages. For
example, write `Supervise @chat:checkout until the requirements are verified`
and choose the checkout chat. `@chat/<name>` still opens a saved conversation and
`@workflow/<name>` opens a saved workflow, preserving the current chat draft.
These categories are also available through universal search. Model selection
updates an existing idle session when it advertises a model setting; profile
selection remains available for new chats.

Model settings also have mention selectors: `@effort:high` (aliases
`@reasoning:` and `@thinking:`), `@speed:fast`, `@speed:normal`, `@fast:on`,
`@fast:off` and `@mode:plan`. Choices use the provider's advertised values;
`normal` and `off` select its standard speed, including a boolean `false`
where appropriate. Bare `@high`, `@fast` and `@normal` find these choices too.
Other advertised model controls use their setting namespace, for example
`@verbosity:brief`. The picker and model panel share confirmed settings and
refresh together when model capabilities change. Changes require an idle session,
and retries retain the exact selected value and operation key.

In a new chat, choosing an effort, speed or mode selector prepares the provider
session to discover its options, preserving the draft without sending a message.
Opening bare `@` only searches known choices; it does not prepare a session.

Typing `/` opens the current provider's catalog. ACP catalogs come from the
running agent, including custom commands and later catalog updates. Every
advertised command is forwarded verbatim through that session's ACP prompt
method. Native Codex has no equivalent command-enumeration RPC: its menu combines
the documented CLI inventory (reviewed 2026-10-15), verified native RPC mappings,
and the current session's advertised configuration. Reference entries do not
claim that every CLI experiment is enabled in the installed runtime.

The menu and `/help` distinguish web interactions, provider operations, terminal
commands, and unavailable commands. Unsupported commands show their reason.
Commands never become arbitrary provider RPC names or silently become prompts.

| Commands | Chat behavior |
| --- | --- |
| `/model`, `/fast`, `/reasoning`, `/mode`, `/permissions` | Select advertised session values. Native Fast availability follows the selected model. Permissions only lists allowed native permission profiles. |
| `/plan`, `/plan on`, `/plan off` | Change native planning mode and update the Agent mode control. `/plan <prompt>` confirms the setting, then sends the prompt with a separately retained receipt. |
| `/config:<id>` | Select other configuration options advertised by the session, including boolean options. |
| `/compact`, `/review [instructions]` | Start tracked native command turns, including completion, busy checks and cancellation. |
| `/init`, `/recap` | Start explicit native prompt turns to create project instructions or summarize the conversation. Recap does not compact context. |
| `/rename [name]` | Rename the native provider thread and the saved chat; missing text opens a form. |
| `/mcp [verbose]`, `/apps`, `/usage`, `/ps` | Display provider results in a readable, copyable dialog. MCP, app and terminal lists follow pagination. |
| `/skills` | Browse native skills; choose one to insert a command into the composer. `/skills <name> [instructions]` uses its advertised native skill path. |
| `/goal [objective]`, `/goal pause`, `/goal resume`, `/goal clear` | Read or change the native thread's goal. Provider-owned continuation turns keep busy state and cancellation. |
| `/stop` | Request cleanup of provider background terminals. The chat Stop button separately interrupts the active model turn. |
| `/status`, `/debug-config` | Display confirmed native settings without exposing raw configuration secrets or developer-instruction text. |
| `/help` | Browse the catalog, descriptions and availability. |
| `/resume`, `/agents`, `/subagents` | Choose a saved conversation or a child conversation. ACP commands with these names retain the provider's advertised behavior. |
| `/new`, `/clear` | Start a fresh web chat draft in the same local project. Remote chats open device-chat creation. The previous conversation remains saved. |
| `/copy` | Copy a completed assistant response from the loaded transcript. |
| `/export [filename]` | Export the full transcript retained by Suite as Markdown, including messages outside the browser's current history window. Downloads stay in the browser; this does not write a provider-host path. |
| `/diff` | Preview staged, unstaged and up to 50 untracked local files. External diff programs, text conversion and symlink traversal are disabled; preview limits are disclosed. |
| `/pwd`, `/cwd` | Show the conversation directory. |
| `/mention` | Open the explicit `@file:` picker. |
| `/raw`, `/warnings` | Show the loaded plain transcript or retained conversation error. |
| `/exit`, `/quit` | Leave the web conversation while its retained provider continues running. |

Provider-advertised ACP commands take precedence over web shortcuts, except the
existing advertised model/configuration selectors. A command may still require
provider authentication, resources, or arguments; advertisement does not promise
that an upstream request will succeed.

## Commands that need the terminal

Codex CLI commands such as `/plugins`, `/hooks`, `/experimental`, `/memories`,
`/archive`, `/delete`, `/fork`, `/side`, `/btw`, `/import`, `/logout`, `/feedback`,
`/worktree`, `/cd` and terminal appearance/editor commands use a handoff dialog.
It preserves the full command and arguments and offers copying and **Continue in
Terminal**. The existing terminal flow attaches to the same native compatibility
conversation, retaining its profile, auth and thread identity. The operator enters
the command in the provider UI, where its native pickers and confirmations run.
Unknown/custom native command names can use this same handoff.

This is explicitly not execution inside the chat UI. Managed native workers and
remote chats do not yet support the verified terminal-attachment contract, so
these entries explain that limitation instead of launching a replacement agent.
Windows sandbox setup remains unavailable in the web menu.

## Official SDK commands

Claude SDK sessions discover their provider catalog at startup and refresh it from
SDK catalog events. New-chat `/` menus use cached metadata and request a background
freshness check without creating a conversation.
Qualified foreground commands, `/compact [instructions]` and exact captured
`/manager-resources:<skill> [instructions]` commands run as retained turns. Their
output opens the same copyable dialog even when it arrives after acceptance.
Busy checks, cancellation and operation-key retries use the existing managed
session contracts. Compaction metadata is retained with the conversation.

Both SDKs provide `/context`, `/usage`, `/mcp` and `/skills` without model inference.
Claude context inspection may call a token-count endpoint. Usage is observed SDK
usage, not an account quota. Claude MCP status comes from its public SDK API;
Antigravity shows captured definitions and explicitly reports that live status is
unavailable. Skills inspection lists captured names, digests and export paths.

Claude `/model`, `/plan on`, `/plan off` and `/mode` use acknowledged idle SDK
controls. Both SDKs expose `/permissions` with `ask` and `deny` tool policies;
these are not Codex OS sandbox presets. Confirmed settings survive saved-session
restoration. Antigravity model selection remains a creation-time choice, while
manual compaction, planning mode and manual skill commands remain unavailable.

SDK `/help`, `/new`, `/clear`, `/resume` and transcript/navigation commands use
Suite's existing actions. Unqualified provider controls and terminal/background
commands show their reason instead of sending a slash prompt. Existing retained
workers must be stopped and explicitly restored to load updated adapter code.

## Provider routes and recovery

New OpenCode conversations prefer `opencode-native`; the ACP route remains an
explicit alternative. Both use the profile's isolated environment. Existing
Carrier conversations keep their original route. Claude, Copilot and Codex ACP
sessions retain all commands advertised by their adapters.
Managed remote Codex sessions expose discovery, settings and native commands
through the companion's bounded session API. Updating the companion and Manager
Suite is required on the device. Device permission changes stay on the host;
direct legacy remote Codex has no command protocol yet.

Retained workers load their adapter code when they start. Existing managed
workers keep their negotiated command catalog after a source/package update;
new managed conversations use the updated adapter. Restarting the web backend
reloads its native compatibility facade without replacing the saved thread.

On both Home and Chat, new-chat `/`, model and settings pickers read the same
draft catalog and never create a conversation. Each menu opening requests a
background freshness check; checks share an in-flight job, with a 60-second
cooldown for unchanged inputs. Explicit **Refresh discovery** bypasses the
cooldown. Failed refreshes retain the last successful choices. Profile, account,
backend, project, resource, model and installed-provider changes invalidate the
appropriate metadata. Agent Manager persists bounded, versioned catalog snapshots
locally; the browser keeps a bounded cache for navigation within the workspace.

Native Codex and OpenCode can read models without creating a session; SDK
discovery uses a finite metadata worker. These checks can still start a provider
process in the background. ACP has no general session-free enumeration API:
previously observed settings and commands can be shown, with unknown defaults
marked **Provider default**. A first ACP session may reveal additional controls.
Auto browsing uses a candidate profile and does not commit quota routing; its
choices are validated against the profile actually selected at launch.

Draft settings are frozen with the first Send's operation ID. Acknowledged
configuration is applied before the first prompt, with model changes preceding
dependent settings. Invalid or unconfirmed initial settings retain the created
session and block subsequent sends, queued sends and provider commands. Correct
the settings or explicitly choose **Use current session settings** after review.
Retries preserve the original launch identity and never create a replacement
conversation to work around a configuration failure. Real provider startup on
Send still has its normal cold-start cost; no speculative sessions are created.

Existing-chat pickers and slash commands share confirmed state. Settings changes and provider
events survive reconnect/reopen. Retries retain operation IDs and absolute target
values, including both stages of `/plan <prompt>`. File and Inbox content stays
frozen across retries. Read commands stay usable during a running native turn;
commands that start turns or change settings require an idle session.

References: [Codex CLI commands](https://learn.chatgpt.com/docs/developer-commands),
[Codex App Server](https://learn.chatgpt.com/docs/app-server),
[ACP slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands),
[OpenCode ACP](https://opencode.ai/docs/acp/).
