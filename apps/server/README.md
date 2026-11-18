# Aixand Server

Server hosts workspace APIs and live events, coordinating independent managers.
Agents and commands run on its host. The installed Server has no browser frontend
or desktop interface; connect with Client or full Suite.

## When to use Server

Use Server for a dedicated or remote workspace host. For a local desktop workspace,
choose [Suite](../../README.md#choose-an-application). The workspace password grants
the host OS user's authority; it does not provide multi-user account isolation.

## Installation

Follow [Server installation](../../docs/getting-started/install-server.md) for
installer commands, platform requirements and release caveats. Provider installation
and authentication are separate from application installation.

## Set up and check your workspace

Follow [Server configuration](../../docs/guides/configure-server.md) and
[provider setup](docs/operations/installation.md#provider-setup).
Verify provider access with a completed conversation from Client.

## Connect from another computer

Choose an [SSH tunnel](../../docs/guides/connect-ssh.md) or
[HTTPS proxy](../../docs/guides/connect-https.md). Client creates no tunnels and
starts no remote services. See [connection troubleshooting](docs/operations/installation.md#troubleshoot-a-remote-connection).

## Operate and maintain Server

Use [setup and operation](docs/operations/installation.md#setup-and-operation)
and review [repair, reset and removal](docs/operations/installation.md#repair-reset-and-removal)
before cleanup. [Startup after login](../../docs/guides/configure-server.md#optional-startup-after-login)
is optional and separate from client-side tunnel startup.

## Develop locally

Use [local bootstrap and checks](docs/development/local-development.md#bootstrap-locally)
for the exact source setup sequence, then start [Web](../web/README.md#develop-locally).

## Documentation

| Task | Guide |
| --- | --- |
| Architecture and ownership | [Component map](docs/README.md) |
| Install and operate | [Installation reference](docs/operations/installation.md) |
| Recover access | [Authentication runbook](docs/operations/authentication.md) |
| Serve production source builds | [Production runbook](docs/operations/production.md) |
| Extend Server | [Development](docs/development/local-development.md) · [Application services](agent-bridge/application/README.md) |

[Suite](../../README.md) · [Support](../../SUPPORT.md) · [Security](../../SECURITY.md) · [License](../../LICENSE)
