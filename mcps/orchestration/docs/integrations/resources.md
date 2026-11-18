# Resource capture and manager boundaries

Resource selection is explicit and separate from environment/model selection. A task or workflow freezes a snapshot before launching; later edits to a managed library cannot retarget accepted work. Library discovery through `resource_catalog` reports Prompt, Skill and MCP Manager availability independently.

```mermaid
flowchart LR
 accTitle: Resource capture before execution
 accDescr: Explicit settings and selected managed resources are resolved into a digest-checked snapshot, retained with the task or workflow and passed to conversation startup.
 Select[Settings and managed selections] --> Resolve[Resolve accepted revision]
 Resolve --> Snapshot[Settings sources digest]
 Snapshot --> Task[Retained task or workflow]
 Task --> Start[Conversation startup]
```

| Selection | Current contract |
| --- | --- |
| `settings` | Deep-copied object; conflict if the same setting also appears in task/workflow settings |
| `instructions` | Absolute store, publisher, package, prompt, optional inputs/revision; resolve and render through Prompt Manager |
| `mcp` | At most 32 explicit managed selections; absolute store, publisher, server and optional revision |
| Pinned snapshot | Exact schema/settings/sources/digest shape; digest must match settings and sources |
| Frozen skills | Unsupported pending a qualified public compiler; never silently dropped |

Managed MCP capture currently supports exactly one resolved stdio server per selection, in the exact existing absolute workspace. It pins revision and definition digest. Recipes/installations, non-stdio definitions, unresolved credential bindings (`env` or `env_vars`) and duplicate server names fail explicitly. Direct mutable `settings.skills` or `settings.mcp` selections are rejected by capture. This is narrower than arbitrary MCP Manager capability.

Snapshots use `orchestration-mcp/resource-snapshot-1` and retain source selections/revisions plus SHA256 digest. Captured settings are bounded to 512 KiB encoded. Delegation reserves `agent_manager_task_result`; it rejects a conflicting server name and allows at most 31 user servers before inserting the reporting server and recomputing the selection digest.

[resources.py](../../src/orchestration_mcp/resources.py), [resource discovery](../../src/orchestration_mcp/backend.py), [report-server injection](../../src/orchestration_mcp/delegations.py).

Checks: [managed MCP capture](../../tests/test_mcp_resource_capture.py), [snapshot behavior](../../tests/test_delegations.py). Prompt Manager integration coverage depends on that optional SDK being installed.
