# Develop Suite Web

Start with local setup below and the [component map](README.md). Web presents host-owned state; Server application services own workspace associations and recovery.

## Develop locally

Use Node 24 and npm. Suite dependency preparation uses Python to build the
downloadable Connect companion. Prepare and start [Server](../../server/README.md#develop-locally) first. From
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
`AIXAND_SERVER_URL` selects another backend; see [Vite configuration](../vite.config.ts).
If requests fail, check the Server process and its exact allowed origins.
Stop the development processes with Ctrl+C when finished. Do not bind Vite to
a public interface as a substitute for production deployment.

## Locate the owning interface

| Interaction | Entry point |
| --- | --- |
| Chat commands, transcript and turn controls | [Conversation](../src/chats/Conversation.tsx) |
| Providers, profiles and resources | [Agent client](../src/agents/client.ts) |
| Password setup and onboarding | [Auth gate](../src/auth/AuthGate.tsx) |
| Carrier inbox and delivery | [Carrier page](../src/carrier/CarrierPage.tsx) |
| Terminal panes | [Terminal pane](../src/terminals/TerminalPane.tsx) |
| Workflow editor and runs | [Canvas](../src/workflows/builder/WorkflowCanvas.tsx), [run](../src/workflows/WorkflowRun.tsx) |
| Devices and transfers | [Device settings](../src/connect/DevicesSettings.tsx) |

[Agent integration](../../../docs/development/agent-integration.md) defines resource-store and launch-selection boundaries. [Conversation Manager](../../server/docs/integrations/managers.md) retains transcript, queue and worker lifecycle authority. [Server application services](../../server/agent-bridge/application/README.md) retain Suite workspace associations and presentation metadata.

## Preserve interaction and security contracts

| Concern | Contract |
| --- | --- |
| State first | Keep connection errors, approvals, uncertain submissions and progress visible. Put optional diagnostics behind disclosure without hiding recovery. |
| Drafts | Retain unsaved edits and the navigation guard. |
| Retries | Keep exact operation and object IDs; late responses must not reopen dismissed readers or replace newer selections. |
| Carrier | Completed execution does not prove delivery. Reading is read-only; acknowledgment is explicit. |
| Presentation | Use BBB components and [brand roles](../src/branding/ContentTheme.tsx). Verify both themes, keyboard focus, small screens and terminal reconnect. |
| Licenses | Retain bundled third-party font/icon notices. |

## Verify a change

From `apps/web`:

```sh
npm run lint
npm run build
```

Select browser or integration checks using [verification](development/verification.md#browser-and-integration-tests).

| Concern | Contract |
| --- | --- |
| Build inputs | Web checks TypeScript and bundles assets. Suite prepare builds the Connect companion separately; dev/build do not regenerate it. |
| Tests | Inspect [package.json](../package.json) and the selected Playwright config. Live scripts can use provider resources and require an isolated workspace. |
| Evidence | Fixtures do not establish live model access or installer readiness. |
| Native shell | apps/desktop has its own package/lockfile and owns build/export commands. |

## Component architecture

Read the [component map](README.md) for architecture, lifecycles, modules, UI contracts and screenshot evidence.
