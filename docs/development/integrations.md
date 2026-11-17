# Integration boundaries

| Boundary | Owner/reference |
| --- | --- |
| Interface and native connection | [Web](../../apps/web/docs/development.md) · [Desktop](../../apps/desktop/README.md) |
| Request validation/authentication | [Server](../../apps/server/docs/development.md) |
| Workspace associations and coordination | [Application services](../../apps/server/agent-bridge/application/README.md) |
| Providers and resource capture | [Agent integration](agent-integration.md) · [Onboarding](onboarding.md) |
| Conversations, catalogs, queues | [Conversation integration](conversation-integration.md) |
| Task results and dependencies | [Delegation](../../mcps/orchestration/docs/delegation-workflows.md) · [Workflows](../../apps/server/docs/native-workflows.md) |
| Devices | [Connect](../../apps/server/docs/connect.md) |
| Speech | [Vox](../../services/vox/README.md) |

Server still consumes Orchestration MCP services. Replace consumers before
removing that boundary. Standalone MCP uses a separate explicit workspace.

Preserve operation IDs, captured inputs, exact targets, and receipts. Recover
uncertain work through its owner rather than dispatching replacements.

Verify the changed path, including relevant interruption, retry, missing-target,
and unauthorized-request cases. See [focused checks](testing.md).
