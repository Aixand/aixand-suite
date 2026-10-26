# Manager Suites integration

Suite embeds the shared `orchestration-mcp` project, conversation, workflow and
delivery services using its existing database and IDs. Suite owns application
context, voice, user presentation and browser links. Managers own resource
stores, assignments, provider preparation, protocol/session delivery and retained
runtime references.

## Configuration

Install the accepted local wheels into a dedicated interpreter:

```sh
python -m pip install --find-links /path/to/wheels 'agent-manager[resources,backends]' orchestration-mcp carrier-mcp
```

Set `AGENTS_PYTHON` to that interpreter. Source development has explicit
`AGENTS_MANAGER_SOURCE`, `PROMPTS_MANAGER_SOURCE`, `SKILLS_MANAGER_SOURCE`,
`MCPS_MANAGER_SOURCE`, `SERVERS_MANAGER_SOURCE` and `RESOURCE_SOURCES_SOURCE`
overrides, plus `ORCHESTRATION_MCP_SOURCE`. Defaults use the sibling `manager-suites` checkout, including the shared
Resource Sources package. Explicit source overrides remain supported. No provider executable or
credential is installed by opening a catalog.

After changing editable checkouts, refresh their installations in every Python
environment that runs them. Source edits take effect immediately, while new
dependencies and package metadata require installation. From `manager-suites`:

```sh
uv pip install --python /absolute/path/to/python \
  --editable ./resource-sources --editable ./mcp-manager \
  --editable ./prompt-manager --editable ./skill-manager \
  --editable ./server-manager --editable './agent-manager[prompts,skills,backends]' \
  --editable ./orchestration-mcp
uv pip check --python /absolute/path/to/python
```

Legacy consumers importing `aixand_mcp` may also install the compatibility shim:

```sh
uv pip install --python /absolute/path/to/python --editable ../aixand-suite/aixand-mcp
```

Build the shared wheel with `python -m pip wheel --no-deps --wheel-dir /path/to/wheels
./orchestration-mcp`. Agent Manager itself has no dependency on this package.
The old shim contains no coordination implementation. Source bridge development
uses `ORCHESTRATION_MCP_SOURCE`; packaged deployments install the shared wheel.
See [Suite default resources](suite-resources.md) for registration, presets,
context binding, upgrades and remote-route behavior.

The global `agent` command and Suite may use different interpreters; update both
when necessary. A missing-module bridge error names the module and known package
without forwarding the Python traceback. Interrupted mutations are never retried
automatically.

`SKILL_MANAGER_HOME` selects the Skill store. `SKILLS_SOURCE_PATHS` optionally
registers explicit writable collection roots; arbitrary installed/plugin roots
are never implicitly registered as writable. Existing source registrations keep
their observed ownership/editability. Prompt packaged defaults are read-only for
new registrations; explicit `PROMPTS_PACK_PATHS` are authoring roots. Both
resource UIs expose guarded registration, inspection and authoring.

MCP definitions and runtime operations explicitly use the same
`Agent Manager provider root.parent / mcp` store as existing profiles. Managed
Server records use Agent Manager's captured Server store. Standalone MCP/Server
home overrides do not move or split those managed stores.

Native Codex and Codex ACP use the existing Codex profiles. Claude and Antigravity
profiles are discovered by default; `SUITE_CHAT_PROVIDERS` can restrict the optional
providers (an empty value disables both). Invalid optional provider configuration
is reported in backend availability instead of breaking the Codex bridge.
Install Claude's `@agentclientprotocol/claude-agent-acp` adapter separately.
Claude subscription saved logins are managed on Linux. Antigravity (`agent agy`)
uses native terminal profiles sharing its settings, history, and OS-keyring login;
on Linux, `auth_mode = "files"` enables isolated profiles and reusable saved
logins with `agy` 1.3.5 or newer. An Antigravity ACP chat backend is not implemented.
Profile editing offers Sign in to profile for native authentication using a
retained terminal, and labels the shared login scope. Provider configuration in
Agent Manager controls discovery and backend availability. Saved conversations
retain their original provider identity.
Installer/update support is reported separately from agent availability.

Chat creation selects Provider, then a provider-scoped Profile. `chat-create.provider`
is optional for old callers; Claude selects its default ACP backend when no
backend is supplied. Antigravity chats select `antigravity-sdk`.
Provider/backend mismatches fail before launching. Codex with no explicit backend
keeps its native compatibility route and existing Suite tools.
An existing conversation keeps its original provider, backend and retained runtime.

ACP chats start with provider defaults. Once connected, advertised `configOptions`
provide model/mode selectors. `chat-config-set {key, chatId, configId, value}` journals
the exact backend setting change while idle. Current options/model are retained in
the Suite snapshot and refreshed from the same worker on open. Unsupported or
unadvertised options are not inferred from provider names. Initial mandatory ACP
model/access/instruction/skill overrides retain their existing preflight rejection.
Session modes do not imply native Codex sandbox semantics. Suite tools/workflows,
voice and terminal attachment remain on the existing native compatibility route.

## Public gateway additions

The authenticated JSON/WebSocket request envelope remains `{id, op, args}`.
Existing chat event and request envelopes remain supported; metadata additions
are optional. The authoritative validators are `src/agents/protocol.ts`.

| Operations | Public manager surface |
| --- | --- |
| `skills-catalog`, `skills-show/file/create/save/validate/release/resolve/diff`, `skills-source-register/unregister` | Skill Manager catalog, source, whole-directory authoring, bytes and immutable releases |
| `skills-profile-get/set`, `skills-preview` | Agent Manager guarded skill bindings/resolution |
| `prompts-source-register/unregister`, `prompts-application-register/set/unregister/resolve/render` | Prompt Manager registered sources, guarded logical mappings and captured render provenance |
| `mcp-show/configure` | MCP Manager definition inspection and guarded mutation |
| `backend-catalog`, `chat-create` with `backend` | Public Agent launch API and Server Manager sessions |
| `chat-backend-details/operation` | Saved complete references, launch/operation receipt inspection without dispatch replay |
| `mcp-chat-status/reconnect` | MCP Manager runtime methods with the supplied retained backend connector and session target |

Draft saves/publication require `expectedDigest`; source, application and skill
assignment changes require `expectedRevision` (null means create-only). MCP
definition replacement requires its observed revision. Prompt instruction
bindings retain their existing `expectedBindingDigest` semantics. Skill bindings
contain `{store: absolute_store, reference: source/name@immutable_release}`.
Catalog names alone never identify a release. Byte-file transfer uses base64;
executability and complete package identity are preserved. The browser file
editor supports files up to 36 KB; use Skill Manager's CLI for larger files.

Prompt publication and application mapping advancement are separate. Application
resolution reports actual source/path, release/dependency digests and fallback
status. Colliding prompt drafts and skill sources remain explicitly selectable.
Skill assignments capture releases; draft edits do not mutate a saved assignment
or existing session.

## Owned prompt and skill libraries

Prompts and Skills include a managed-copy library alongside existing filesystem
sources and immutable releases. `prompts-managed-*` / `skills-managed-*` operations
call the public manager SDK. Opening a library never launches an agent. Import records
stable publisher/item IDs and captures a complete copy in the selected manager store.
Publisher paths are not used by managed rendering/editing. `adopt` preserves legacy
content with an unknown-baseline two-way review when needed.

The UI supports owned-file editing, executable flags and binary upload/download,
three-way or legacy two-way comparison, manual/per-side conflict choices, whole-version
acceptance, review later, history/restore, tracking controls and immutable publication.
Active customizations continue to resolve until guarded reconciliation succeeds.
Pending updates and refresh errors have separate badges/notices. A newer update keeps
browser review choices but disables stale apply until a fresh preview validates them.

List requests use lightweight `managed_summaries`; focus, reconnect, resource events and
visible-page polling refresh status. Show/review return bounded file descriptions and
selected file sides, with 32 KiB maximum content chunks. Uploads accept at most 64 MiB,
verify contiguous chunks and final SHA-256, and commit with the captured manager state
revision. Each resource request includes stable identity and the selected store ID;
mutations reject mismatched stores and stale revisions. Temporary uploads expire or
can be cancelled. The legacy filesystem editor retains its existing limits.

Pathspec bootstraps its bundled publisher into the same Prompt Manager store and
migrates its logical selections to owned copies. Configure `PROMPT_MANAGER_HOME`
consistently between Pathspec and Suite to see and reconcile those resources. Different
stores remain independent. Installed manager wheels must be version 0.1.1 or newer;
source development can use the existing explicit package-source overrides.

## Native compatibility and managed sessions

Existing chats with no `backendRoute` continue through Agent Manager's native
compatibility facade, whose wire ownership is Server Manager. This preserves
Suite dynamic tools, project/chat/workflow dispatch, voice, terminal attachment,
native history and saved spawn access. Suite's native compatibility presentation
mapping remains for its established public event/request schemas.

Suite configures its Agent Manager clients with `app=aixand-suite` and
`app_server_group="aixand-suite-server"`. Shared native app servers appear in
that Undercurrent group with names such as `codex-app-server-backup-01` and the
fixed `server` detection profile. Their Agent Manager credential profile remains
`backup`. Reconnects preserve the process identity; new instances receive a new
number. Legacy hash names are upgraded on reuse without changing saved run or
session IDs. Infrastructure launched by `dev.sh` stays in the `aixand-suite`
group; native terminal clients retain their agent classification.

Explicit `chat-create.backend` accepts `native-codex`, `codex-acp`, `claude-acp`,
`opencode-acp`, `claude-sdk`, or `antigravity-sdk` and creates a managed session.
It requires an explicit matching profile. The request backend value selects an adapter; actual backend/provider,
adapter, protocol version and native IDs are taken verbatim from the returned
connection/session references. Do not reconstruct those identities from names.

Persisted Suite metadata includes `backendRunId`, complete `connectionRef` and
`sessionRef`, immutable `resourceSnapshotRef` and an exclusive connection event
cursor. Run/runtime/connection/local-session/native-session/Suite-chat IDs remain
distinct. `chat-open` calls `Client.connect_backend` with the original run, checks
the exact saved references, observes requests/events and never starts a
replacement. Known identities and uncertain receipts remain inspectable even
after missing acknowledgments or persistence failures. Stable operation IDs
prevent application retries from submitting different or unconfirmed intents.
`chat-backend-operation {chatId, operationId}` reads the recorded Manager/Server
store without attaching to a worker or requiring `sessionRef`. Inspecting the
chat's completed `suite-create:<chatId>` receipt reconciles missing session/native
references and the original Suite operation. This also works after worker death.
Recovered conversations stay offline until explicitly opened; receipt inspection
does not infer runtime health or start a replacement.

Managed routes use Server's normalized message/tool/request/completion events.
Suite owns the presentation mapping. Native permission payloads keep their
existing decisions; ACP permission options keep exact IDs and explicit
cancellation. Respond-at-most-once and epoch validation remain Server-owned.
Disconnect closes attachments, never workers. Cancellation is a separate explicit
operation; only observed completion updates a turn to completed/cancelled/failed.

Native managed sessions support captured profile instructions, native skill
exports and explicit access/model preparation. The UI enables only verified
delivery controls. Stable ACP required instruction/skill/model/access overrides
are unsupported; selecting ACP explicitly uses adapter defaults and disables
managed skill inheritance. Supported MCP delivery remains explicit. Suite tools,
voice, terminal takeover, steering, queues and workflow dispatch stay on the
existing native compatibility route; managed requests for these features fail
before dispatch. An unavailable option never silently falls back to Codex.

Managed transcript inspection through Suite conversation tools returns its
retained journal as partial history. It never starts a native server merely
because a managed session uses a Codex profile. Complete provider history is not
claimed. Event replay gaps and dead workers remain visible recovery limitations.

## MCP scope and selection

Inventory constructs an opaque backend/runtime/native-session target after
resolving the Suite chat. Managed sessions supply `mcp_target` and
`mcp_connector` directly; existing native chats adapt the public native inventory
facade. Registration/preparation state is not a connected status.

Reconnect requires `scope`, `operationId` and `expectedSelectionDigest`, plus a
server name for server scope. MCP Manager checks advertised scope and saved
selection/generation identities before dispatch. No request widens scope,
refreshes an index or changes a profile assignment. Receipt acceptance does not
imply all servers connected. Uncertain delivery keeps the original operation ID.

Native config reload is process-wide and verified selection preservation is not
available to the new guarded API, which reports unsupported. The existing native
compatibility `mcp-chat-reconnect {chatId}` facade retains its accepted behavior:
reload the retained process, then inspect that thread and return the existing
native status payload plus `suiteTools`. It reads current disk configuration and
can affect other threads; it does not promise selection preservation. Supplying
any new scope/operation/digest/filter guard selects the guarded API, never the
legacy path. Managed backend routes always use the guarded connector. Inventory
and idle Suite-tool schema refresh remain available. Fixture connectors prove
successful guarded reconnect without claiming native/vendor support.

## Verification

`agent-bridge/tests/test_manager_suites.py` runs against installed managers and
real retained ACP/native protocol workers. Its optional `UC_TEST_BIN` gate uses
an isolated real daemon. Existing `test_workspace_codex.py`/`test_mcps.py` gates
use `CODEX_TEST_BIN`, disposable homes and a localhost Responses simulator; they
do not use provider credentials or bill model inference.

`playwright.managers.config.ts` in the web application uses a fresh localhost
Vite server and mocked authenticated transports. It covers manager controls plus
native chat, profile, MCP, prompt, settings and workflow regressions. It does not
reuse or deploy the live Suite service. The workflow report records exact final
commands, results and artifacts.

Remote sharing, marketplaces, cloud hosting, plugin-manager work, automatic
garbage collection, dead-worker replacement and unverified vendor extensions
remain deferred. No production Suite restart/deployment is part of this stage.
