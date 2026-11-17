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

- **Work with coding agents.** Configure Codex and OpenCode environments and sign in through their native tools.
- **Keep conversations organized.** Open managed chats, follow their progress, and respond to approval and input requests.
- **Use native terminals.** Run terminal sessions alongside your projects and conversations.
- **Manage reusable resources.** Organize prompts, skills, and MCP definitions through their independent managers.
- **Choose where work runs.** Use a local workspace or connect to a Server on another computer.

This is an early **0.1.0-alpha.3** release for evaluation. Provider capabilities
and verified adapters determine which operations are available. Vox source is
included, but voice runtimes and Vox packages are excluded from release downloads.
See [architecture and qualification limits](docs/architecture.md) for integration
boundaries and work that still needs qualification.

## Choose an application

The download release contains three applications. **Aixand Suite** is the full
desktop application; source and packaging guides also call this role **Desktop**.

| Application | What it includes | Choose it when… |
| --- | --- | --- |
| **Aixand Suite** | Desktop interface, local backend, and product runtimes | You want to work on this computer, with the option to connect to a Server. |
| **Aixand Server** | Backend and product runtimes, managed from a terminal | You want this computer to host the workspace and run its agents and tools. |
| **Aixand Client** | Desktop interface and connection shell | You only need to connect to an existing Server, without installing a local backend. |

### Work on one computer

Install **Aixand Suite** and choose **This computer** in the launcher. The
interface and backend run locally. Your projects, agent environments, and running
work belong to this computer. You do not need a separate Server installation.

### Work across computers

Install **Aixand Server** on the computer that will hold your projects and run
your tools. Install **Aixand Client** on the computer you will use to access it.
The full Suite application can also connect to that Server.

The Server owns the workspace, provider accounts, and running work. Client
provides the interface; it does not start or stop the host's services. Server
includes no web interface at `/`, so opening its address in a browser does not
replace Client.

Use HTTPS for a network connection, or an HTTP loopback address through an
existing SSH tunnel. Client does not create SSH tunnels. Follow
[Server connection setup](apps/server/docs/installation.md#setup-and-operation)
and [Client connection requirements](apps/web/docs/client.md) before connecting.
A Server workspace has one owner and runs work as its OS user; it does not
provide multi-user isolation.

## Installation

Want your agent to handle setup? Give it the
[step-by-step agent installation instructions](agent-installation-instruction.md).
The guide includes installation, private sign-in handoffs, and verification.

**[Download Aixand Suite, Server, or Client](https://github.com/Aixand/aixand-suite/releases/tag/suite/v0.1.0-alpha.3)**
for Windows x86_64, macOS ARM64, or Linux x86_64. Choose the application and
platform from the download table at the top of the release. Installed
applications include their required application runtimes; no source checkout or
developer toolchain is needed. Provider software and authentication are separate
setup steps.

### Linux and macOS

From any directory, run the command for your chosen application:

```sh
# Full Suite: local workspaces or Server connections.
curl -fsSL https://installer.aixand.org/aixand-suite | sh -s -- --install

# Server: host the workspace.
curl -fsSL https://installer.aixand.org/aixand-suite/server | sh -s -- --install

# Client: connect to an existing Server.
curl -fsSL https://installer.aixand.org/aixand-suite/client | sh -s -- --install
```

Run only the command for the application you need. Without `--install`, the
script downloads and verifies the package for review. Linux Suite/Client use
Debian packages; Server also supports Fedora. On macOS, the installer opens a
disk image for you to copy the application.

### Windows

Download the chosen application's installer from the
[release download table](https://github.com/Aixand/aixand-suite/releases/tag/suite/v0.1.0-alpha.3).
Alternatively, run the PowerShell commands for your chosen application:

```powershell
# Full Suite: local workspaces or Server connections.
Invoke-WebRequest -UseBasicParsing 'https://installer.aixand.org/aixand-suite/install.ps1' -OutFile install-aixand-suite.ps1
.\install-aixand-suite.ps1 -Mode Install

# Server: host the workspace.
Invoke-WebRequest -UseBasicParsing 'https://installer.aixand.org/aixand-suite/server/install.ps1' -OutFile install-aixand-server.ps1
.\install-aixand-server.ps1 -Mode Install

# Client: connect to an existing Server.
Invoke-WebRequest -UseBasicParsing 'https://installer.aixand.org/aixand-suite/client/install.ps1' -OutFile install-aixand-client.ps1
.\install-aixand-client.ps1 -Mode Install
```

Run only the command pair for the application you need.

### Platform requirements

The published full Suite, Server, Runner, and MCP bundles require glibc 2.35 on
Linux, macOS 26.5.1, or Windows build 26200 or newer. These minimums reflect the
hosts used to qualify their product payloads. Older-host CI builds are
unpublished candidates, not additional release support.

Windows downloads are unsigned and macOS downloads are not notarized. Your
operating system may warn or block installation.

## Set up your first workspace

For a local workspace:

1. Open **Aixand Suite** and choose **This computer**.
2. Review the workspace location and choose **Isolated** or **Shared** installation, as explained below.
3. Complete tool setup and configure the workspace password.
4. Select Codex, OpenCode, or both, then install or select the provider software and complete native sign-in.
5. Select or register a project, then open a conversation or native terminal.

A successful sign-in does not establish model entitlement. Your first successful
conversation verifies access for the selected provider and environment. See
[native agent onboarding](docs/onboarding.md) for readiness and provider limits.

For a Server workspace, run these commands on the host after installation:

```sh
aixand-server setup
aixand-server start
aixand-server status
```

Open a new terminal after installation if the command is not yet on `PATH`.
Check that status reports the workspace services, then configure
[remote access](apps/server/docs/installation.md#setup-and-operation).
Open Client, save the Server address, and sign in with the workspace password.
Use `aixand-server doctor` and `aixand-server logs server` on the host to diagnose
startup problems. See [Server installation and operation](apps/server/docs/installation.md)
for provider setup, service startup, maintenance, and removal.

## Understand installation modes

There are two separate choices: **where your workspace runs** and **where its
tools and settings are installed**. A local workspace can use either installation
mode; so can a Server workspace.

| Setup mode | Tools and settings | Use it when… |
| --- | --- | --- |
| **Isolated** (default) | Private tools under `<workspace>/software/products`, with manager settings and tool data in the workspace | You want a self-contained workspace with tools kept separate from your normal user setup. |
| **Shared** | Compatible existing tools and normal user manager settings; missing products go into the independent product store | You want Suite to use tools and settings also available outside this workspace. |

Authentication, chats, Carrier, and workflow service state remain specific to the
workspace in both modes. Setup saves your choice and retains it through restarts,
repair, and updates. Review removal choices carefully when tools or data are shared.
See [installation choices](apps/server/docs/installation.md#installation-choices)
for exact paths, settings reuse, and ownership rules.

### What do standalone and distributed mean?

If you mean **using Suite by itself on one computer**, install the full Suite
and choose a local workspace. If you mean **using a separate host**, choose
Server plus Client as described above.

In packaging documentation, **distributed** has a different meaning: Suite's
underlying products retain independent installation identities, state ownership,
and licenses. Current packages use this model in both Isolated and Shared setup.
There is no separate supported `standalone` packaging edition to choose.
A distributed product installation does not require multiple computers.

### Use individual components

You can also install [Runner](https://installer.aixand.org/aixand-suite/runner)
or [orchestration MCP](https://installer.aixand.org/aixand-suite/orchestration-mcp)
independently of the desktop application. Their installers use the same qualified
product handoffs and preserve shared-store ownership.

Python integrations can install `aixand-suite-python`,
`aixand-suite-runner-client`, `aixand-suite-connect`, or
`aixand-suite-orchestration-mcp` in their own project environment. Runner and IR
crates are published on crates.io. Components have independent versions; IR
remains at `0.1.0-alpha.1` in this Suite release. See the
[component release contract](docs/reference/components.md) for package boundaries.

## Connection FAQ

### Do I need to configure origins or HTTPS for normal Suite use?

No. In the full Suite, choose **This computer**. The application manages its
local connection; you do not need to configure origins, HTTPS, or a reverse
proxy. Provider installation and sign-in remain separate setup steps.
Choosing Shared tool installation does not require remote network configuration.

### What changes when I use a separate Server?

**Advanced users:** when Client or Suite connects to a separately hosted Server,
you must provide an SSH tunnel or an HTTPS reverse proxy. Server listens on
loopback by default. A plain HTTP LAN address such as `http://192.168.1.10:8753`
is not a supported production connection.

Use the [SSH connection steps](apps/server/docs/installation.md#connect-through-an-ssh-tunnel)
for access through an existing SSH account, or the
[HTTPS configuration steps](apps/server/docs/installation.md#connect-through-an-https-reverse-proxy)
for a domain with a trusted TLS certificate. Client does not create tunnels or
configure the proxy for you.

### Why is my connection rejected even with the correct password?

Server checks transport security, allowed origins, and authentication separately.
Origins must match the configured scheme, hostname, and port exactly. Native
Client sends the selected Server address's origin. Adding your client computer's
IP address to the allowlist does not authorize that connection.

See [connection troubleshooting](apps/server/docs/installation.md#troubleshoot-a-remote-connection)
for origin, HTTPS, session, and WebSocket failures.

## Updates

Open **Settings → Updates → Check all updates** to review application, workspace
component, and installed tool updates. Published alpha.3 installers enable signed
update checks. Installation requires confirmation.

Client has **Client updates** in its connection window. Workspace tools are
managed on the workspace host, which may be another computer. On Windows, keep
the owning user signed in while installing updates.

Upgrade from alpha.1 or alpha.2 with the installer once; those versions have
update checks disabled. Independently selected tool releases survive repair,
and shared tools retain their ownership and maintenance requirements.
See [update behavior](apps/web/docs/updates.md) and the [changelog](CHANGELOG.md).

## Local development

From the Suite repository root, prepare the private Python environment using
published dependencies:

```sh
./dev.sh prepare
```

Use `./dev.sh prepare --local-sources` to explicitly select sibling source
checkouts. See [dependency preparation and release inputs](docs/dependencies.md)
for prerequisites and dependency ownership.

With the configured Undercurrent daemon reachable, inspect startup prerequisites
and planned service commands without starting them:

```sh
./dev.sh serve --dry-run
```

An offline daemon makes this prerequisite check fail. Component build and test
commands are listed in the [documentation index](docs/README.md).

| Source | Responsibility |
| --- | --- |
| `apps/server` | Application backend and workspace coordination |
| `apps/web` | Browser frontend |
| `apps/desktop` | Native desktop shell |
| `services/connect` | Remote device transport and companion |
| `services/vox` | Voice interface |
| `workflow/runner` | Durable workflow service |
| `workflow/ir` | Workflow model and execution engine |
| `sdks/python` | Optional Python composition SDK |
| `mcps/orchestration` | Orchestration MCP product |

External managers, Carrier, Undercurrent, and shared Python libraries use the
published dependencies pinned in `scripts/runtime/dependencies.lock.json`.
Runner, IR, and orchestration MCP are built from this repository.

## Documentation

| I want to… | Guide |
| --- | --- |
| Choose an application and understand its payload | [Installation roles](apps/web/docs/installation-editions.md) |
| Set up or maintain a workspace host | [Server installation](apps/server/docs/installation.md) |
| Connect without installing a local backend | [Aixand Client](apps/web/docs/client.md) |
| Configure native agent environments | [Agent onboarding](docs/onboarding.md) |
| Understand component responsibilities | [Architecture](docs/architecture.md) · [Composition decision](docs/decisions/0001-suite-composition.md) |
| Build or integrate components | [Documentation index](docs/README.md) · [Component contract](docs/reference/components.md) |
| Report a problem | [Support](SUPPORT.md) |

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

Bug reports, documentation issues, feature requests, and usage questions are
welcome. We are not accepting pull requests for now because our team lacks the
capacity to review external contributions. See the [participation policy](CONTRIBUTING.md)
and [support guide](SUPPORT.md).

---

[All documentation](docs/README.md) · [Support](SUPPORT.md) · [Changelog](CHANGELOG.md) ·
[Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Apache-2.0 license](LICENSE)
