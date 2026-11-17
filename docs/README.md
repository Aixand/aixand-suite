# Find an Aixand Suite guide

Installation links target **0.1.0-alpha.3**. Usage guides and screenshots describe
this checkout; installed releases can have different controls.
[Compatibility](reference/compatibility.md) lists limits. Documentation standard: **0.1.0**.

## Choose a reader goal

| I want to… | Start here |
| --- | --- |
| Choose Suite, Server, or Client and install it | [Installation](getting-started/installation.md) |
| Give installation to my agent | [Agent installation instructions](../agent-installation-instruction.md) |
| Configure the workspace or Server connection | [Configuration](getting-started/configuration.md) |
| Complete provider and project setup | [Onboarding](getting-started/first-workspace.md) |
| Start using the workspace | [Workspace guides](guides/workspace.md) |
| Work with project folders | [Projects](guides/projects.md) |
| Chat, answer approvals, or recover an interrupted turn | [Conversations](guides/conversations.md) |
| Run a native terminal | [Terminals](guides/terminals.md) |
| Select prompts, skills, or MCP tools | [Resources](guides/resources.md) |
| Coordinate dependent work | [Workflows](guides/workflows.md) |
| Connect to a separate Server | [Advanced remote access](guides/remote-access.md) |
| Maintain your workspace | [Maintenance guides](guides/maintenance.md) |
| Update an installed application or tool | [Updates](guides/updates.md) |
| Diagnose a problem | [Troubleshooting](guides/troubleshooting.md) |
| Back up, restore, reset, or uninstall | [Backup and removal](guides/backup-and-removal.md) |
| Find runnable integration examples | [Examples](guides/examples.md) |
| Understand the system | [Architecture](architecture/README.md) |
| Look up names, boundaries, or support limits | [Terminology](reference/terminology.md) · [Components](reference/components.md) · [Compatibility](reference/compatibility.md) |
| Change or verify the source | [Development](development/README.md) |

## Find a component

Component guides own their local setup and contracts.

| Source | Entry point | Shared boundary |
| --- | --- | --- |
| `apps/server` | [Server](../apps/server/README.md) | Workspace APIs, authentication, application coordination |
| `apps/web` | [Web](../apps/web/README.md) | Workspace interface and HTTP/WebSocket clients |
| `apps/desktop` | [Desktop](../apps/desktop/README.md) | Native launcher, Client transport, application maintenance |
| `mcps/orchestration` | [Orchestration MCP](../mcps/orchestration/README.md) | Agent tools, delegated results, workflow effects |
| `services/connect` | [Connect](../services/connect/README.md) | Paired devices, transfers, receiving companion |
| `services/vox` | [Vox](../services/vox/README.md) | Speech and workspace interaction; separate source setup |
| `workflow/runner` | [Runner](../workflow/runner/README.md) | Durable submission, dependency scheduling, outcomes |
| `workflow/ir` | [IR](../workflow/ir/README.md) | Versioned workflow definitions and execution semantics |
| `sdks/python` | [Python SDK](../sdks/python/README.md) | Optional direct composition of agent, messaging, and runtime APIs |
| `workflow/runner/python` | [Runner Client](../workflow/runner/python/README.md) | Python control of the local Runner service |

[State ownership](architecture/ownership.md) · [Verification commands](development/testing.md)

## Apply the shared rules

[Website publishing](development/publication.md) · [Writing standard](_standards/README.md) · [Documentation checks](development/documentation.md) ·
[Participation policy](../CONTRIBUTING.md)

[Project overview](../README.md) · [Support](../SUPPORT.md) · [Security](../SECURITY.md)
