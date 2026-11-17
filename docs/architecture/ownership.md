# Ownership

| Owner | Authoritative state and behavior |
| --- | --- |
| Suite Server | Projects, workspace preferences, associations, application operations/events |
| Agent Manager | Provider software, native environments, profile aliases, authentication, native execution selection |
| Conversation Manager | Conversations, transcripts, settings, approvals, queues, worker lifecycle |
| Prompt Manager | Prompt content, composition, snapshots, publisher lifecycle |
| Skill Manager | Skill content, validation, import/export, publisher lifecycle |
| MCP Manager | Definitions, sources, preparation, installation generations, connectors |
| Orchestration MCP | Tool contracts, assignment identity, execution associations, result acceptance |
| Runner | Durable submission, scheduling, checkpoints, cancellation, outcomes |
| IR | Workflow definitions, validation, expressions, execution semantics |
| Carrier | Messages, identities, publication retry keys, acknowledgments |
| Undercurrent | Process supervision, terminal I/O, runtime observations |
| Connect | Pairing, transfers, receiving companion |
| Vox | Audio, transcription, speech, voice interaction |

Suite retains exact manager references and receipts. UI caches do not replace
manager transcripts, queues, or lifecycle records. Reusing a profile name must
not retarget an existing conversation or environment.

## Removal is explicit

Removing a project registration, deleting conversation history, stopping a
runtime, and uninstalling tools are separate actions. Check shared-worker impact
before termination and review data ownership before removal.

[Application services](../../apps/server/agent-bridge/application/README.md) ·
[Resource integration](../development/agent-integration.md) ·
[Installation ownership](../../apps/server/docs/installation.md#installation-choices)
