<p align="center">
  <img src="public/favicon.svg" width="160" height="160" alt="Aixand logo">
</p>

# Aixand Web

<p align="center">
  <strong>The workspace interface for projects, conversations, and native terminals.</strong>
</p>


Suite Web is the React, TypeScript, and Vite frontend used by Aixand's desktop
applications and browser development setup. It presents Server-owned state and
manager resources; agents and commands run on the selected workspace host.

[Purpose](#when-to-use-this-component) · [Development](#develop-locally) ·
[Verification](#verify-a-change) · [Documentation](#documentation)

## When to use this component

Use this directory to develop the interface: chats, projects, native terminal
panes, workflow views, prompts, skills, and MCP resource selection. The
[native shell](../desktop/README.md) owns desktop windows, connection transport,
and native maintenance boundaries. [Server](../server/README.md) owns workspace
operations, authentication, and backend coordination.

To use Aixand without developing it, install [Suite or Client](../../README.md#installation).
Running Vite is a development workflow, not the normal end-user installation.
Client connects to Server; full Suite can also host a local workspace.

## Develop locally

Use Node 24 and npm. Suite dependency preparation uses Python to build the
downloadable Connect companion. Prepare and start [Server](../server/README.md#develop-locally) first. From
`apps/web`, run:

```sh
npm ci
npm run dev -- --host 127.0.0.1 --port 5186 --strictPort
```

Open `http://127.0.0.1:5186` on the same computer. Port 5186 matches the Server's
example development origin allowlist. Complete private password setup, then
configure a provider and select a project. A successful first conversation
verifies provider access; a loaded page alone does not.

The Vite API/WebSocket proxy defaults to `http://127.0.0.1:3000`.
`AIXAND_SERVER_URL` selects another backend; see [Vite configuration](vite.config.ts).
If requests fail, check the Server process and its exact allowed origins.
Stop the development processes with Ctrl+C when finished. Do not bind Vite to
a public interface as a substitute for production deployment.

## Verify a change

From this directory:

```sh
npm run lint
npm run build
```

The build checks TypeScript and creates frontend assets. `./dev.sh prepare` from
the Suite root builds the Connect companion; Server serves its authenticated
download. Web's dev/build commands do not regenerate that companion.
Check keyboard focus, both themes, and the interaction affected by your change.

### Browser and integration tests

Playwright belongs to this component's development tools. It drives the browser
to check interactions, navigation, authentication, accessibility, and recovery.
It is not required to run the installed application.

| Test path | What it checks |
| --- | --- |
| `tests/` and `playwright.*.config.ts` | Feature-focused browser checks, using the selected configuration's fixtures or services |
| `client-tests/` | Frontend/native Client transport integration fixtures |
| `desktop-tests/` | Desktop connection-window and launcher fixtures |
| `scripts/test-*-live.mjs` | Broader integrations with backend processes and explicitly configured runtimes |

`npm test` uses [the default configuration](playwright.config.ts), which builds
the Rust workflow bridge and starts test services. It needs Rust as well as the
Node/browser test toolchain. Focused scripts such as `npm run test:auth`,
`npm run test:agents:ui`, and `npm run test:client` select other configurations.
Install the browser runtime required by Playwright before running browser tests.

Inspect [package.json](package.json) and the selected configuration before a run.
Live scripts can use provider resources and require an isolated workspace.
Fixture results do not establish live model access or native installer readiness.
Generated traces and reports belong in ignored `test-results/`.

## Documentation

| Task | Guide |
| --- | --- |
| Change frontend behavior | [UI development and interaction contracts](docs/development.md) |
| Understand chat controls | [Chat commands](docs/chat-commands.md) |
| Develop native applications | [Desktop shell](../desktop/README.md) · [Desktop development](docs/desktop.md) |
| Understand remote-only access | [Client](docs/client.md) · [Installation roles](docs/installation-editions.md) |
| Maintain update behavior | [Updates](docs/updates.md) · [Component versions](docs/release-versions.md) |
| Respect backend boundaries | [Agent integration](../../docs/development/agent-integration.md) · [Authentication](../server/docs/authentication.md) |

[Suite](../../README.md) · [Support](../../SUPPORT.md) · [License](../../LICENSE)
