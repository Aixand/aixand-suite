# Aixand Orchestration MCP

Give an MCP-capable agent scoped tools over public manager APIs, conversations,
terminals, delegated tasks and Runner workflows. Run independently or forward a
captured Suite contract. Project tools require an application-supplied adapter.
This package is separate from MCP Manager, which manages MCP definitions.

The Python distribution is `aixand-suite-orchestration-mcp`; import
`orchestration_mcp` and run `orchestration-mcp`. Installing tools does not grant
child permissions or approve pending requests.

## When to use Orchestration MCP

Start with installation and a stdio connection below. For ownership and supported
behavior, read the [documentation index](docs/README.md) and
[implementation status](docs/implementation-status.md).

## Installation

Use the [standalone native product installer](https://installer.aixand.org/aixand-suite/orchestration-mcp)
for a managed product, or install the Python package into your own Python
3.11–3.14 environment:

```sh
python -m pip install aixand-suite-orchestration-mcp
orchestration-mcp capabilities --suite off
```

For conversation delegation, install
`python -m pip install "aixand-suite-orchestration-mcp[conversations,tasks]"`.
Terminals, Runner workflows, resources, and devices have separate extras and
runtime prerequisites described in the [tool reference](docs/reference/tool-groups.md#optional-installation-extras). The base package can inspect available
capabilities without starting an agent.

## Verify a first MCP connection

First run `capabilities --suite off` above and inspect the available capabilities.
Configure your MCP client with this stdio process, using its own configuration
format:

| Field | Value |
| --- | --- |
| Command | Absolute path to the installed `orchestration-mcp` executable |
| Arguments | `serve`, `--suite`, `off`, `--home`, `/absolute/path/to/orchestration-home` |

Replace the home with a private local state directory; use a native absolute
Windows path on Windows. Use the same home for later clients. Do not put a shell
command string into an MCP client's executable field.

Connect the client and verify it lists the advertised tools. Begin with a
capability inspection, or a read-only project listing if advertised. Installed optional packages
and configured backends determine which tools appear. A listed tool does not
establish provider authentication or model access.

Disconnecting ends an embedded `serve` process and its process-owned jobs. For
background work that must outlive that connection, use the persistent `host`
mode described in the [tool reference](docs/reference/tool-groups.md#optional-installation-extras). Keep its private connection descriptor and state directory.
Do not start replacement work when a launch or delivery remains uncertain.

For a Suite-connected integration, use the private context supplied by the
application, rather than opening Suite's database yourself. `--suite required`
requires that context; `--suite off` selects independent services. A standalone
home does not become the user's Suite workspace merely because both are on the
same computer.

## Tool groups

See [tool groups, optional extras and CLI configuration](docs/reference/tool-groups.md)
for advertised capabilities and routing. For task reporting and the exact
Carrier/Runner setup, use [delegation and workflows](docs/delegation-workflows.md).

## Resource capture timing

See [resource capture](docs/integrations/resources.md) for explicit revision-pinned
snapshots and [workflow resources](docs/delegation-workflows.md#resource-ownership-and-bounds)
for capture before admission. Legacy stage/workflow capture APIs are retained
application contracts, not current standalone APIs; see
[implementation status](docs/implementation-status.md).

## Local developer commands

Use the [development guide](docs/development.md) for exact local setup/check/test/build
commands, Windows helper, wheel setup and separate managed release lifecycle.

## Project tools and project conversations

See the [project schema reference](docs/reference/tool-groups.md#project-schema-contract)
and [start-then-send example](docs/lifecycles/executions.md#start-then-send).

## Verify delegated completion

Inspect the canonical task result and Runner outcome using the stable mutation
`operation_id`. A launch receipt, finished turn or terminal exit alone does not
establish an accepted task report. Follow
[delegation and recovery](docs/delegation-workflows.md) and
[receipt inspection](docs/lifecycles/receipts.md).

## Component architecture

Read the [component architecture docs](docs/README.md) for ownership, lifecycles,
integrations and source/test maps.

[Suite](../../README.md) · [Support](../../SUPPORT.md) · [License](../../LICENSE)
