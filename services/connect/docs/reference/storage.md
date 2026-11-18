# Persistence and recovery ownership

Connect persists intent before potentially ambiguous remote effects. Journals provide stable identities and inspection evidence; they do not make a missing receipt proof that no effect occurred. There is no automatic garbage collection or migration tool in these modules.

| Store | Owner and records | Recovery responsibility |
| --- | --- | --- |
| Injected sender SQLite | `connect_settings`, `connect_devices`, `connect_transfers`; project registry supplied by caller | Sender startup marks interrupted work failed/uncertain; same receipt identity resolves uncertainty |
| `~/.aixand/connect/receiver.sqlite3` by default | `config`, `receipts`; persistent instance UUID, pairing/token hashes | Receiver lock and full synchronous SQLite; hard-link publication witness |
| Receiver SQLite with roots enabled | `codex_sessions`, `codex_operations`, `codex_turns`, `project_workspaces` | Direct thread resume, no mutation replay, read-only completed-turn evidence, workspace publication witness |
| Receiver SQLite manager state | `manager_bindings` | Interpreter stays bound even after helper timeout; route does not silently change |
| State `managed-chats/{UUID}.json` | Manager/config binding, launch settings, environment, session refs, operations and intents | Atomic fsync/replace under per-session file lock; attach same worker; inspect existing receipt |
| State `managed-chats/conversations/{UUID}` | ConversationClient local state | Owned through Conversation Manager SDK, not an alternative transcript store implemented here |
| Receive `.aixand-connect/{UUID}.part` | Partial upload and publication witness | Removed after final receipt; retained if final journaling still says committing |
| Receive directory final filename | Verified delivered file | Kept on cancel after completion; never overwritten |
| First project root `aixand-snapshots/{UUID}` | Published project tree and manifest | Kept across retries and work; no automatic deletion |

## Sensitive state and concurrency

The sender database contains raw NetBird and outbound receiver credentials; public device projections omit the token and pair key. Receiver config stores only hashes, but process memory and the sender still need plaintext credentials for requests. Backups and OS ownership remain the at-rest boundary.

`StateLock` uses a receiver lock file with POSIX flock or Windows byte locking. A second receiver must fail before recovering the first receiver's partial work. Receiver methods serialize SQLite access with an RLock; project preparation has its own publication lock. Sender SQLite stays on its event loop while network and hashing run in threads.

Direct event queues and pending approval maps are process memory, with generation/sequence gap reporting; completed bounded turns and operation receipts are retained. Managed workers own their live conversation history and requests outside the helper process. Do not equate an in-memory event cache with durable transcript completeness.

The relevant source is [companion.py](../../aixand_connect/companion.py), [service.py](../../aixand_connect/service.py), [codex.py](../../aixand_connect/codex.py) and [manager_helper.py](../../aixand_connect/manager_helper.py). See [transfer recovery](../lifecycles/transfers.md) before clearing state: deleting journals can remove evidence needed to distinguish completed from uncertain work.
