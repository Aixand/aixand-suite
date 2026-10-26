# MCP attachments in Aixand Suite

Profile administration is available through the built-in `aixand_agents` tools.
They create, inspect, rename, duplicate and delete Agent Manager profiles, assign
saved logins, and start retained sign-in jobs. Native Codex controller chats receive
the shared contract; child chats and native workflow stages do not. Profile and
login results appear beside their originating tool call and survive browser reloads.

Codex sign-in uses an isolated device-login app-server. Its authenticated web card
shows the provider link and code; MCP results contain only the operation status and
Suite link. Other providers retain their native terminal login. Successful sign-in
and profile assignment are reported separately. Install updated Agent Manager,
rebuild/restart Suite, and let idle chats refresh their tools on the next message.
For standard stdio clients, install the optional `agent-manager[mcp]` dependencies
and use the Suite-bound private context adapter. See
[Profile management MCP](../../../manager-suites/agent-manager/docs/profile-management-mcp.md)
for setup, tool arguments, retry semantics and tests.

For the shared tools that find, read, and continue existing conversations from
Vox and normal chats, see [Shared conversation tools](conversation-tools.md).

Suite delegates MCP configuration and project preparation to Agent Manager's public
Python SDK. Definitions and profile bindings are shared with the `agent` CLI.
Sonar and Lore have optional project preparation adapters. Suite and MCP Manager
do not bundle, install or register them by default. Users install and register
their chosen MCP servers on the host. Codex and OpenCode V2 terminal launches are
supported. Native Codex chats configure each app-server thread separately.

## Host setup

Install the updated Agent Manager and Aixand Python SDK into the Python environment
used by the agent/Carrier bridges. Rebuild the server, frontend, and workflow bridge
from these checkouts when using packaged builds.

If you want Sonar or Lore, install it yourself, then explicitly register its
executable and adapter in the shared MCP store:

```sh
mcp-manager add sonar --definition '{"kind":"sonar","command":"/path/to/sonar"}'
mcp-manager add lore --definition '{"kind":"lore","command":"/path/to/lore"}'
agent codex mcp add docs --env-var DOCS_TOKEN -- /path/to/docs-mcp --stdio
```

Use the same `AGENT_MANAGER_HOME` for the CLI and bridges. Preparation jobs run in
that shared home, independently of browser connections. Model assets for Lore must
already exist or be provisioned explicitly using the preparation checkbox or CLI
`--install-model`. Register custom executable definitions on the host.

## Browser workflow

1. Register a project with its host path.
2. In Agents → Tools (MCP) → Project indexes, choose that project and prepare a
   manually installed and registered index server. Reopen the page to inspect
   retained jobs. Refresh indexes after source changes, or check freshness.
3. Edit a profile and select its default MCP attachments. Saving checks the profile
   revision to detect edits from another browser or the CLI.
4. Start an agent, Work chat, or Carrier agent with that profile. The launch picker
   can inherit, add, or exclude attachments without editing the saved profile.
5. Open the MCP button in an existing Codex conversation to inspect connection
   status and discovered tools. **Reconnect MCPs** queues a native reload before
   the next message. The same controls are available in conversation information.
   Reconnection refreshes loaded conversations using that agent, retains their
   managed MCP selections, and does not create a new conversation.
   The panel also lists Suite's built-in tools, including `add_project` and
   `remove_project`. When their schema changes, an idle chat gets a replacement
   native runtime thread with the current schema and its saved model context.
   Its Suite chat ID, history, project, model, and MCP snapshot are retained.
   Running turns, voice sessions, and terminal control defer that upgrade until
   the next idle attachment. Application source changes require the updated
   backend bridge to be running.

Work chats and Carrier agents resolve registered project IDs on the server. General
chats omit Sonar/Lore and show that they need a project; generic stdio attachments
still apply. Missing Work indexes block attachment and offer preparation. A successful
refresh publishes a new generation for future launches while existing sessions retain
their selected generation.

Profile changes apply to fresh launches and unloaded Codex conversation resumes.
Live attach/detach is unavailable: already-loaded Codex threads ignore replacement
MCP configuration in the tested native protocol. Existing terminal attachments keep
the thread's tools. Managed names use `agent_manager_`; native Carrier connections
and unrelated native MCP configuration are preserved.

## Workflows and SDK composition

Workflow Spawn nodes provide the same launch picker. Explicit selections compile
to `aixand.agents.spawn@1.1.0`; existing nodes without a selection retain the `1.0.0`
contract. The Python compiler selects the new contract when the `mcp` keyword is used.

```python
agent = await aixand.agents.spawn(
    profile="work", cwd="/path/to/project",
    mcp={"inherit": True, "add": ["sonar"], "exclude": ["lore"]},
    connection=connection,
)
```

The SDK also accepts `project=None` for general conversation context. Work context
uses an explicit canonical project path. Carrier's ordinary launch configuration
continues to be composed alongside these managed attachments.

## Validation

Bridge tests cover shared profile revisions, registered project resolution, and
preparation idempotency delegation. Protocol tests reject invalid selections and
browser-supplied executable settings. Frontend MCP tests use a mocked transport:

```sh
cd ../aixand-web
npx playwright test --config playwright.mcp.config.ts
```

The native stale-tool regression test starts with a schema missing `add_project`
and `remove_project`, reconnects it, and verifies both tools in actual inference
requests to a local Responses fixture. It exercises adding and removing a
disposable project while retaining the original conversation and model history.

The Agent Manager native MCP test uses installed Codex, isolated homes, and local
stdio fixtures without sending a model turn. Real Sonar/Lore preparation and
OpenCode startup can be checked independently of model credentials.

Owned MCP definitions are exposed through `mcp-managed-*` operations, using MCP
Manager 0.1.2's public lifecycle. Suite resolves registered project IDs, forwards
revision-guarded edits/reconciliation, and emits `mcps-changed` plus
`resources-changed` after library mutations. The shared resource API accepts
request-2 managed MCP targets in profile defaults, launches, workflows and Connect.
Legacy names remain supported. Legacy unscoped reload is withheld for sessions
whose resource reports contain managed MCP targets. Live attachment is a separate
backend capability; changing library definitions affects future sessions.


Resource imports: Prompt/Skill Manager 0.1.2 and MCP/Agent Manager 0.1.3 use
`aixand-resource-sources` 0.1.0 for public GitHub source capture and retained jobs.
Create/import through the managers; launches resolve accepted local copies.
MCP installation is explicit and readiness belongs to the execution machine.
Update the manager packages and rebuild deployed Suite/Connect components to
enable the new controls. See manager-suites/docs/resource-imports.md.
