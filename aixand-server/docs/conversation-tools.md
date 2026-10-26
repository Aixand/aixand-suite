# Shared conversation tools

Vox and normal Codex chats (both general and project chats) share the
`aixand_conversations` tool contract. Ask either assistant to find an earlier
conversation, inspect its parent or audit children, summarize its messages here,
or send a follow-up into that exact existing conversation.

| Tool | Behavior |
| --- | --- |
| `search_chats` | Search titles, project names, and provider user/assistant transcripts. Filter by registered project or last activity; results are ordered by recency and paginated. |
| `read_chat` | Read currently available messages, including partial replies during a running turn, page backward, or read successive chunks of a long message. Includes parent, origin, ancestors, children, and detached children. |
| `send_chat_message` | Submit an explicit user request to an existing thread through the durable follow-up queue. Return a receipt and destination link. |
| `get_chat_message_status` | Inspect queue/delivery state or the exact destination turn's outcome and reply. |
| `read_delegation_result` | Read the immutable full report returned by a chat spawned from this conversation, in pages of up to 16,000 characters. |

Search covers saved Suite native conversations beyond the UI's latest 100-chat
listing. It reads provider history rather than relying on the UI's 300-item
snapshot. Cached provider history is refreshed after changes and expires after
15 seconds; unavailable history and coverage are explicit. Only user and assistant
messages are searched, not reasoning or tool output. Existing provider transcripts
remain authoritative. Carrier inbox/task references are not substitutes for chats;
Carrier-only conversations and standalone terminal sessions are outside this
Suite native conversation registry.

`read_chat` returns a snapshot rather than waiting for a turn to finish. Running
and waiting chats use locally retained messages, updated as assistant text streams
in, without contacting the provider or entering the shared history queue. Idle
chats reuse recent complete history or attempt a provider refresh. Login
verification, the history queue, connection setup, and all rotated-thread reads
share a one-second wait budget. If a refresh cannot finish, the tool returns the
messages received so far with `historyComplete: false` and `historyError` explaining
the gap. If the saved login cannot be verified, messages are withheld. Reading
does not interrupt the target, resume it, or submit another turn. Exact delivery
and supervisor-turn reconciliation retain their separate provider refresh path.

Current attachment and original provenance are separate: a detached child has no
current parent but retains its origin. Deleted chats are excluded from search,
family links, reads, and sends. Each family page includes child totals and next
offsets, and ancestor traversal detects cycles.

Find/read requests never send a message. A clear send instruction needs no extra
confirmation; ambiguous targets or message content must be clarified. Sending
retains the destination's history, profile, model, project, and access mode. The
existing queue preserves order and voice, launch, and Runner ownership. Terminal
clients share the destination thread and do not block queued messages.
Busy turns are not interrupted. Paused queues remain paused and report that state.
Queued messages can be edited, removed, or resumed in the destination's normal UI.
The source is visible on queued and delivered messages as “Sent via Vox” or a link
to the originating chat.

The same source turn, destination, and message reuse one durable receipt even when
the model retries with another tool call ID. A later source turn may intentionally
send the same text again. Unconfirmed delivery is never replayed automatically.
Receipts retain the acknowledged destination turn ID, so an unrelated later turn
cannot be mistaken for completion of the delegated message.

## Automatic returns from spawned chats

New attached `start_project_chat` and `start_remote_chat` launches return their
assigned task's result to the originating chat automatically. The spawning tool
returns after task acceptance. The parent acknowledges dispatch and ends its turn;
it does not poll, sleep, or remain active waiting for the child. The child runs
independently. When its task finishes, Suite delivers the result through the
parent's ordinary follow-up queue and starts a separate processing turn when the
parent is available. No browser or Carrier service is required for this path.
The backend starts and recovers its chat worker independently of workflow setup.

The launch saves the return intent before creating the child. The confirmed initial
send receipt records the exact provider thread and turn assigned to that task.
Only that turn can supply the returned report. Subsequent child follow-ups neither
replace the saved report nor publish another return. Existing launches without a
return contract retain their original behavior; they are not backfilled.

For later work that depends on another agent finishing, the controller first saves
the complete request in a persistent monitor and ends its turn, including when the
user explicitly says to “wait.” Attached task reports wake that monitor automatically.
Its follow-up `send_chat_message` calls atomically register watches for their exact
receipts. A later reply, such as a brief requested from the original auditor, wakes
another evaluation and supplies the full report as immutable monitor evidence.
Neither the source chat nor supervisor evaluations poll while waiting. One-off sends
outside supervisor evaluations keep their existing behavior without automatic watches.
An active supervisor that adopts an existing task may read the immutable reports
belonging to its originating conversation. Reports from unrelated conversations
remain outside that monitor's return scope.

Children receive the same final-report contract as native workflow tasks:

```json
{"outcome":"completed","report":"The complete Markdown report"}
```

Use `failed` when blocked. A completed provider turn alone does not prove task
success. Invalid, empty, or oversized reports produce an explicit failed result;
provider failures and interruptions also produce a failed result. The original
provider response remains inspectable. Reports are limited to 100,000 bytes in
their JSON string representation. Completed reports are frozen in the return
journal. Small reports are delivered inline; larger reports arrive with a reference
to `read_delegation_result`. Read every page before using a referenced report.
Only the originating chat can read its saved delegation result through this tool.

The return journal and conversation receipt use one deterministic message identity.
Admission to the queue and its receipt are atomic. Recovery reconciles those records
rather than publishing a replacement message. An uncertain provider submission
remains uncertain and is never replayed automatically. Delivery acceptance and
completion of the receiving parent turn remain separate; the exact receiving turn
is retained so later unrelated work cannot count as its processing outcome.

Busy parents queue reports without interruption. Stop and paused queues hold new
returns, including when Stop preceded result arrival. Terminal, voice, or Runner
ownership and full queues retain the report pending admission. Detached launches
have no automatic return. Detaching a child or deleting either chat cancels an
undelivered return and removes an unsent queue entry; already submitting or accepted
inputs cannot be recalled. Removing a queued result does not cause it to be sent
again. Returned report bodies are immutable; user instructions can be sent separately.

Incoming results carry application-assigned child, task, and turn provenance.
They are peer evidence under the existing user request, not new user instructions.
The parent should respond or continue that request without automatically replying
to the child. The UI identifies the source as **Result from**, displays Markdown
reports, and distinguishes waiting, pending, queued, paused, accepted, processing,
processed, cancelled, removed, and uncertain delivery. Carrier Main inbox delivery
continues to use the separate workflow/Carrier paths.

## Transports and lifecycle

`orchestration_mcp/services/conversation_tools.json` owns the shared runtime schemas
and assistant instructions; the standalone catalog uses the corresponding contract
in `orchestration_mcp/contracts`. Suite's `agent-bridge` modules are compatibility entries.
Both app adapters expose these tools through the existing native app-server bridge
and call one `Conversations` service. This allows an idle older chat to acquire
the new tools at its next attachment without replacing live MCP configuration.
Background investigation/Runner workers retain their existing limited tool scope.

`agent-bridge/conversations_mcp.py` also implements the standard
[MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio),
including initialization, tool discovery, and tool calls. It proxies to the same
worker service over a private Unix socket. `Conversations.toolset(origin)` returns
its host-only `mcpConfig`; that capability is scoped to an active source controller
chat or a bound Vox session. Tokens never appear in browser snapshots. The broker
shares the existing database owner and queue; it has no public network listener.
The app's native adapters do not require adding a profile MCP attachment.

Streaming notifications route through indexed thread/profile/run lookups rather than
decoding every saved chat. Healthy running children rely on their event subscriptions;
background return reconciliation reads full provider history when completion or a lost
connection requires it. A dropped connection does not prove that the worker stopped.
The transport retains its failure reason, and application notification-handler failures
are logged and reported without tearing down unrelated RPCs. Fresh progress from the
same turn restores a connection-loss snapshot; confirmed session termination is preserved.
Confirmed turn outcomes also survive replayed starts/output and same-turn read races.
Stop pauses the queue and reconciles the exact turn before interrupting; a completed
turn is acknowledged without interrupting a successor. Idle notifications refresh
terminal state outside the socket reader. A backend watchdog checks active threads'
metadata at most once per 30 seconds and fetches history only when they become idle
or need reattachment to their retained run. This does not keep a model turn running.

Restart the Suite backend and start a new Vox call after installing the code.
Reopen an idle normal chat to receive the updated native tool schema. Existing
running turns finish with their current tools.

## Validation

Run the conversation, chat, workspace, follow-up, and Vox tool Python tests with
the existing SDK environment. `test_conversations.py` includes a real stdio MCP
subprocess against the scoped broker. The opt-in `test_workspace_codex.py` uses an
isolated installed Codex harness and local Responses fixture to exercise search,
read, and delegated send without external model calls. Frontend coverage lives
in `conversation.spec.ts` and `vox-conversations.spec.ts` under the chat Playwright
configuration.

`test_delegations.py` covers automatic returns, exact task and parent turns,
large reports, ownership holds, Stop, detach/delete, and crash/uncertainty recovery.
From `aixand-web`, run `npm run test:chat-delegations` for the isolated real-browser,
backend, SDK and offline-provider check. It verifies dispatch ends before child
completion and that one result returns across two backend restarts without an open
chat page or Carrier configuration. No model credentials or API calls are used.
