# Suite Server

Suite Server owns workspace application state, authenticated APIs and frontend events.
It coordinates independent managers through private Python workers and Rust bridges.
This development beta focuses on local Codex and OpenCode operation.

## Develop locally

From the Suite root, run `./dev.sh prepare` to prepare pinned Python dependencies.
Then, from `apps/server`, with Node 24.15+ and Rust available:

```sh
npm ci
npm run bridge:build
cp -n .env.example .env
npm run start:dev
```

The development API defaults to loopback port 3000. First startup requires Suite
password setup through the frontend. The password authorizes the server OS user's
workspace; it does not create per-user isolation. Check terminal output if startup
fails, and review authentication before exposing any listener.

## Find the owning contract

- [Authentication and host recovery](docs/authentication.md)
- [Server installation](docs/installation.md) and [production operation](docs/production.md)
- [Configuration and development reference](docs/development.md)
- [Application composition](agent-bridge/application/README.md)
- [Managed resources](docs/suite-resources.md) and [MCP integration](docs/mcp.md)
- [Carrier](docs/carrier.md), [Connect](docs/connect.md), and [native workflows](docs/native-workflows.md)
- [Suite architecture](../../docs/architecture.md)

Run `npm test` from this directory for Vitest checks. Bridge and live integration
checks have separate prerequisites; inspect the scripts in [package.json](package.json)
before running them against a workspace or provider.
