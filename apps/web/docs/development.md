# Develop Suite Web

Use this guide for frontend ownership and interaction rules in the development
beta. Start with [local setup](../README.md#develop-locally).

## Locate the owning interface

| Reader interaction | Owning source |
| --- | --- |
| Chat commands, transcript and turn controls | [src/chats](../src/chats/) |
| Native providers, profiles and resources | [src/agents](../src/agents/) |
| Password setup and native onboarding | [src/auth](../src/auth/) |
| Carrier inboxes and delivery views | [src/carrier](../src/carrier/) |
| Native terminal panes | [src/terminals](../src/terminals/) |
| Workflow editor and retained runs | [src/workflows](../src/workflows/) |
| Device pairing and transfers | [src/connect](../src/connect/) |

[Agent integration](../../../docs/development/agent-integration.md) defines independent resource
stores and captured launch selections. [Server application services](../../server/agent-bridge/application/README.md)
own workspace associations and recovery; the frontend must not become a second
transcript, queue or lifecycle authority.

## Preserve interaction and security contracts

Lead with the object's observed state and next useful action. Keep connection
errors, approval requests, uncertain submissions and live progress visible.
Use optional disclosures for diagnostics without hiding required recovery actions.
Preserve drafts and the unsaved-change guard across navigation.

Keep operation IDs and exact object identities on retries. A completed execution
without a delivery receipt must not claim its report reached Carrier. Opening a
report is read-only; acknowledgment is explicit. A late response must not reopen
a dismissed reader or replace a newer selection.

Use the existing BBB components and brand roles in [src/branding](../src/branding/).
Check both themes, keyboard focus, small viewports and terminal reconnection.
Keep third-party font and icon notices in the bundled license assets.

## Verify a change

From `apps/web`, use:

```sh
npm run lint
npm run build
npm test
```

The build checks TypeScript and bundles assets, including the Python-built Connect
companion. Playwright uses the selected configuration's fixture/service setup.
Inspect [package.json](../package.json) before choosing a live integration script;
live scripts can use provider resources and require an isolated workspace.
Fixture checks do not establish live model access or native installer readiness.

The native shell lives in `apps/desktop`, with its own package and lockfile.
Build and export commands belong to that package, not this web package.
