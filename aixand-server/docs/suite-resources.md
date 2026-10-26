# Registered Suite default tools

Normal local Suite chats automatically select `aixand-suite/controller`: workspace,
conversation and agent-administration resources. Basic chat explicitly disables
these defaults. Project chats retain the same defaults and their selected project
resources. Workers retain their task resources without controller tools; native
workflow stages receive the scoped workflow-input resource. Turning off profile
inheritance does not disable application defaults.

Suite startup registers the four `aixand-suite` MCP resources (`workspace`,
`conversations`, `agents`, `workflow`). `orchestration-mcp`, located in Manager
Suite, supplies `orchestration-mcp` and the compatible `aixand-mcp` command plus
deterministic self-contained Python zip adapters. MCP Manager's
`capture_artifact` owns immutable digest-named copies. Registration captures code
and contracts without executing installers or package scripts. Launch only reads
accepted revisions. Publisher changes use the existing three-way reconciliation;
customizations and rollback holds retain the accepted definitions.

The native Codex compatibility path renders the accepted contract as dynamic
tools. Managed backend sessions use the same contract through standard stdio MCP.
A session never receives both transports for one application resource. Tool
operations share the existing workspace, conversation, administration and workflow
services and their retained receipts. Those implementations now live in
`orchestration_mcp.services`; Suite's source entry points are compatibility
adapters. Standalone hosts use the same handlers without a Suite server process.
Tool availability is verified through the
backend's existing resource-assessment handshake before session submission.

`SuiteResources` is application policy. Agent Manager implements only generic
application layers and runtime bindings, with no Suite dependency. Profile and
user resources compose with the application layer, deduplicate matching identities,
and cannot weaken a required application resource. A conflicting exclusion asks
the caller to select a different application preset.

Context files contain private broker credentials, have owner-only permissions,
and live outside resource snapshots/history. Runtime descriptors carry file
references and definition/contract digests. Contexts bind chat, profile, provider,
project, origin and workflow identity. Broker tool calls require the active
originating turn and the captured group/contract. Calls have durable receipts;
unconfirmed calls are never automatically replayed. Deleting a conversation
revokes its contexts. Restart restores the private broker and existing bindings
without changing the chat's accepted versions or reissuing bearer credentials.

Resource snapshots use `agent-manager/resource-snapshot-4` for application layers,
runtime binding references, and effective user selections. Existing request and
snapshot versions remain readable. The broker protocol is `aixand-suite/broker-1`;
the adapter verifies its immutable artifact and captured contract. Capturing the
adapter does not freeze the deployed Suite service or database. A future breaking
broker revision must preserve the old protocol or reject incompatible contexts.

Authenticated bridge operations:

- `suite-resource-presets`: inspect local presets and readiness.
- `launch-preview` with `applicationPreset`: use the same default composition as
  chat creation. Required failures occur before a native session is submitted.
- `suite-mcp-context` with a chat ID and durable key: produce a scoped stdio client
  configuration and generic application/binding descriptors. It returns private
  file references, never bearer credentials. The caller must keep those references
  on this host. Tool calls still require the originating active turn.
- `suite-tools-refresh`: explicitly upgrade an idle native conversation while
  retaining its Suite ID, model history, and effective user resources. The operation
  retains its creation receipt. An uncertain result preserves the original chat
  and requires inspection, never automatic thread creation on retry. Managed
  backend sessions keep captured settings; create a new chat for new defaults.

Existing legacy native chats retain their original refresh path. Registered chats
retain captured contracts when reopened or sent another message; application
updates are visible through the resource report and MCP inventory. Fresh chats
use accepted current registrations. No migration rewrites account/profile defaults.

Paired-device chats retain their current resource behavior. Host context files and
Unix sockets are never forwarded as device paths. Explicit `suiteTools=true` on
a remote create returns `unsupported` until an authenticated context relay is
implemented and verified; remote chats without Suite tools continue normally.
No remote Suite-tool support is advertised by this release.
