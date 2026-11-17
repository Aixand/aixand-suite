# Aixand Suite

A workspace application composing independent agent, conversation and resource
managers. The v0.1.0-alpha.3 provider scope is Codex and OpenCode.

This is an early alpha for evaluation. Windows downloads are unsigned and macOS
downloads are not notarized, so operating systems may warn or block installation.
Signed update checks are enabled in the published alpha.3 installers. Updates
are installed only after confirmation. Vox source is included; voice runtimes and Vox
packages are excluded from this alpha's release downloads.

Download **[Aixand — all installers](https://github.com/Aixand/aixand-suite/releases/tag/suite/v0.1.0-alpha.3)**.
This main download release includes **Aixand Suite** (everything locally),
**Aixand Client** (connect to an existing Server), and **Aixand Server** (host the
workspace), each for Windows x86_64, macOS ARM64 and Linux x86_64. Choose your
application and platform from the download table at the top of the release.
Individual component releases remain available for independent updates.

Open **Settings → Updates → Check all updates** to review application, workspace
component, and installed tool updates. Workspace tools are managed on the
workspace host, which may be a different computer from Client. On Windows, keep
the owning user signed in while installing updates.

Upgrade from alpha.1 or alpha.2 with the installer once; those versions have
update checks disabled. Independently selected tool releases survive repair,
and shared tools retain their ownership and maintenance requirements.

The published full Suite, Server, Runner and MCP bundles currently require
glibc 2.35 on Linux, macOS 26.5.1, or Windows build 26200 or newer. These
conservative minimums reflect the hosts used to qualify their product payloads.
Older-host CI builds are unpublished candidates, not additional release support.

On Linux/macOS, start the full native installer with:

```sh
curl -fsSL https://installer.aixand.org/aixand-suite | sh -s -- --install
```

Use `/aixand-suite/server` for Server or `/aixand-suite/client` for Client.
Without `--install`, the script downloads and verifies the package for review.
Linux Desktop/Client use Debian packages; Server also supports Fedora.
macOS opens a disk image for the user to copy the application.

On Windows, download and run the PowerShell wrapper:

```powershell
Invoke-WebRequest -UseBasicParsing 'https://installer.aixand.org/aixand-suite/install.ps1' -OutFile install-aixand-suite.ps1
.\install-aixand-suite.ps1 -Mode Install
```

Standalone [Runner](https://installer.aixand.org/aixand-suite/runner) and
[orchestration MCP](https://installer.aixand.org/aixand-suite/orchestration-mcp)
use the same qualified product handoffs as Suite. Their installers preserve
shared-store ownership. SDK, Runner client, Connect, IR, and Web routes under
`/aixand-suite/` provide browser-readable registry or asset instructions.

Components have independent releases. Python consumers install
`aixand-suite-python`, `aixand-suite-runner-client`, `aixand-suite-connect`, or
`aixand-suite-orchestration-mcp` from PyPI in their own project environment.
Runner and IR crates are published on crates.io; IR remains at
`0.1.0-alpha.1` in this Suite release. See the
[component release contract](docs/reference/components.md) and
[changelog](CHANGELOG.md) for version and security changes.

Read [the architecture](docs/architecture.md) for ownership,
component interactions, the repository layout and remaining integration work.
The accepted boundaries, development rules and beta scope are recorded in
[the architecture decision record](docs/decisions/0001-suite-composition.md).

| Current source | Purpose |
| --- | --- |
| `apps/server` | Application backend and workspace coordination |
| `apps/web` | Browser frontend |
| `services/connect` | Remote device transport and companion |
| `services/vox` | Voice interface |
| `workflow/runner` | Durable workflow service |
| `workflow/ir` | Workflow model and execution engine |
| `sdks/python` | Optional Python composition SDK |
| `apps/desktop` | Tauri desktop shell |
| `mcps/orchestration` | Orchestration MCP product |

External managers, Carrier, Undercurrent and shared Python libraries use the
published dependencies pinned in `scripts/runtime/dependencies.lock.json`.
Runner, IR and orchestration MCP are built from this repository.
The [documentation index](docs/README.md) maps component ownership and reader tasks.

Run `./dev.sh prepare` to create Suite's private Python environment from published
packages. `./dev.sh prepare --local-sources` explicitly selects sibling source
checkouts for contributor work. See [dependency preparation and release inputs](docs/dependencies.md).

With the configured Undercurrent daemon reachable, use `./dev.sh serve --dry-run`
to check prerequisites and inspect planned service commands without starting them.
An offline daemon makes this prerequisite check fail.
See each component's README for its build and development commands.

Packaging defines three roles: **Desktop** (local workspace or Server),
**Client** (frontend only, Server connections), and **Server** (backend only).
See [Client packaging and behavior](apps/web/docs/client.md) and
[Server installation](apps/server/docs/installation.md).
