<p align="center">
  <img src="../web/public/favicon.svg" width="160" height="160" alt="Aixand logo">
</p>

# Aixand Server

<p align="center">
  <strong>Host your workspace. Run your agents. Connect from another computer.</strong>
</p>


Aixand Server hosts Suite's projects, conversations, tools, and workspace state.
It exposes authenticated APIs and live events, coordinating independent managers
through private Python workers and Rust bridges. Work runs on the Server's
computer, even when you connect from somewhere else.

[Installation](#installation) · [First workspace](#set-up-and-check-your-workspace) ·
[Remote access](#connect-from-another-computer) · [Development](#develop-locally) ·
[Documentation](#documentation)

## When to use Server

Choose Server for a dedicated workstation or remote host that will run your
agents and hold your projects. Connect with **Aixand Client**, or the Server
option in full Suite. Server includes no desktop interface or browser frontend.

For work on one desktop computer, install [full Suite](../../README.md#choose-an-application)
and choose **This computer** instead. It manages the local connection for you.
Server's workspace password authorizes work as its OS user; it does not provide
multi-user account isolation. Current Suite provider scope is Codex and OpenCode.

## Installation

Use the [Server installer](https://installer.aixand.org/aixand-suite/server).
No source checkout, system Node/Python installation, or developer toolchain is
required by the installed Server. Run from any directory in a terminal.

Linux/macOS:

```sh
curl -fsSL https://installer.aixand.org/aixand-suite/server | sh -s -- --install
```

Windows PowerShell:

```powershell
Invoke-WebRequest -UseBasicParsing 'https://installer.aixand.org/aixand-suite/server/install.ps1' -OutFile install-aixand-server.ps1
.\install-aixand-server.ps1 -Mode Install
```

See [Suite platform requirements](../../README.md#platform-requirements) before
installing. Published alpha.3 Windows downloads are unsigned and macOS downloads
are not notarized. Provider installation and authentication are separate from
application installation. You can also give your agent the
[installation instructions](../../agent-installation-instruction.md).

## Set up and check your workspace

On the Server host, open a new terminal after installation if needed for `PATH`:

```sh
aixand-server setup
aixand-server start
aixand-server status
aixand-server doctor
```

Setup reviews tools, licenses, workspace paths, and Isolated or Shared tool
installation. Enter the workspace password privately in the interactive prompt.
A configured workspace retains its saved installation mode. Status and doctor
should report the selected workspace's services and any missing prerequisites.

Configure provider software and sign-in when ready:

```sh
aixand-server providers install
aixand-server providers codex login
```

Use provider-specific help for other supported login options. Sign-in alone does
not establish model access; verify it with a completed conversation from Client.
Run `aixand-server logs server` if startup or connection fails.

## Connect from another computer

**Advanced setup:** Server binds loopback port 8753 by default. Use an
[SSH tunnel](docs/installation.md#connect-through-an-ssh-tunnel) or configure an
[HTTPS reverse proxy](docs/installation.md#connect-through-an-https-reverse-proxy).
A plain HTTP LAN address is not a supported production connection. Exact origin,
secure transport, session, and CSRF checks remain enabled.

Client does not start Server or create tunnels. For repeated access, the
[agent installation guide](../../agent-installation-instruction.md#offer-persistent-access-for-a-remote-workspace)
explains how to propose supervised tunnels and Server startup after user login.
Use [connection troubleshooting](docs/installation.md#troubleshoot-a-remote-connection)
for rejected origins, transport errors, or failed live updates.

## Operate and maintain Server

`aixand-server start` runs services in the background; `run` stays attached.
Use `stop` to stop this workspace's services. Optional startup is after user login,
not a system-wide boot service:

```sh
aixand-server startup enable
aixand-server startup status
```

Disable it with `aixand-server startup disable`. Review
[repair, reset, and removal](docs/installation.md#repair-reset-and-removal)
before cleanup. Shared software, workspace data, and provider accounts have
separate ownership and removal choices.

## Develop locally

This path runs source code rather than installing the published application.
From the Suite root, use `./dev.sh prepare` for pinned Python dependencies.
Then, from `apps/server`, with Node 24.15+ and Rust available:

```sh
npm ci
npm run bridge:build
cp -n .env.example .env
npm run start:dev
```

The development API defaults to loopback port 3000. Start
[Suite Web](../web/README.md#develop-locally) and complete local password setup.
Use `npm run workflow:build` when developing workflow bridge features. Run
`npm test` for Vitest checks and `npm run build` to compile the Server. Bridge and
live tests have separate prerequisites in [package.json](package.json).

## Documentation

| Task | Guide |
| --- | --- |
| Install, configure, or maintain Server | [Installation and operation](docs/installation.md) |
| Understand authentication and recover access | [Authentication](docs/authentication.md) |
| Run production source builds | [Production operation](docs/production.md) |
| Extend the backend | [Development](docs/development.md) · [Application composition](agent-bridge/application/README.md) |
| Integrate resources and tools | [Resources](docs/suite-resources.md) · [MCP](docs/mcp.md) |
| Inspect subsystem integration | [Carrier](docs/carrier.md) · [Connect](docs/connect.md) · [Native workflows](docs/native-workflows.md) |
| Understand ownership | [Suite architecture](../../docs/architecture/README.md) |

[Suite](../../README.md) · [Support](../../SUPPORT.md) · [Security](../../SECURITY.md) · [License](../../LICENSE)
