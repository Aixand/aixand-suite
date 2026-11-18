# Connect architecture

Connect pairs a Suite owner with a receiving device, publishes verified files without overwriting destinations, and exposes bounded remote Codex and managed-conversation APIs. The receiving computer owns execution, provider login and resulting files. NetBird supplies network inventory and tunnel confidentiality; it does not supply application pairing.

This guide describes the retained component implementation. Current Server schemas and Web views retain broader remote-chat and project-run contracts whose legacy Server adapters are absent. Read [implementation status](reference/status.md) before treating these APIs as an available Suite workflow.

## Reading paths

| Change | Read in order |
| --- | --- |
| New maintainer | [Runtime ownership](architecture/runtime.md), [trust](architecture/trust.md), [status](reference/status.md) |
| Transfer or recovery | [HTTP contract](reference/http.md), [transfer lifecycle](lifecycles/transfers.md), [persistence](reference/storage.md) |
| Remote execution | [Direct Codex](integrations/direct-codex.md), [managed conversations](integrations/managers.md), [project snapshots](lifecycles/projects.md) |
| Build or qualify | [Development](development/verification.md), [platform and packaging](development/packaging.md) |

## Source boundaries

| Entry | Responsibility |
| --- | --- |
| [companion.py](../aixand_connect/companion.py) | CLI, single-owner receiver, pairing, HTTP dispatch and receipt publication |
| [service.py](../aixand_connect/service.py) | Retained sender library, device registry and conversation-associated transfer journal |
| [codex.py](../aixand_connect/codex.py) | Native app-server process sessions, bounded events and operation receipts |
| [managers.py](../aixand_connect/managers.py), [manager_helper.py](../aixand_connect/manager_helper.py) | Optional interpreter discovery and retained Conversation Manager facade |
| [snapshot.py](../aixand_connect/snapshot.py), [project_workspace.py](../aixand_connect/project_workspace.py) | Portable archive validation and isolated remote workspace publication |

The existing [component README](../README.md) retains setup commands and heading anchors. Its historical integration and live-test statements are context, not new qualification of this checkout. No screenshots are needed for these Python and HTTP boundaries.

## Setup and retained examples

Use [receiver setup](development/setup.md) for commands, restart and pairing qualification. [Retained UI examples](reference/retained-ui.md) describe intended presentation and historical scope without promising current Server integration.
