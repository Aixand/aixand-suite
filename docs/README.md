# Suite documentation

This documentation describes the development beta and adopts documentation
standard **0.1.0**. Start with [setup and dependencies](dependencies.md), then
[local agent onboarding](onboarding.md). Packaging and source checks do not imply
a public release, live provider qualification or complete v0.4 orchestration.

## Find a task or contract

- [Install Aixand with your agent](../agent-installation-instruction.md)
- [Architecture and state ownership](architecture.md)
- [Agent integration and resource boundaries](agent-integration.md)
- [Conversation Manager integration](chat-manager-integration.md)
- [Component release contract](reference/components.md)
- [Release workflows and registry publishing](development/releases.md)
- [Documentation validation](development/documentation.md)
- [Documentation standard](_standards/standard.md)

## Component ownership

Each component owns its local contracts. Suite owns shared setup and integration.
Run commands from the Suite root unless a component guide states otherwise.

| Source boundary | Entry point and responsibility | Focused verification |
| --- | --- | --- |
| `apps/server` | [Server](../apps/server/README.md): workspace, auth, application coordination | `npm --prefix apps/server test` |
| `apps/web` | [Web](../apps/web/README.md): browser interactions and assets | `npm --prefix apps/web run build` |
| `apps/desktop` | [Desktop](../apps/desktop/README.md): native shell around web assets | inspect `apps/desktop/package.json` platform scripts |
| `mcps/orchestration` | [MCP](../mcps/orchestration/README.md): domain tools and task results | package [development checks](../mcps/orchestration/docs/development.md) |
| `services/connect` | [Connect](../services/connect/README.md): pairing and transport | `python3 -m unittest discover -s services/connect/tests` |
| `services/vox` | [Vox](../services/vox/README.md): speech integration | component test prerequisites in its README |
| `workflow/runner` | [Runner](../workflow/runner/README.md): durable workflow lifecycle | `cargo test --locked --manifest-path workflow/runner/Cargo.toml` |
| `workflow/ir` | [IR](../workflow/ir/README.md): model and execution semantics | `cargo test --locked --manifest-path workflow/ir/Cargo.toml` |
| `sdks/python` | [Python SDK](../sdks/python/README.md): optional public API composition | `python3 -m unittest discover -s sdks/python/tests` |

External managers retain domain state; Carrier owns message delivery and
Undercurrent owns native process supervision. See [dependencies](dependencies.md).
Participation is [issues only](../CONTRIBUTING.md); external pull requests are not accepted.
