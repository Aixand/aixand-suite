# Aixand web

[Desktop](docs/desktop.md) carries this frontend in Tauri on Windows,
macOS, or Linux, and connects to a local or remote Suite backend. The
[terminal-only Server package](../aixand-server/docs/installation.md) needs no
frontend assets or Tauri runtime.
Production serves the built frontend and APIs together on port **8753** through
NestJS; see [production deployment](../aixand-server/docs/production.md).

Run `npm run desktop:export` on the Suite host to prepare a small desktop-only
source ZIP for testing on another computer.

[Aixand Connect](../aixand-connect/README.md) adds **Settings → Devices** and file
transfer progress cards in project chats. Python 3.11+ is required by the frontend
build to generate the downloadable companion. Run `npm run test:connect` for its
browser checks.

A React frontend for Aixand, built with TypeScript and Vite. It uses the neutral surfaces, teal accents, and vector wordmark from `../../project-site`, composed with the reusable components and interaction patterns from BBB Design.

## Run locally

Use Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Vite prints the local and network URLs. For the development preview created during initial implementation, use port 5186:

```sh
npm run dev -- --port 5186
```

## Included

- **Chat:** a focused, full-height workspace with the suite navigation rail, a collapsible history sidebar, and a centered conversation column. The sidebar combines New chat, search, inline project folders limited to five visible rows with their own scroll area and icon-triggered search, and twenty recent conversations; reopening a visible conversation preserves its position. Search reaches all history. Scrollbars stay thin and visible across scroll areas. The suite navigation stays visible when history is collapsed; theme and account icons sit at the bottom of the main navigation rail. The account menu contains Settings, Recover a chat, a temporary Onboarding preview, and Sign out. Mobile uses a navigation drawer with focus return. Conversation text and the composer share a reading width; the empty composer sits beside its welcome text, and active conversations keep it at the bottom. Profile, project, and desktop model choices remain visible. Chat options contains provider/backend settings, MCP servers, and remote chat; mobile model selection lives there too. A softer ink hierarchy keeps dark mode readable without bright white text. Locked context stays readable. Routine tool calls use collapsed, borderless Agent activity disclosures, with a leading chevron on each nested activity. Workflow, spawned-session, and other task cards remain visible in the transcript. Completed status remains available to assistive technology while running and attention states stay visible. Project selection preserves instructions, and a new conversation starts without a project. Enter submits; Shift + Enter adds a line. Chats initially load five turns. The active conversation keeps fetched pages mounted for up to fifty turns (with an 8 MiB text budget), preserves the reading position as older messages arrive, and reuses newer messages when scrolling back down. Inactive conversations retain the smaller five-turn cache.
- **Project files:** selecting a local project makes a resizable Files pane available on the right of Chat. Browse folders, use breadcrumbs, show hidden files, and read text/code or preview PNG/JPEG/GIF/WebP images. Refresh reloads the folder and selected file after changes. Open the pane explicitly from the toolbar; its width and desktop visibility are saved for this browser. It starts closed until opened. Smaller screens open a right-side drawer. File browsing uses the registered directory on the Suite server's machine through the authenticated agent gateway, without launching an agent or changing the chat draft. Previews are read-only; text is limited to 256 KiB and images to 512 KiB. Linked paths and special files cannot be opened. Remote conversations do not show this local pane.
- **Workflows:** saved workflows and chat-created Runner runs at `/#/workflows`. **View workflow** opens the normal workflow builder in run mode, using its shared canvas, nodes, minimap, toolbar, and inspector. Select stages to read submitted instructions or open their chats; Collector joins and human Main inbox delivery show live progress. Arrange or move nodes to save your view; the submitted plan stays fixed. Progress continues after the initiating chat finishes and survives reload. Saved drafts use the editor's settings, connection checks, arrangement, undo/redo, and local import/export. Agent and Carrier messaging nodes run Sequential hello and Brain and Implementer through Aixand IR and the sibling durable Runner. See [native chat workflows](../aixand-server/docs/native-workflows.md) for orchestration and recovery.
- **Demo plans:** the original searchable plans and simulated runs remain at `/#/workflows/plans`, accessible from Workflows and Chat.
- **Terminals:** a full-height workspace without the global header. The terminal/process library puts My terminals first and uses readable grouped rows, quiet project/profile context, status dots, and row menus revealed on hover or focus (always available on touch). Search opens from its icon; New terminal stays visible, while refresh and fullscreen live in Terminal options. Filtering and collapsing sections preserve open panes. Workspace tabs and pane controls sit beside the library, and the terminal emulators use xterm.js.
- **Analytics:** counts and progress calculated from the current browser’s workflows.
- Responsive navigation, keyboard-operated dialogs and controls, appearance controls for light/dark mode, and local persistence. Appearance follows the device setting until you choose a theme.
- **Settings:** open the account menu and choose Settings (`/#/settings`). Debug mode is off by default and saved for this browser. Enabling it turns on Vox diagnostics; disabling it clears reports and stops browser/backend diagnostic sampling without ending calls.

Settings → **Reset data** offers **Reset chats only** (all chats and related activity)
and **Reset everything** (also project registrations/discovery, device connections,
managed agent profiles, saved accounts/API keys, agent defaults, setup progress,
and browser workflows, drafts, and preferences). Full reset returns to agent onboarding
even when the CLIs are already installed. Full reset reloads onto Home and explicitly
starts agent onboarding before displaying the workspace, including when session
metadata is stale. An interrupted handoff can retry without repeating deletion.
Chat-only reset stays in Data management. Both require typed
confirmation and an online server, and reject active or unconfirmed work. Server
deletion uses a transaction and retries reuse a durable receipt. Managed agent files
are staged with an undo journal; failures restore them and interrupted resets recover
on bridge startup. Agent operations, sign-ins, live runs and identity changes must
finish before a full reset. Connected tabs refresh after a reset. Agent data shared
with other tools through the same Agent Manager home is also cleared. Project files,
workspace authentication, provider logins outside Agent Manager, installed CLIs,
resources, and external service history are preserved; old Runner runs are hidden
from the reset workspace. Browser cleanup includes legacy `intessio.*` keys.
- A viewport-sized workspace with an independently scrolling content area. The suite icon rail remains available on every page. Chat adds its full-height history sidebar and keeps global breadcrumbs and appearance controls out of the conversation header. The Aixand A links Home; every destination has an accessible name and a tooltip that opens after 100 ms on hover or immediately on keyboard focus. The rail stays visible on small screens; outside Chat and Terminals the header stays in place; route changes reset content scroll and focus the page heading.
- Home surfaces pending requests, recent work, and running tasks. Chat centers its composer beside a persistent history list; smaller screens open that list from the left. Agents combines saved provider sessions, profiles, and setup in one navigation/list/reader workspace. Carrier uses the same layout, while Terminals keeps its dedicated tabbed, tiled workspace.

Chat supports live Codex conversations through Agent Manager's app-server SDK. Sign in with your Suite password, optionally select a profile or project, then send a message. Replies stream into the conversation, with follow-ups, questions, approvals, Stop and saved history. Without a project, the backend creates a writable workspace at `~/.aixand/aixand-suite/codex/<conversation-id>/` and keeps its files when the chat is reopened. Selecting a project uses its saved directory. The Chat page shows project details only when a project is selected; it does not ask for a working directory. Both kinds of conversation use workspace writes with approval handling. Original plan creation uses predefined steps, and a running demo advances every six seconds. Analytics has no production usage/cost telemetry. The Workflows editor and Terminals connect to the real backend using the authenticated workspace session. Demo plans remain under `aixand.workflows.v1`, the IR editor draft uses `aixand.ir.workflow.v0.1`, and appearance uses `aixand.appearance` in localStorage. Storage failures surface an in-app notice.

## Design sources

- `src/brand.ts` creates the Aixand preset with BBB’s `createBrand` API. Its light/dark color roles match `../../project-site/src/styles/aixand-brand.ts`; typography, component geometry, motion, and status colors inherit BBB’s foundations.
- `src/branding/palette.ts` copies the site’s complete palette from `../../project-site/src/styles/aixand-palette.mjs`: light canvas `#FAFAFA`, text `#202124`, and teal `#237D80`; dark canvas `#121212`, text `#F4F4F4`, and teal `#65BCBE`. Keep these colors and their interaction states aligned when changing the site branding. The app builds independently of the sibling repository.
- `src/styles.css` owns the application shell and terminal panes; `src/terminals/TerminalLibrary.css` owns the terminal/process sidebar; `src/workspace/workspace.css` owns the workspace page layouts. `src/workspace/ChatPage.tsx` and `chat.css` own the conversation preview and its responsive layout. These styles consume BBB variables and app layout variables. Headers, forms, buttons, badges, dialogs, sheets, cards, navigation, and filters use the actual BBB React library.
- UI typography uses BBB’s system font stack. Terminal emulators use locally bundled Monaspace Neon. `public/fonts/` retains the bundled fonts and their licenses.
- Interface icons use Lucide outline artwork through BBB’s shared `Icon`
  component. Use canonical Lucide names and extend BBB’s icon registry when a
  symbol is missing. Sidebar icons render at 24px; other controls retain their
  component sizing and the shared 2-unit stroke. Custom SVG is reserved for
  Aixand brand artwork. Lucide’s license is retained in `public/licenses/lucide.txt`.
- The workspace shell, filled fields with persistent labels, cards, navigation, and restrained interaction states follow `../../../portfolio/bbb-design`. Terminal forms, toolbar actions/tooltips, and empty states also use the actual BBB components. The main navigation rail’s sun/moon button shares the same persisted theme across pages; existing terminal emulators follow theme changes without reconnecting.
- The Angular Aixand prototype informed the screen set. Its Angular components and global styles are not dependencies of this React app.
- `public/brand/` and `public/favicon.svg` contain the site’s light/dark wordmark and favicon. `Mark.tsx` uses the same A geometry for the navigation rail and terminal status bar.

## Soft content design rules

Dark-mode content follows a soft hierarchy: headings `#BFBFBF`, body `#B4B4B4`,
supporting text `#A4A4A4`, and muted text `#929292`. These roles live in
`src/branding/ContentTheme.tsx`; use them instead of choosing local gray values.
Keep each theme's established palette. Hierarchy, feedback, and recovery patterns
apply to both light and dark mode. Onboarding, workspace navigation, and terminal
rendering retain their own theme boundaries.

- Lead each view with the object's state and the next useful action. Keep one
  primary action for the current state; put infrequent management actions in a menu.
- Healthy states use neutral text and a restrained status marker. Warnings and
  errors remain explicit, with a useful recovery action. Never imply an account
  is verified, a resource is installed, or work is complete without supporting data.
- Separate work completion from report delivery. A completed workflow without a
  delivery receipt must not claim its report reached Carrier. Check status reads the
  existing run; Resume existing run explicitly requests continued work. Pending
  actions show local progress and retain the original operation and retry semantics.
- Read report in Carrier selects the confirmed message, including archived reports
  and reports outside the current inbox page. Opening uses read-only message lookup
  bound to the current inbox instance; acknowledgment remains an explicit action.
  Missing reports offer retry, and late responses must not reopen a dismissed reader.
  History-loading errors leave the selected message readable and can be retried
  separately. After acknowledgment, keyboard focus moves to the next useful action.
- Use `ContentDisclosure` for optional configuration, versions, sources, and
  diagnostics. It preserves mounted children and drafts. Connection failures,
  approval requirements, uncertain submissions, live progress, and recovery actions
  stay outside collapsed details.
- Keep permission choices visible when they affect the next operation. Reveal
  technical identifiers, JSON, and low-level configuration only when requested.
- Supporting forms use `useContentFieldVariant` and persistent labels. Retain
  visible keyboard focus, invalid states, readable selected states, wrapping labels,
  and the approved type sizes. Quieter borders must still expose focus clearly.
- Reuse BBB controls and the content utility/divider roles. Let spacing and grouping
  establish hierarchy before adding containers, badges, or more colors.
- Keep common actions in the same place across themes. Published instruction
  prompts expose Assign to profile directly. MCP readers lead with profile
  assignments, with library management and launch configuration available on request.
- Keep crowded views useful: workflow runs needing attention and those in progress
  stay above optional finished history. Search reveals matching history. Inbox
  subjects and previews can be shortened in the list while the reader and accessible
  button name retain the complete subject. Never shorten the actual message.
- Keep interaction targets stationary. Custom rows and disclosures use brief token
  color transitions; reduced motion removes those transitions. Avoid animating layout
  or scrolling someone away from what they are reading. Scrollable code, tables,
  and activity output receive keyboard focus only when they overflow.
- Navigation preserves useful selection, filters, drafts, and context. Resource
  editors retain their explicit discard decision. Settings sections have bookmarkable
  URLs in both themes and preserve unfinished entries while switching sections.
  Access and approval saves show progress, then confirm success only after the
  server responds. The saved setting remains authoritative while a request is pending.
- Carrier drafts are saved in session storage for the current tab and restored only
  when Resume draft is chosen. Closing, navigation, and reload preserve the original
  sender, reply target, and any pending send reference. Sending or discarding clears
  the draft. Tab-scoped storage avoids overwriting drafts in other open tabs. Storage failures are shown and
  retain an in-memory copy for the current visit.

Check default, hover, focus, selected, loading, empty, disconnected, failure, and
recovery states. Include narrow screens and 200% text. Verify mutations and retry
references as well as appearance. Use isolated services for integration checks;
provider authentication and paid model calls require a separately configured run.

Run `npm run test:soft-content` for the populated-workspace checks and screenshot
references in `tests/populated-workspace.spec.ts-snapshots/`. The suite uses isolated
WebSocket fixtures with 30 conversations, 24 messages, 36 profiles, and mixed workflow
states. It checks keyboard scrolling, live focus recovery, search, reduced motion,
narrow widths, and 200% text. Visual references use a fixed date, locale, and timezone.
Review intentional appearance changes before regenerating references with
`npm run test:soft-content -- --update-snapshots`.

## BBB dependency

The application installs `vendor/bbb-design-0.2.0.tgz`, packed from the local `../../../portfolio/bbb-design` source at implementation time. This makes installs reproducible without requiring the sibling repository in CI. The library is private and has not been published to a registry.

To adopt a newer BBB version, build and pack the desired sibling revision, replace the vendored artifact, and update the dependency and lockfile. Follow BBB’s adoption/versioning instructions when releasing shared component changes. Product pages and demo state are intentionally kept in this app.

Restart an already running development server after replacing the package so Vite
clears its cached dependency styles and serves the updated BBB stylesheet.

## Verification

```sh
npm run lint
npm run build
npx playwright install chromium  # once per environment
npm test
```

Install dependencies in the sibling `aixand-server` first. The browser suite starts an isolated Nest server on port 3199 and Vite on 5191, builds the Rust workflow bridge, and tests its actual validation, reference discovery, canonical export and verifier execution APIs. It explicitly disables SDK bindings, so the ordinary suite never launches agents. The suite also preserves the existing demo, terminal, group, layout, keyboard, accessibility and responsive checks. Rust bridge tests and Nest boundary tests live in `aixand-server`.

## Backend integration

New installations continue from password creation into agent setup: provider
selection, installation, account connection, and profile creation. Agent Manager
detects the execution host's OS and architecture and supplies provider-specific
instructions. Codex and OpenCode can be installed through the existing managed
operations on supported hosts. Manual detection refreshes preserve user choices,
and setup progress survives reloads and sign-in. The account menu's **Onboarding**
preview simulates all stages, OS variants, and operation failures without changing
the workspace. Run `npm run test:onboarding` and `npm run test:auth` to verify these
flows. See [authentication and setup](../aixand-server/docs/authentication.md).

`src/model.ts` owns only the original demo plans and timer. The new editor uses the actual IR document as its state. `src/workflows/client.ts` transports requests and authoritative runner events through `/api/workflows/ws`; the Nest gateway delegates to the private Rust bridge. `src/pages/Terminals.tsx` and `src/terminals/connection.ts` retain their existing terminal transport. These features share the application shell and backend authentication conventions.

Hash routes work on static hosting without server rewrites. `npm run build` generates `dist/`; `npm run preview` serves that build locally.

Chat lives at `/#/chat`, with saved conversations at `/#/chat/<chat-id>`. Supervising conversations have badges in history and their header; clicking the badge opens the brief, activity, and controls. The **Supervising** history filter is available at `/#/chat/supervising`. Legacy Command links resolve into Chat, including saved monitor links. See [chat supervision and setup](../aixand-server/docs/command.md).

## Workflow canvas builder

Open **Workflows** to select a saved workflow. New libraries include **Sequential hello**, **Brain and Implementer**, and **Architecture + security → tasks → Main inbox**. Templates only supply starting graphs. Every canvas exposes the same node library, validation rules, Run panel, and Runner submission protocol.

Right-click, long-press, or press Shift+F10 on the canvas to add nodes:

- **Agents:** Project chat, Agent, and Agent tool.
- **Flow and outputs:** Task, Collector inbox, Result, Main inbox, and Done.
- **Carrier messages:** Open inbox, Send Carrier message, Wait for Carrier reply, and Acknowledge reply.
- **Advanced session control:** Spawn agent, Send instruction, and Wait for agent.

Ordinary output → input connections require a successful completed output. Independent paths run concurrently; multiple inputs form an all-success join. Collector preserves all connected outputs. Result collects outputs and can feed further work. Main inbox delivers completed outputs to the human; when present, all paths must contribute to that delivery. Done is a terminal node. Cycles, duplicate links, missing prerequisites, and incompatible ports are rejected.

An Agent’s side port connects to an **optional adviser**. This makes the adviser available for questions and replies without requiring a consultation. Adviser answers are not completion dependencies. Detached advisers remain saved but are omitted from execution. Native Project chat nodes currently consume prerequisite reports; optional adviser connections belong to managed Agent nodes.

For example, extend Brain and Implementer with **Result → Collector → Project chat → Main inbox**. Or replace Sequential hello’s Done with a Collector and connect another independent audit path. These combinations do not require choosing a workflow mode. Use a normal empty canvas to build any supported graph manually.

Project chats have read-only access. **Run** adds the saved project, controller conversation, and profile settings when the graph contains project chats. Managed agents and explicit Spawn nodes select their own provider/profile/working directory and MCP policy in node settings. Advanced Send/Wait nodes retain live session handles in one Runner scope; waits bind to the selected session’s send receipt. Instructions to the same session must be ordered with waits. Parallel instructions use separate sessions.

**Run → Start run** persists an immutable `aixand.workflow-graph` version 1 program and submission identity before effects. The program contains validated IR operations, explicit dependencies, and saved project/controller IDs. Runner executes the DAG, holds owned sessions until the graph ends, acknowledges native chat reports before publishing outputs, and delivers Main inbox through Suite’s Carrier adapter. The browser uses the authenticated `/api/workflow-jobs/ws` gateway for every new canvas run. Closing the builder leaves the job running; reconnect resumes monitoring rather than resubmitting accepted work. An unconfirmed submission can retry its exact saved request even after draft edits. Canvas edits apply to future runs.

Native chat graphs and known pure operations resume durable checkpoints after a Runner restart. Graphs holding live SDK session handles retain the existing IR uncertainty rules: a process crash does not automatically recreate sessions or replay work. Inspect retained sessions before starting another run. The panel offers **Reconcile existing run** for resumable native graphs with unconfirmed effects.

The audit example starts architecture and security chats together, joins their successful reports, runs task planning, and delivers the final list to Main inbox. Failed prerequisites block consumers. Main inbox remains for human review; workflow collectors remain internal inboxes.

**Arrange**, pan/zoom, minimap, connection checks, settings, deletion, undo/redo, and import/export share the same editor. Workflows autosave under `aixand.workflow.library.v1`. Older template mode tags are removed while preserving IDs, instructions, settings, and layout; original libraries are backed up under `aixand.workflow.library.previous.v1`. Earlier audit forms become five-node canvases. Existing IR submissions and native audit attempts keep their original payloads and identities; merely opening them never launches work.

Submitted versions and progress use `aixand.workflow.run.v1:<workflow-id>`. Historical native attempt records remain readable under their previous key. Agent terminal previews resolve exact compiled session references and stay read-only. Native chat nodes link to their conversation. Project profiles and runtime credentials remain in host configuration, outside portable graph documents.

Runner must be built from the current sibling checkout (`cargo build --features sdk` for managed/advanced agents) and restarted while idle. `serve --suite-socket` configures the private Suite effect adapter; its path is host-owned. See [workflow configuration and recovery](../aixand-server/docs/native-workflows.md).

Run `npm run build`, `npm run lint`, and `npm run test:workflow-builder` for browser/compiler checks. `npm run test:workflows:contract` compiles the current templates, manually added node IDs, and a mixed graph, then checks their complete programs against Runner’s authoritative IR schemas and bindings without invoking effects. Runner’s graph tests cover parallel execution, joins, dependency validation, session scope ownership, and checkpoint restoration. Suite’s `test_native_workflows.py` exercises real Runner and Carrier with a deterministic chat provider, including mixed IR/chat joins, restart recovery, failures, reconciliation without duplicate chats, and idempotent human delivery. These integration checks make no paid model calls.

The optional live scripts `npm run test:workflows:sequence` and `npm run test:workflows:brain` use real configured agents. They remain separate from the deterministic checks.

## Previous IR sequence editor

The following describes the retained sequence editor implementation, which is
not mounted at the new canvas route.

Build `npm run workflow:build` in `aixand-server`, start that server, then open
`/#/workflows` and use your authenticated Suite session. Use **Load verified
example** or **Load compiled example** to open the two existing `managed_codex_two_turns`
fixtures. Neither loading nor validation executes the workflow. **Run Workflow**
is explicit and requires valid IR; agent operations additionally need the existing
SDK runtime configuration described in the [server README](../aixand-server/README.md#workflows).

The editor uses `Workflow` records directly: input declarations, `body.steps`,
operation identities, expression records and output declarations. Selection,
connection state, diagnostics and run events are separate UI state. There are no
Web-specific nodes, edges, assignment nodes or execution semantics.

- `WorkflowEditor.tsx` composes the page; `SequenceEditor.tsx` recursively renders catalog-driven operation cards and structured THEN/ELSE arms.
- `Fields.tsx` edits all v0.1 types and ordinary defaults; `ExpressionEditor.tsx`
  recursively edits Literal, Reference, Object, Array, Compare, And, Or and Not expressions.
- The catalog supplies IDs, versions, titles/descriptions, required inputs,
  defaults and typed outputs. Optional titles fall back to the operation ID.
  The independent `verifier.verify` operation uses the same components as Aixand.
- Reference choices come from Rust's existing `compatible` API and only include
  workflow inputs or earlier step outputs visible in the current block. Rust's `visible_operations` API applies branch scoping. Guaranteed object properties are also
  suggested. Opaque types offer references, plus null only when nullable.
- Omitted optional inputs stay absent; **Explicit null** writes a null literal.
  Adding a step generates deterministic IDs and reserves dangling producer IDs
  so removing and adding steps cannot silently change a reference's meaning.
- Moving/removing steps preserves references. Core diagnostics point to the
  affected input, step or output and can focus its editor. Validation is debounced
  and also available explicitly. The runner validates and prepares again.
- Import uses the core parser before updating state; malformed JSON, duplicate
  keys and unsupported versions are rejected. Semantic errors can be loaded for
  repair. Export uses the Rust canonicalizer and requires successful validation.
  Hand-authored and compiled fixtures round-trip without changing their fields.
- `RunPanel.tsx` shows Prepared/Started/Published/BranchEvaluated/Failed/Completed events,
  final ordinary outputs, structured failures and cancellation. Completion is
  confirmed only after the runner's scope cleanup finishes.

To test the real browser → runner → SDK → Agent Manager path with the already
authenticated `backup` profile and running Undercurrent daemon:

```sh
npm run test:workflows:live
```

This opt-in check launches a real Codex agent, sends the fixture's read-only task
and follow-up, waits after each receipt, and explicitly stops it. It uses the
existing IR runtime example and `.venv`; `WORKFLOW_SDK_CONFIG`, `WORKFLOW_PYTHON_BIN`
and `WORKFLOW_BRIDGE_PATH` can select an existing installation. It starts only
temporary Web/Nest servers on available ports. Evidence, including the exact
submitted IR, events and outputs, is written to `artifacts/workflows-live/`.

A real browser execution was verified on 2026-09-23 with the existing `backup`
profile. [Captured evidence](docs/workflows/evidence/run.json) contains the exact
compiled document, all six operation completions and ordinary outputs;
[the completed run view](docs/workflows/evidence/completed.png) shows them in the
existing application. Independent inspection confirmed the managed agent was
stopped, had no process, and its SDK connection was closed. The returned readiness
observations are snapshots from the two waits, before the explicit stop.

The editor has one local draft and one active run per connection. Run history is not
persisted; leaving the page or disconnecting requests cancellation and StopOwned
cleanup. There is no replay, retry, resume or durable execution. Forced process
shutdown can leave cleanup unconfirmed. Standalone execution requires JSON-only
workflow input/output types; opaque values between operations work normally.
Workflows with opaque interfaces need an embedded host. Reference suggestions cover whole values and guaranteed
object paths (up to 12 levels/1000 choices); other imported paths are preserved
and validated but not offered automatically. Catalog discovery can be extended
without Web changes; executing a new package still requires its runtime binding.
Sequential v0.1 semantics are unchanged. Conditional workflows use the explicit
v0.2 IR extension; there is no Web execution engine.

## Conditional branches (IR v0.2)

Use **Add Branch** in any sequence. Configure a boolean reference or choose
Compare, All (and), Any (or), or Not. THEN and ELSE each contain the same operation
catalog and add/remove/reorder controls. No graph canvas or arbitrary edges are
introduced. Adding a branch/new condition expression upgrades the document to
v0.2; importing/exporting a sequential v0.1 workflow preserves its version.

Both arms see preceding parent values. Arm-local outputs are available only later
in that arm and its nested branches, and cannot be consumed afterward or across
arms. IDs remain globally unique. Moving a producer after its consumer surfaces
core validation errors; the editor never rewrites references to conceal them.
Comparison type selectors filter available references; operand validation and all
execution semantics remain in Rust. Run events explicitly show which arm was
selected and which was skipped. Missing ELSE means continue on false.

**Load branching example** and **Load Python branch IR** load matching fixtures
using the existing `verifier.verify` catalog/binding. Supply task `A workflow` to
select THEN or `A project` for ELSE. Neither path needs Codex credentials. The
[IR example](../aixand-ir/examples/branching/README.md) includes compiler/CLI
commands; [v0.2 semantics](../aixand-ir/docs/branching-v0.2.md) defines types,
scopes, diagnostics, Python syntax and intentionally deferred branch results.

The normal `npm test` suite covers both exact serialized Web execution and Python
fixture execution through the real Rust bridge, including both outcomes, nested
editing, condition errors, lexical references, round trips and accessibility.
To verify an already running deployment, supply a private authenticated Playwright storage-state file:

```sh
npm --prefix ../aixand-server run workflow:build
AIXAND_WEB_URL=https://suite.example AIXAND_BROWSER_STORAGE_STATE=/private/browser-state.json node scripts/test-branching-live.mjs
```

The authenticated browser session comes from `AIXAND_BROWSER_STORAGE_STATE` and is omitted from evidence. No services or agents are started by this
check. [Recorded branch executions](docs/workflows/evidence/branching/runs.json)
contain exact submitted IR, runner events and outputs for both outcomes.

## Live terminals

Follow [aixand-server setup](../aixand-server/README.md) to build the Rust bridge,
initialize the Suite password, and start the backend and Undercurrent. Open
`/#/terminals` and sign in with your Suite password. Legacy `/#/terminal` links still open this page.

Vite proxies `/api` (including WebSocket upgrades) to `http://127.0.0.1:3000`.
Set `AIXAND_SERVER_URL` when starting Vite to use a different backend address.
It can also be saved in the ignored `.env.local`, for example
`AIXAND_SERVER_URL=http://127.0.0.1:3001`. If another app owns port 3000,
set the Aixand server's `.env` `PORT=3001` and start that server separately.
`/api/health` through the frontend must identify `aixand-server`. Vite may
choose port 5174 when 5173 is occupied; allow the actual browser origin,
including its port, in `CORS_ORIGINS`.
Allow the exact frontend origin in the server's `CORS_ORIGINS` setting. Production
hosting needs its own `/api` reverse proxy with WebSocket support.

The Terminals route fills the application window with workspace tabs, a
collapsible session sidebar, and tiled xterm.js panes. Split the focused pane
right or down, then select or create a session in the sidebar. Shift-click a
sidebar session to auto-tile it: fill an empty pane first, otherwise split the
largest pane along its longer dimension using the current container size.
Equal-sized panes prefer the focused pane. Already open sessions are focused
without duplication. Manual split controls retain their chosen direction. Drag dividers to
resize, double-click to balance, or focus a divider and use arrow keys. Each
pane can be maximized and restored. Drag a pane header or sidebar session onto
a pane to show five placement zones: left, right, above, below, or center.
During a drag the source pane is temporarily hidden and the remaining panes
fill its space. Cancelling or dropping in the center restores the original
layout. Edge drops move an existing pane or add the chosen session; center drops leave
the layout unchanged. Moving a pane within its tab retains its emulator and
connection. Up to eight tabs and sixteen panes share
one authenticated WebSocket connection.

Terminal state and output remain live when switching tabs. Closing a pane or
tab only detaches its views; shells keep running and remain in the sidebar.
Opening an already displayed session focuses its existing pane. Layouts are
kept for the current page visit and reset on reload.

Groups organize the terminal library independently of tabs and pane layouts.
Use the group picker below search to show all terminals, ungrouped terminals, or
one group. Counts include saved slots whose daemon sessions are unavailable.
Filtering, hiding the sidebar, and changing membership leave open panes in place.
The full paginated session catalog is loaded before applying group filters.

**Manage groups** creates empty groups with default shell/directory settings.
The new-terminal form visibly selects a group and uses that group's defaults.
Each row's **…** control assigns, moves, or removes membership and offers
**Restore shell** for eligible saved terminals. A session belongs to at most one
group. Moves preserve restoration data and require a persistent destination for
a saved shell; removing membership forgets its restoration intent. Group deletion
leaves running sessions ungrouped. Existing sessions assigned to groups remain
attachment-only; only shells created in persistent groups gain restoration recipes.

The terminal library places labeled server processes in **Servers** and
maintenance jobs in **Jobs**, while preserving My terminals, Pathspec, and
Other terminals sections. Kind/service filters use the shared
[launch-context contract](../../manager-suites/agent-manager/docs/launch-context.md).
Readable Codex-server and workflow-agent titles leave native names and stable
session IDs unchanged. Legacy `feature=app-server` remains recognizable;
unlabeled sessions retain their existing classification.

Groups use the same local registry as `uc group`, scoped to the server's
Undercurrent home and endpoint. CLI changes refresh in the browser within the
five-second polling interval. Merely browsing never restores processes. Explicit
restoration recreates a shell in its saved directory, without replaying commands
or applications, and follows its stable slot in an already open pane. Pending
creation outcomes remain visible and can be checked without retrying the start.

Raw keyboard input/paste, automatic PTY resize, and bounded scrollback are
supported. Interrupted output resumes automatically from the last parsed byte;
history gaps automatically restore the current screen and show a notice about
missing earlier output. Input stays paused until the restored screen is parsed.
Recovery attempts are bounded, with manual retry if restoration fails. Screen
restoration may lose prior scrollback or terminal modes and never restarts the
shell or replays input. Account-based permissions are not implemented.

Run `npm run test:terminals` for a browser test against an isolated real daemon,
including multiple panes, background tabs, and independent shell lifetimes.
See the server README for binary prerequisites. The ordinary `npm test` suite
uses a controlled WebSocket fixture for terminal recovery tests and does not
require a daemon or access key.

## Migrating from Intessio

Use `AIXAND_SERVER_URL` for the development proxy and `AIXAND_WEB_URL` for
live browser checks. The old environment names remain fallbacks; an explicit
Aixand value takes precedence. Update sibling paths to `aixand-server` and
`aixand-ir`, and rebuild the renamed Rust bridge executables.

Browser appearance, plan, and workflow-draft settings are copied from the old
`intessio.*` keys when no Aixand setting exists. Existing Aixand values win, and
the old values remain available as backups. Workflow contract identifiers are
migrated by the backend when an old draft is loaded.

## Real Agent Manager integration

Vox is available from a floating bubble at the bottom right. Drag it with a mouse
or touch to move it; it snaps to the nearest screen edge and remembers its position.
Its panel and colored message previews follow the bubble. It uses Pipecat with local Whisper and
Kokoro, and a custom Codex adapter backed by the same managed profiles. It can
find projects, inspect allowance, and start, inspect, and stop separate read-only
investigations while you keep talking or navigate between pages. Prepare its
Python environment before enabling the microphone; see [Vox setup](../aixand-vox/README.md).

After speech-engine reuse and call cleanup, Vox peaked at **~882 MiB RSS across
ten sequential browser calls**, compared with **~2.4 GiB after four calls** before
the fix. The measured app services plus one Chromium tab peaked at **~1.49 GiB
PSS** with an offline agent-protocol fixture. This excludes the OS, real agent
providers, development watchers, and additional workloads. Speech models stay
loaded between calls; **4 GB for the full Suite remains a target to validate**.
See [Vox's memory breakdown](../aixand-vox/README.md#ram-and-vram-usage) and
[server memory notes](../aixand-server/README.md#memory-usage).

**Start call** connects audio and plays a greeting. The floating preview keeps one
message from each speaker; click the bubble for the current exchange and
microphone, speaker, and end-call controls. Spoken messages include live-call
context so Vox can acknowledge clear transcriptions and ask you to repeat unclear words.
Enable **Auto-call · Hey Vox** in the panel for hands-free calling. “Hey Vox” starts
a call, “Vox, mute/unmute” controls your call microphone, and “Vox, end” ends the
call while keeping wake listening available. “Vox, go offline” stops all listening.
The separate keyword listener retains microphone access while auto-call is on,
including when the call microphone is muted. It uses a small local backend model
while Whisper and Codex remain idle between calls. The browser tab must stay open
and awake; auto-call is off by default and after reload.
For wake troubleshooting, enable **Profile menu → Settings → Debug mode**, then
filter the browser console for `[Vox]`, or expand **Voice diagnostics** in the Vox
panel and use **Copy diagnostics**. The report
contains connection stages, aggregate browser/backend audio levels, keywords,
and call startup errors without recording audio or conversation contents.
Reports keep at most 200 events and 128 KiB in memory, copied JSON is capped at
256 KiB, and console output stops at 200 messages per page visit. Debug mode off
collects no diagnostics. `npm run test:settings` checks preferences, bounded
reports, cross-tab changes, keyboard navigation, and mobile accessibility.
`npm run test:vox` checks the complete browser/audio/tool path in isolated test state.
`npm run test:vox:interrupt` checks real spoken interruption and a paused correction
sent once after native cancellation, with old output discarded.
`npm run test:vox:wake` verifies real wake/control detection, muted call capture,
waking again after ending a call, and releasing every microphone on going offline.

Agents uses the sibling Agent Manager Python SDK through `/api/agents/ws` on the
existing Nest backend. Start/restart `aixand-server`, open `/#/agents`, and connect
with your authenticated Suite session. Profiles, saved logins, model settings, and run metadata come from Agent
Manager; no browser-owned profile registry is created. Managed profiles are
also available for selection in Chat.

Agents follows Carrier's attached navigation/list/reader layout. Its sidebar
keeps Sessions first, with Profiles, Prompts, Skills, and Tools (MCP) under
Configuration. Providers and Saved logins live under Setup; Operations is a quieter
utility at the bottom. Configuration and Setup collapse independently and remember
their state. Opening a section by URL reveals its group. Selecting a profile shows its configuration and
recent sessions; creation, editing, and launch settings open in the reader. The native default is protected; rename and deletion require an
idle profile. Duplication copies model/configuration, login assignment, instructions,
and tool settings into an empty conversation home. Launches open the exact
existing session in Terminals through `/#/terminals/SESSION_ID`; run management
and stopping remain there.

Agents opens Sessions first and remembers the last section, filters, and selection.
Sessions (`/#/agents/sessions`) lists saved Codex and OpenCode conversations across
managed homes and the native default home, including projects outside the Suite.
Profile, project, search, running/attention, and archive filters narrow the list.
Status and search sit beside the list; the filter icon opens profile and project
choices. Original `/#/sessions` bookmarks redirect with their selections and
queries intact.
Selecting a session opens a paged transcript with Markdown, code, expandable
tool activity, and optional raw records. A profile's recent sessions open the same browser
with that profile selected. Reading history does not start a provider process or
require a saved login. Small screens use Carrier's navigation drawer and
list/reader back navigation; wide screens show all three panes.

Resume uses the conversation's original home. Continue with lets you choose a
different saved login, explicitly showing its permanent profile assignment,
or create a linked Codex continuation in another Codex profile. Continuations
preserve supported context after compaction and use the target profile's
instructions and tools. OpenCode supports original-home resume and login
selection; cross-profile continuation currently requires Codex. Archived history
can be read; Codex archives can be continued in another profile. Launches use
durable retry keys, and unconfirmed launches are inspected in Terminals instead
of automatically repeated. Transcript records are bounded to 2 MiB, files to
256 MiB, and cross-profile context to 8 MiB. Long displayed records are shortened
with a visible notice.

Profiles and saved logins expose Rename next to the selected item's name. Rename
forms open in the reader, validate provider-specific name collisions, and retain
the renamed item as the selection. Names use letters, numbers, hyphens, and
underscores. Renaming a profile preserves its settings, saved sessions, native
rollout paths, and managed thread context; Suite chat references follow the new
name. Saved-login renames retain account verification, sign-in history, and
profile assignments. Active homes/accounts must finish before renaming, and the
native `default` profile keeps its name.

Profile creation, rename and duplication reject names that differ only by case
within a provider. Chat selectors merge Agent Manager and Carrier profiles by
provider/name, and qualify colliding labels, including a saved profile named `Auto`.

Saved logins supports new sign-in, reauthentication, importing native credentials,
account checks, assignment, rename, and removal. Clicking a login opens its reader;
sign-in starts explicitly and completes in a retained terminal. New login is also
available inside the profile sheet, preserving its draft. Removal requires
unassigning profiles; clearing an assignment clears its local credentials while
idle. Account verification is distinct from merely readable credential files.

Providers shows installed versions, published-release checks, installation,
updates, repair, and setup diagnostics. Updates reuse Agent Manager's detected
installation method; custom executables may require manual maintenance. Published
versions do not override Homebrew availability or pins. Provider maintenance can
queue until managed agents finish and blocks new Suite launches while it runs.

Operations have durable keys and server-side records under `AGENTS_STATE_DIR`.
Their terminals and completion receipts survive browser navigation and reconnects.
Queued updates and login operations can be cancelled; installations cannot be
cancelled after starting. Unconfirmed starts recover by their saved terminal name
and are never automatically replayed. Recent operations retain terminal links.

Profiles and saved logins load without a running Undercurrent daemon. Login files
stay on the backend; add or refresh logins using the agent CLI. An assignment
change preserves the credentials of existing sessions, and another launch in that
same home may be blocked until its previous sessions finish. Readiness is a
terminal observation, not evidence of task success. Closing the page leaves manual
sessions running. Lost launch responses are never automatically replayed; reconnect,
refresh Sessions, and reconcile retained runs. Retained sessions are bounded to
250 records per agent implementation. Direct CLI launches outside Undercurrent
are not attachable managed sessions.

See the [server configuration](../aixand-server/README.md#agents) for SDK interpreter,
source paths, manager home/configuration, and Undercurrent bridge settings.

For Chat chat, install the updated `agent-manager[sdk]` in that interpreter
(including `websockets`), start the Undercurrent daemon, and restart the backend.
Connect directly from Chat, use **Auto** or select a saved Codex profile,
choose a directory, and send your first message. Auto is selected by default and
uses the same highest-budget profile selection as `agent codex start` when a new
conversation starts. Chat shows the chosen profile; follow-ups, retries and
reopening stay with that profile. Each new Auto conversation selects again.
`npm run test:chats` runs an isolated browser integration
test for streaming, follow-ups, approvals, questions, Stop, Work threads, retry
deduplication and history recovery. It uses an offline provider and writes its
evidence to `artifacts/chats-live/`.

While Codex is working, use **Message timing** to choose **Add to current turn**
for context or corrections, or **Send after this turn** for a separate follow-up.
Queued messages appear above the composer and can be edited or removed before
delivery. They persist on the backend and run in order, including after leaving
the page or restarting the backend. Stop and failed turns pause the queue;
choose **Resume queue** when you want it to continue. Unconfirmed deliveries are
held for inspection and never automatically resent.

Type **@** for category shortcuts and recent selections, or type a name directly:
`@team-web` finds projects, `@review` finds profiles and other matching names,
and `@gpt` finds models available to the selected profile. Results identify their
type and action. Exact names rank ahead of prefixes, partial names and metadata;
recent selections break ties. Selecting applies the choice; typing only searches.
File names are excluded from universal search.

Use `@effort:high` (also `@reasoning:` or `@thinking:`), `@speed:fast`,
`@speed:normal`, `@fast:on`, `@fast:off` and `@mode:plan` for advertised model
settings. Bare `@high`, `@fast` and `@normal` find these options too. Additional
model controls have selectors such as `@verbosity:brief` when the provider
advertises them. Choices stay synchronized with the model panel and update as
model capabilities change. Settings changes require an idle session. Choosing
one of these selectors in a new chat loads its options by preparing the provider
session without sending a message; opening bare `@` only searches known options.

Use `@prompt:<name>` to insert a saved prompt, with an input form when needed,
or `@skill:<name>` to insert saved skill instructions and their source path.
These insert editable text and never submit it automatically. `@chat:<name>`
inserts a named link to a saved chat into your prompt, so requests such as
"Supervise this chat until the requirements are verified" identify the exact
conversation without attaching its contents or navigating away. `@chat/<name>` and
`@workflow/<name>` open saved conversations and workflows; the current draft is
retained when navigating away. Bare-name search also finds these resources and
inbox names. Resource catalogs load when the picker opens; an unavailable catalog
does not block other search results.

Chat and other workspace links in messages switch views in the current tab,
including copied URLs for this Suite host and legacy Command links. Drafts and
live connections stay in place, and browser Back/Forward remains available.
External website links open in a new tab; Ctrl/Cmd-click still opens workspace
links in a new tab when requested.

Choose **Inbox**, then a mailbox and message.
Use `/` to navigate to a mailbox and `:` to select a message within it;
title words can use hyphens and
the picker searches title, body and sender. Arrow keys move through suggestions;
Enter or Tab chooses one, and Escape closes the picker. Existing project,
profile/agent and model selectors use `@project:`, `@profile:`, `@agent:`
and `@model:`. File references use the explicit `@file:` namespace.
Selected messages appear as previewable, removable chips. References use paths
such as `@inbox/user:review-mobile~42`; the ID suffix distinguishes identical
titles, and the selected reference also retains the Carrier dataset identity.
Fully typed or pasted paths require choosing the message from the suggestions.
Mailbox name aliases work when unambiguous; generated paths use mailbox IDs.
For example, `@inbox/main-inbox:review` searches messages in Main inbox, while
`@project:team-web` filters projects directly.

Sending appends the selected messages' full displayed bodies, titles, senders,
recipients and dates as quoted source context. This uses the Suite backend's saved
Carrier inbox and requires its connection; it does not depend on agent MCP calls.
Archived incoming messages are available too. Selection and preview do not alter
read, archive or acknowledgment state. References are resolved before creating a
chat or sending; retries and queued messages preserve that captured content.
Missing messages, incomplete references and prompts exceeding 32,000 characters
stay editable and are not sent. Up to eight distinct messages can be included.

Type `@file:`, `@.` or `@./` to browse files in the conversation's registered local project;
choose a directory to continue browsing or a text file to attach it. Spaces use
quoted paths, for example `@file:"src/My Component.tsx"`. Selected files appear
as removable chips. As with Inbox, typing a path requires selecting its suggestion
to retain the project and file identity. Inline/fenced code examples are ignored.
Sending reads complete text files once and includes them as quoted context;
queued messages and retries preserve those bytes. Remote chats, binary files,
truncated files and files outside the selected project cannot be included.
Up to eight files are supported within the shared 32,000-character message budget.

Type `/` at the start of the composer for the active session's commands. Opening
the menu in a new chat prepares one session without sending a model prompt; the
first message reuses it. ACP commands come from `available_commands_update` and
are sent as provider slash prompts. Native Codex exposes explicit `/compact` and
`/review [instructions]` mappings; terminal-only UI commands are not advertised.
New OpenCode chats also use ACP, and updated managed remote devices expose
session commands through their companion. Existing Carrier and direct legacy
remote conversations retain their original routes.

`/model` opens the session's advertised model choices; `/model <id or name>`
selects one directly. Native Codex 0.162.1+ also exposes reasoning and, when the
selected model advertises it, a separate Speed control with `/fast`, `/fast on`,
`/fast off` and `/fast status`. Enter runs a fully typed command; Tab completes a
suggestion. Commands run while the session is idle, before message timing,
queueing or reference expansion. Slash commands and settings pickers share the
same confirmed state. Provider settings events refresh the controls and retained
conversation metadata, including after reopening the chat. Native settings use
the opt-in experimental App Server API and change only the current thread.
Unconfirmed requests retain their operation ID and explicit target value for
Retry; `/fast` is never toggled a second time by a retry.

The expanded catalog also includes planning, permissions, native skills, goals,
MCP/app/usage inspection, background terminals, rename, recap, initialization,
and web history/export/diff/file/clipboard interactions. Terminal-only commands
remain visible with an explicit handoff or availability reason. See the
[command coverage and recovery guide](docs/chat-commands.md) for the complete
behavior, scope and remaining terminal requirements.

Run `npx playwright test --config playwright.chat.config.ts` for chat UI and
accessibility checks. Run `node scripts/test-chat-followups-live.mjs` for the
isolated browser/backend/SDK check of steering, queued turns, editing, refresh,
Stop/resume, and backend restart without an open browser. It uses an offline
provider and makes no model calls.

Open a conversation and choose **Spawn terminal** to continue its exact Codex
thread in Terminals, or ask the agent to "spawn a terminal". The terminal uses
the original profile, model, permissions, working directory and history. If a
turn is still running, the terminal queues until it finishes. Chat and terminal
remain interactive on the same thread: messages, steering, queued follow-ups,
Stop and approval responses remain available in Chat. Turn status stays visible
in both interfaces. Opening a terminal preserves the conversation's native
approval policy and Suite's saved automatic approval setting. Either client can
answer a native approval; the accepted answer resolves the request for both.
Reopening Chat after a backend restart rejoins the native request stream and
recovers approvals already waiting in the terminal. Recovered requests follow
the same saved automatic approval setting as newly received requests.
**Open terminal** reopens the same session after navigation or a backend restart;
closing a pane leaves it running. **Stop terminal client** stops only that client
while the shared conversation continues. This requires Codex supporting
`resume --remote` and the updated Agent Manager SDK; shared native turns and
approval responses are verified with 0.162.1. The isolated `test:chat-terminals` check
covers shared input, transcript updates, restart/reopen, client shutdown, queued
tool launches and duplicate delivery.

**Profile menu → Recover a chat** opens a searchable list of persisted recent
conversations without depending on the Agents connection. `/recovery.html` is a
separate application entry point for cases where the workspace itself cannot
load. Search by title, project, profile, directory, or Suite conversation ID;
select a conversation to check the original process before opening its terminal.
The list comes from the backend chat database and works in a fresh browser.
Optional provider history is read-only and marks sessions without a verified
live process as saved history.

Chat automatically retries a failed browser connection or conversation attachment
three times, waiting 1, 2, and 4 seconds between attempts. A quiet status below
the chat header shows reconnection progress. After three failures, a warning in
that position offers manual retry, optional terminal recovery, and expandable
error details. The composer retains its draft and has no connection warning.
Successful reconnection or fresh healthy progress removes the notice; leaving
the chat cancels its pending attachment retries. Known stopped workers require
explicit recovery. Retries never replay messages or resume a managed session.
Slow chat loading enters this recovery path after fifteen seconds. Transport
failures do not open dialogs. Workspace render crashes open the picker immediately.
Agent inactivity and long-running turns do not trigger it.
Opening a terminal always requires an explicit click. Returning from its view
preserves the mounted workspace and drafts; returning control stops only the
terminal client after its termination is confirmed.

The backend owns recovery in an independent worker, documented in
[the server README](../aixand-server/README.md#independent-chat-recovery).
Run `npm run test:recovery` for isolated browser checks of the independent page,
search, explicit launch, renderer/bootstrap failure, and outage dismissal.

Chat history begins empty. Use **New project** to save a project with just its
name and local directory path. Projects persist on the backend across visits;
selecting one uses its path for new Work conversations. The Projects history tab
also lists empty projects and lets you start a conversation from one.

Choose **Discover projects…** in the project picker, or **Discover projects instead**
in New project, to scan an absolute directory or `~/…` on the Suite backend machine.
**Preview projects** saves candidates without registering them; **Discover and add**
registers recommended roots automatically. Git repositories/worktrees, common build
manifests, and Pathspec projects are recognized. Nested packages are optional;
dependencies, build output, caches, and directory symlinks are skipped. Extra
exclusion patterns are relative to the starting directory (or match a directory name).
The dialog shows coverage gaps, existing registrations, and selectable candidates.
Bulk imports preserve your current chat draft and project selection.

General Codex chats and Vox expose `add_project`, `remove_project`, `discover_projects`, `get_project_discovery`,
`filter_project_discovery`, `add_discovered_projects`, and `cancel_project_discovery` through their existing
native tool namespaces. For example: “Discover all my projects starting at
`~/projects` and add them.” Explicit addition needs no second confirmation. Jobs
continue after a chat turn, navigation, or voice call ends. Progress cards and
recent discoveries survive reload. Repeated imports reuse saved paths and preserve
existing names. Interrupted scans require a fresh scan after a backend
restart; completed imports remain saved. The existing 200-project limit applies,
and over-capacity imports add nothing and offer selection of a smaller batch.

To register a directory directly, ask “Add `/absolute/path/to/notes` as a project
named Research notes.” `add_project` accepts `name` and `path` and uses the existing
manual registration flow, including `~/…` expansion. Git and build manifests are
optional; the directory must exist and be accessible. Registration writes only to
the Suite registry. Repeating the same name/path reuses its existing project.
Names and resolved directory paths are unique: the same folder cannot be added
under a second name, including through a symlink or `..` path. Parent and child
folders can each be registered, in either order. On backend startup, existing path
aliases merge into the oldest registration; saved chat and workflow IDs keep working.

To unregister one project, ask “Remove Research notes from my projects.”
`remove_project(projectId)` resolves names/paths through `list_projects` and removes
only that saved registration. Files, existing chat history, and child
registrations are retained. The project picker and live registration status in
saved discovery cards update immediately. Removal retries survive restart and
cannot remove a replacement registration of the same name/path. The directory
can be registered again through manual addition or an explicitly requested import.

An explicit `.aixand/project.json` marker recognizes a project root without Git or
a build manifest. It uses schema `aixand/project-1`, an optional `name`, and optional
relative `members`. Suite's [root marker](../.aixand/project.json) declares all five
components as members, so discovery recognizes `aixand-suite` itself and roots
filtering shows it above its components, including those with their own Git roots.
Members remain available with **Include nested packages** or explicit selections.
Run a fresh discovery to pick up root markers in previously scanned directories.

Ask “Only show project roots, like undercurrent itself rather than all its crates”
to filter the saved scan. `filter_project_discovery` updates the same chat card;
`scope=roots` hides nested packages while retaining independently marked repository
roots. A case-insensitive name/path `query` or saved `candidateIds` can narrow it
further. Filters combine and replace the previous view; `scope=all` with no query
or IDs restores all results. The dialog offers **Show project roots only**, search,
and **Clear filters**. Filtering preserves the scan, its coverage details, and the
registry, and survives reload/restart. **Add shown projects** (tool selection
`filtered`) imports only matching results when explicitly requested.

Run `npx playwright test --config playwright.chat.config.ts tests/project-discovery.spec.ts`
for isolated UI coverage of preview, selected/filtered imports, retry keys, mobile
access, filtering, and restored tool-result cards.

```sh
npm run test:agents
```

This check builds the existing backend/terminal bridge and uses the real browser,
Python SDK and an isolated Undercurrent daemon with an offline provider. It tests
terminal attachment, login isolation, restarts, lost-response recovery, shared
tabs and stop cleanup without model calls. Evidence is written under
`artifacts/agents-live/`.

Ordinary browser tests use a disposable Agent Manager registry prepared by
`scripts/start-test-server.mjs`. To avoid another test run's occupied ports, set
`AIXAND_TEST_API_PORT` and `AIXAND_TEST_WEB_PORT` when running Playwright.

## Carrier inbox

Carrier uses the local Aixand backend and Carrier service. Sign in with your
Suite password to load persistent messages, read/archive state, replies, Sent
history and agent conversations. Home receives live unread updates. Existing
Carrier conversations remain available in Chat; new Codex conversations use
the app-server gateway.

Carrier uses a three-pane mail workspace: mailbox and folder navigation, a
message list, and a conversation reader. Smaller screens open folders in a sheet;
phones show either the message list or the reader, with a Back action that restores
focus to the selected message. The workspace fills the area below the Suite header,
with its mailbox sidebar attached to the Suite navigation rail. Search expands
from an icon in the message-list toolbar beside Refresh. Connection status,
details, and Disconnect live in the sidebar footer, or the mobile folder drawer.
Read state, archiving, and acknowledgment remain separate actions.

Compose opens beside the list with one searchable recipient field that also
accepts an address. Replies open inline in their conversation. Closing the composer
or changing folders retains the draft while Carrier remains open; drafts also persist
through page reloads and navigation to other Suite pages in the same browser tab.
Outbox contains
sends needing attention and preserves their original retry references. Agent
conversations open their status, recovery, stop, and terminal controls in the reader.
The local BBB package is packed from `../../portfolio/bbb-design` at the Suite root,
including its compact SearchField, form variants, and status controls.

See [Carrier setup and recovery](../aixand-server/docs/carrier.md). Run
`npm run test:carrier` for isolated real-service browser and agent checks.

Chat's Codex chats can use workspace tools to launch standalone project chats
from a general conversation, with read-only access as the initial default. The originating chat shows
a linked progress/result card, and new audit chats appear immediately in project
history. Chat links use `#/chat/<chat-id>` and reopen after refresh. Audits
inherit their source profile/model, have independent Stop and follow-up controls,
and continue when the source conversation is left or stopped. The server's
`AGENTS_WORKSPACE_TOOLS=0` disables new workspace actions. See the server README
for runtime setup and the durable launch/recovery behavior.

Attached spawned chats return their assigned task's report automatically. The
parent acknowledges dispatch and ends its current turn, then receives and processes
the report in a separate turn when available. You can leave the page; returns also
recover after a backend restart. Spawn cards show delivery and processing states,
and incoming reports identify their source as **Result from**. Stop and paused
queues hold new results until resumed. Detached chats do not return results, and
older launches are not backfilled. See
[automatic chat returns](../aixand-server/docs/conversation-tools.md#automatic-returns-from-spawned-chats).

In **Settings → Spawned agents**, choose and save the default access for future
spawned chats and chat-driven workflow stages: **Read-only**, **Workspace write**,
**Workspace automatic**, or **Full access / YOLO**. Workspace automatic keeps the
workspace sandbox and disables approval prompts; full access disables both.
The preference is stored on the server and shared across browsers. Existing chats
and already scheduled workflows retain their selected access. Override one launch
in your prompt, for example “Spawn an implementation agent with full access” or
“Make the review stage read-only.” Chat information, spawn cards and workflow stage
details display the actual selected access.

## Password onboarding and recovery

The temporary **account menu → Onboarding** action replays the welcome screen
without navigating away, signing out, or changing saved data. The Aixand mark
assembles from its upper A and lower teal triangle, then moves upward as the
password fields unfold beneath it on the same page. Preview starts with password creation and offers **View sign in**,
**View password setup**, **Replay animation**, and Close/Escape. Forms only show
preview feedback; they make no authentication requests. The current workspace
stays mounted. Reduced motion skips the intro, and the preview follows the
workspace's appearance. Run `npm run test:onboarding` for preview, accessibility,
responsive, and loading checks.

First backend startup prepares the private authentication database automatically.
Open the frontend on localhost on the Suite host, create and confirm your Suite
password, and continue to agent setup and initial projects. Manager Suite, Runner,
and Carrier are installed Suite prerequisites. No environment-file credentials,
access keys, terminal initialization commands, or setup secrets are required.
Later visits show password sign-in. One HttpOnly browser session authorizes every
workspace page; a normal sign-in preserves the bookmarked page.

Live setup gets the provider list, installation methods, sign-in capabilities,
accounts and profiles from Agent Manager. An empty workspace opens setup on
sign-in, and unfinished setup resumes after refresh. Use **account menu → Set up
workspace** to reopen it manually. Installation and sign-in use retained operations;
refreshing a page does not repeat them. Existing ready profiles are reused
automatically. Older automatic provider selections do not require setting up
every installed CLI. Once agents are ready, the resume banner points to projects;
an already configured workspace clears stale pending setup. Explicit profile and
project choices are preserved, and manually reopened setup stays available.

Installation progress comes from Agent Manager: the UI shows the current stage,
completed steps, and measured installer-download percentages when a byte total is
available. Other stages use an indeterminate bar. Retained progress survives reloads;
failed or unconfirmed operations stop the animation and keep the last reported stage.

The final step browses directories on the Suite host, with path suggestions,
breadcrumbs, hidden folders and checkboxes. Selected folder names become editable
project names. Progress survives closing the screen and restarting the server.
Finish validates the actual profiles, registers selected projects and saves each
result; a failed registration can be retried without duplicating successful ones.
Projects can also be skipped explicitly. The preview remains simulated.

`npm run test:onboarding:live` exercises the real server, Agent Manager and project
registry in disposable directories with a local provider fixture. It covers
password setup, Manager-only provider discovery, installation progress through a
backend restart using a disposable package manager, native sign-in, profile creation,
close/resume, backend restart, project registration, existing-profile reuse,
stale pending setup and manual reopening without repeated sign-in.
It requires the local Python SDK environment and built Undercurrent binaries;
it does not install vendor agents or use personal credentials.

Initial setup is restricted to the local connection, including at Vite's proxy.
Complete it before configuring a production reverse proxy. Existing password
records upgrade without resetting credentials. Preserve the authentication database
and its `.initialized` marker; deleting the database locks access instead of
reopening setup.

The login page offers manual recovery instructions and a copyable AI-agent prompt.
Recovery requires host access to replace the stored password hash and revoke all
sessions. There is no web password-reset endpoint. See the backend
[authentication guide](../aixand-server/docs/authentication.md) for exact SQL
recovery and HTTPS deployment instructions. Vite binds loopback by default.

`npm run test:auth` verifies automatic first-run setup, immediate sign-in, local
setup enforcement, later login, refresh, sign-out, cross-tab revocation, recovery
instructions, and accessibility using isolated authentication data.

## Prompts

Open **Agents → Configuration → Prompts** (`#/agents/prompts`) to browse registered
draft packs and immutable releases, inspect inputs and source assets, render
previews, and compare revisions. The page can validate/save existing draft files,
publish releases, and select released instruction recipes for Agent Manager profiles.
Concurrent source and binding changes are detected before mutations.

The Prompts menu's **Assignments** view shows current profile selections.
**Used in sessions** shows retained instruction launch outcomes and the original saved developer instructions and
provenance. New releases and binding changes affect future explicit selections;
existing conversations retain their saved instructions.

The catalog refreshes when opened, when the window gains focus, after Web mutations,
and through **Refresh prompts**. Source registrations contain durable locations;
each refresh reads current file content. In a sibling checkout, the backend
automatically discovers Prompt Manager and Pathspec packs. See the server README's
Prompts section for `PROMPT_MANAGER_HOME`, additional sources, and installed-package
configuration. Unpublished dependencies must be released before a dependent pack
can render or publish; source content remains inspectable meanwhile.

Run `npm run test:prompts` for isolated browser coverage of authoring, revision
conflicts, profile selection, saved snapshots, accessibility and mobile layout.


## Shared agent resources

The main navigation contains Home, Chat, Terminals, Workflows, Carrier, and Agents.
Prompts and Skills share Agents' full-height sidebar, library list, and detail
reader. Existing `#/prompts` and `#/skills` bookmarks redirect with query parameters
intact. Each resource section remembers its search and selected item across section
switches and visits to other pages.

Profile details link to the assigned prompt release, qualified skill releases,
and MCP definitions. Resource details link back to profiles that use them. Skill
usage is checked on demand with bounded concurrency and compares both store and
release identity. A link to a different skill store cannot open a similarly named
local release. Prompt links use the bridge's explicit local-consumer identity;
external consumers remain labeled separately. Prompt snapshot history is available
from Session details → Inspect saved instructions.

These views continue to use the separate manager APIs and their observed digests
and revisions. Publishing a release does not advance profile assignments or modify
existing sessions. Server/backend controls stay in Providers and session details.


## Resource overviews and editing

Skills, Prompts, and MCP definitions open into a reading or configuration overview.
Skill drafts and releases share a library entry for each source/name identity;
the version picker selects the exact draft or release. Instructions render as
Markdown, with package metadata kept under Details. Managed copies use the same
reading and editing surfaces while retaining their separate publisher identities,
update review, history, revision guards, and chunked binary uploads.

Edit opens a focused editor inside the current Agents reader. The library can be
revealed while editing; the main workspace rail remains available. The shared
CodeMirror editor uses BBB colors and controls, highlights Markdown and JSON,
supports undo and find, and offers a rendered preview and Ctrl/Cmd+S. Unsaved drafts
are retained through catalog refreshes and reconnects. File/resource changes, leaving the
editor, and app navigation require an explicit discard decision when needed.
Saving and publishing remain separate actions; publishing opens a version dialog.

MCP servers open into a configuration summary and their assigned profiles. The
editor offers structured command, ordered arguments, environment-variable names,
and advanced directory/timeout fields, plus a JSON view of the same definition.
Invalid JSON and unsupported fields are rejected before a write; saves use the
observed definition revision. Executable availability describes only whether the
command can be found. Live connection controls remain in the relevant session.
Project indexes have a separate local view with project selection, preparation
progress, freshness checks, and collapsed completed-job history.
