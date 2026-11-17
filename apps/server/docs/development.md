# Develop Suite Server

Use this guide to locate configuration, application boundaries and focused checks
in the development beta. Start with [local setup](../README.md#develop-locally).

## Configure the development server

The server defaults to loopback port 3000. Process environment values take
precedence over `.env`. Inspect [.env.example](../.env.example) before changing
bind addresses, origins, bridge paths or Python selection.

Authentication protects HTTP and WebSocket entry points. The workspace password
authorizes the daemon OS user's resources; it does not provide per-user isolation.
Follow [authentication and host recovery](authentication.md) for trusted proxy,
loopback exceptions and recovery. Never put secrets in frontend assets.

## Locate responsibilities

| Boundary | Owning source or guide |
| --- | --- |
| Request validation and transport | [src](../src/) and [agent protocol](../src/agents/protocol.ts) |
| Chat launch intent, captured resources, onboarding | [application services](../agent-bridge/application/README.md) |
| Native terminal process I/O | [Rust bridge](../bridge/Cargo.toml) and Undercurrent |
| Workflow host adaptation | [workflow bridge](../workflow-bridge/Cargo.toml) and [native workflows](native-workflows.md) |
| Carrier delivery and acknowledgment | [Carrier integration](carrier.md) |
| Remote requests and file transfer | [Connect](connect.md) |
| Manager integration and state ownership | [manager integration](manager-suites.md) |

The active Orchestration MCP exporter still supplies services to Server consumers.
Do not remove it before replacing those consumers. See [architecture](../../../docs/architecture/README.md).

## Verify a change

From `apps/server`, run checks appropriate to the changed boundary:

```sh
npm run build
npm test
npm run bridge:build
npm run workflow:build
```

These commands build TypeScript, run Vitest, and build the two Rust bridges.
A build does not establish live provider, native installer or production readiness.
The [package scripts](../package.json) also expose protocol and pressure checks;
read their prerequisites before executing them in an isolated environment.

Recovery must retain captured identities and receipts. A stopped worker, missing
report or unconfirmed dispatch does not authorize starting replacement work.
Keep permission questions visible, and distinguish execution completion from
Carrier delivery and host acceptance.
