<p align="center">
  <img src="apps/web/public/favicon.svg" width="240" height="240" alt="Aixand logo">
</p>

# Aixand Suite

<p align="center">
  <strong>Your agents, conversations, and tools in one workspace.</strong><br>
  Work with native coding agents, manage conversations and terminals, and organize
  projects and reusable resources on your computer or a separate workspace host.
</p>
<p align="center">
  <a href="https://github.com/Aixand/aixand-suite/releases/tag/suite/v0.1.0-alpha.3">
    <img src="https://img.shields.io/badge/release-0.1.0--alpha.3-orange" alt="Release: 0.1.0-alpha.3">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0">
  </a>
</p>

---

**Contents** · [Capabilities](#what-you-can-do) · [Choose an application](#choose-an-application) ·
[Installation](#installation) · [First workspace](#set-up-your-first-workspace) ·
[Installation modes](#understand-installation-modes) · [Connection FAQ](#connection-faq) · [Updates](#updates) ·
[Development](#local-development) · [Documentation](#documentation)

## What you can do

Work with Codex/OpenCode environments, managed conversations, native terminals,
projects, prompts, skills and MCP tools. Provider capabilities determine available
controls. This **0.1.0-alpha.3** release is for evaluation; Vox source is included,
but voice runtimes/packages are excluded from downloads. See [compatibility](docs/reference/compatibility.md).

## Choose an application

| Application | Purpose | Install |
| --- | --- | --- |
| Aixand Suite (Desktop role) | Interface, local backend and tools; optional Server connection | [Suite](docs/getting-started/install-suite.md) |
| Aixand Server | Host projects, tools and running work | [Server](docs/getting-started/install-server.md) |
| Aixand Client | Interface for an existing Server, without a local backend | [Client](docs/getting-started/install-client.md) |

### Work on one computer

Install Suite and choose **This computer**. No separate Server installation or
manual network configuration is needed.

### Work across computers

Use Server on the workspace host and Client on your desktop. Server owns accounts,
projects and running work; Client creates no tunnel or remote service. Installed
Server does not serve a browser interface at `/`. Follow [remote access](docs/guides/remote-access.md).

## Installation

[Download Suite, Server or Client](https://github.com/Aixand/aixand-suite/releases/tag/suite/v0.1.0-alpha.3).
Native applications include their application runtimes; provider tools/sign-in
are separate. No source checkout or developer toolchain is required.
**Installing with an agent?** Give it [the installation instructions](agent-installation-instruction.md).
That guide owns computer checks, role selection, installer commands, private
sign-in handoffs, remote setup and end-to-end verification.

### Linux and macOS

Choose the application in the [installation guide](docs/getting-started/installation.md).
The role-specific pages contain the native installer commands and expected result.

### Windows

Use the [Suite](docs/getting-started/install-suite.md#windows),
[Server](docs/getting-started/install-server.md#windows) or
[Client](docs/getting-started/install-client.md#windows) PowerShell procedure.

### Platform requirements

Published full Suite/Server/Runner/MCP payloads require Linux glibc 2.35,
macOS 26.5.1 or Windows build 26200. Windows downloads are unsigned; macOS downloads
are not notarized. See [platform and feature scope](docs/reference/compatibility.md#platforms).

## Set up your first workspace

Follow the installed application's setup guide:
[local Suite](docs/guides/configure-suite.md), [Server host](docs/guides/configure-server.md)
or [Client connection](docs/guides/configure-client.md).
Then complete [provider/project onboarding](docs/getting-started/first-workspace.md).
A successful login does not prove model entitlement; verify one completed conversation.

## Understand installation modes

| Mode | Tools and settings |
| --- | --- |
| Isolated (default) | Private workspace tools and component data |
| Shared | Compatible independent tools and normal user manager stores |

Both retain workspace-specific authentication/chat/service state. Setup preserves
its saved mode through restart and repair. Read [installation ownership and paths](apps/server/docs/operations/installation.md#installation-choices)
before changing modes or removing shared data.

### What do standalone and distributed mean?

Local versus remote describes where work runs. Distributed packaging describes
independent product identities, ownership and licenses; it does not require
multiple computers. There is no separate supported standalone packaging edition.

### Use individual components

Runner and Orchestration MCP can be installed independently. SDKs and IR crates
have separate versions and consuming environments. Use the [component catalog](docs/reference/components.md)
and [component guides](docs/README.md#find-a-component) for the owning setup.

## Connection FAQ

### Do I need to configure origins or HTTPS for normal Suite use?

No: choose **This computer**. Shared versus Isolated tools is a separate choice.

### What changes when I use a separate Server?

Provide [SSH](docs/guides/connect-ssh.md) or [HTTPS](docs/guides/connect-https.md).
Server listens on loopback by default; plain HTTP LAN connections are unsupported.
Client does not maintain the tunnel. [Persistent access](agent-installation-instruction.md#offer-persistent-access-for-a-remote-workspace)
needs its own reviewed setup.

### Why is my connection rejected even with the correct password?

Transport, exact Origin, session and CSRF are separate checks. Use the
[connection diagnostics](docs/guides/remote-access.md#connection-errors).

## Updates

[Update guides](docs/guides/updates.md) explain host tools versus native application
updates. Alpha.3 supports signed checks; alpha.1/alpha.2 require an installer upgrade
first. Installation still requires confirmation. See [change history](CHANGELOG.md).

## Local development

From the Suite root:

```sh
./dev.sh prepare
./dev.sh serve --dry-run
```

Prepare uses pinned published dependencies; `--local-sources` selects siblings.
The dry run requires the configured Undercurrent daemon and starts no services.
Follow [development](docs/development/README.md), [dependency ownership](docs/development/dependencies.md)
and [component setup](docs/README.md#find-a-component).

## Documentation

[Documentation home](docs/README.md) organizes installation, task guides,
architecture, examples, component references and maintainer procedures.
The [project-site documentation](https://projects.aixand.org/aixand-suite/docs/)
has a category selector for General and each component. General covers using and
configuring Suite; component docs explain ownership, architecture, lifecycles,
integrations and failure behavior for developers and agents.

| Read about | Source docs |
| --- | --- |
| General | [Suite guides](docs/README.md) |
| Server | [Server](apps/server/docs/README.md) |
| Web | [Web interface](apps/web/docs/README.md) |
| Desktop & Client | [Native applications](apps/desktop/docs/README.md) |
| Vox | [Voice service](services/vox/docs/README.md) |
| Connect | [Provider companion](services/connect/docs/README.md) |
| Orchestration MCP | [Orchestration tools](mcps/orchestration/docs/README.md) |
| Runner | [Workflow execution](workflow/runner/docs/README.md) |
| Workflow IR | [Workflow representation](workflow/ir/docs/README.md) |
| Python SDK | [SDK](sdks/python/docs/README.md) |
| Runner Client | [Python client](workflow/runner/python/docs/README.md) |

Edit these source guides and follow [publication](docs/development/publication.md)
to refresh the site from a committed revision. READMEs provide entry points;
maintainer runbooks, normative specifications, fixtures and policies remain in
this repository even when they are not selected for publication.
Use [support](SUPPORT.md) for reporting and [security](SECURITY.md) for private vulnerabilities.

## AI-assisted development

We use AI tools to generate and revise code and documentation during development
of Aixand Suite and review the resulting work. Maintainers remain responsible
for validation and preserving third-party attribution. We do not knowingly
include proprietary code without permission.

If you identify code that you believe we lack permission to distribute, follow
the [private reporting instructions](SUPPORT.md#report-code-ownership-or-licensing-concerns).
We investigate credible reports and remove or replace material when the evidence
establishes that we lack distribution rights.

## Issues and pull requests

Issues are welcome; external pull requests are not currently accepted. Follow
[participation policy](CONTRIBUTING.md), [support](SUPPORT.md) and the
[code of conduct](CODE_OF_CONDUCT.md).

[All documentation](docs/README.md) · [Changelog](CHANGELOG.md) · [Apache-2.0 license](LICENSE)
