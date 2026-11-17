# Terminology

| Term | Meaning |
| --- | --- |
| Suite / Desktop | Full native application: interface and local backend; optional Server access |
| Server | Workspace host with backend/tools, without frontend |
| Client | Native interface connecting to Server, without local backend |
| Workspace | Backend-owned organization, configuration, associations, and application state |
| Project | Registered directory on the workspace host |
| Provider | Agent integration such as Codex or OpenCode |
| Environment | Agent Manager's stable native execution/configuration identity |
| Profile | Named alias selecting an environment/configuration |
| Conversation | Managed history, turns, settings, approvals, queues, and worker references |
| Terminal | Runtime session with process lifecycle and input/output |
| Resource | Managed prompt/instruction, skill, or MCP definition |
| Operation ID | Stable identity for one captured mutation and its recovery |
| Receipt | Confirmation whose scope depends on the issuing owner |
| Task | Assignment with an attempt, execution association, and result acceptance |
| Definition | Saved workflow instructions/graph |
| Run / job | Accepted workflow execution with its own plan/state/outcomes |
| Effect host | Application adapter providing Runner integrations |
| Isolated | Workspace-private tools/settings under the setup contract |
| Shared | Compatible normal-user tools/settings; application state stays workspace-specific |
| Distributed products | Independently owned/installed products; multiple computers are not required |
| Standalone component | Component operated without full Suite; not another Suite packaging edition |

[Components](components.md) · [Ownership](../architecture/ownership.md) ·
[Execution](../architecture/execution-and-recovery.md)
