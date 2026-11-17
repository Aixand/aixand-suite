# MCP integration

Suite uses MCP Manager for definitions, source jobs, preparation and immutable
captured artifacts. Agent Manager owns native environments and launch capability;
Suite captures supported explicit MCP selections before managed chat startup.
Profiles do not own the resource library. See
[agent integration](../../../docs/development/agent-integration.md).

## Prepare a managed chat

Prepare dependencies from the Suite root with `./dev.sh prepare`. In the Agents
resource library, inspect or create the selected MCP definition and complete any
required preparation. Start a new Codex/OpenCode chat with explicit supported
selections. Missing required resources prevent launch. Library edits do not change
a running chat's captured configuration.

The [resource adapter](../agent-bridge/application/resources.py) owns launch capture.
Definitions do not freeze an external executable's behavior or establish account
access. Optional unavailable resources can be omitted only under the accepted
capture contract. Do not treat a discoverable definition as proof of delivery.

## Keep Suite tools scoped

[Registered Suite tools](suite-resources.md) define controller and worker resources.
The [tool context adapter](../agent-bridge/application/tools.py) captures the
originating role and allowed operations. A child reporter receives a private
submission endpoint, not its parent's unrestricted orchestration connection.
[Task results](../../../mcps/orchestration/docs/delegation-workflows.md) distinguish
Carrier publication from host acceptance and execution completion.

Suite-connected operations must use the authenticated private context. Never
recover a failed request by switching to a standalone workspace or another
profile. Reuse the captured operation ID and inspect uncertain outcomes first.

Native terminal tools and managed conversation tools have distinct capability
and lifecycle boundaries. Advanced delivery paths require separate qualification.
