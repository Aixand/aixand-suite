# Aixand Suite

A workspace application composing independent agent, conversation and resource
managers. The v0.1.0-alpha.1 provider scope is Codex and OpenCode.

This is an early alpha for evaluation. Windows downloads are unsigned and macOS
downloads are not notarized, so operating systems may warn or block installation.
Automatic updates remain disabled. Vox source is included; voice runtimes and Vox
packages are excluded from this alpha's release downloads.

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
