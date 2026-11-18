# Develop and verify the SDK

Start with the affected contract, then select tests by its domain owner. The source unit tests replace manager/runtime behavior; service integration uses isolated real services and a deterministic provider. Neither establishes live provider correctness.

## Setup and exact existing commands

From the Suite root, `./dev.sh prepare` prepares the workspace environment. Use `.venv/bin/python` or Windows `.venv/Scripts/python.exe`. For SDK-only setup run `uv sync --locked` in `sdks/python`. Consumer installation remains:

```sh
python -m pip install aixand-suite-python
```

From `sdks/python`, in the prepared environment:

```sh
python -m unittest discover -s tests -v
UC_TEST_BIN="$(cd ../../../undercurrent/target/debug && pwd)" \
  python -m unittest discover -s tests -p test_integration.py -v
```

The second command is retained exactly from the README. `UC_TEST_BIN` must contain matching `uc-daemon` and `uc-python-bridge` binaries. Without it, the `IntegrationTests` class skips; the ordinary private-Carrier mailbox test is not under that skip and can start a local subprocess. Use only `-p test_composition.py` for the mocked unit subset.

`UNDERCURRENT_PYTHON_BRIDGE` and `UNDERCURRENT_HOME` select runtime installation. `AGENT_MANAGER_CONFIG` and `AGENT_MANAGER_HOME` select manager stores. Installation does not start the daemon, install provider executables, or authenticate a profile.

### Native profile preparation

Requires Python 3.11+ and compatible published Agent Manager, Carrier and
Undercurrent Python packages. Distribution names are `aixand-agent-manager`,
`aixand-carrier-mcp` and `aixand-undercurrent-sdk`; their Python import names remain
`agent_manager`, `carrier` and `undercurrent`.

From the Suite root, run `./dev.sh prepare`, then use `.venv/bin/python` (Windows:
`.venv/Scripts/python.exe`). For SDK-only development, run `uv sync --locked` in
this directory. External packages resolve from the package index by default.

Use the compatible independently installed Undercurrent daemon and bridge.
Set `UNDERCURRENT_PYTHON_BRIDGE` and `UNDERCURRENT_HOME` to select another
installation. Aixand does not automatically start an Undercurrent daemon.

Prepare and authenticate a native environment/profile through your installed
Agent Manager, or use an existing one. The example below assumes an authenticated
profile named `research`. Use your actual profile name, or `profile=None` for
Agent Manager's automatic selection. Suite users can follow
[native onboarding](../../../../docs/getting-started/first-workspace.md); SDK-only users should use their
installed Agent Manager's help and profile/login interfaces. There is no separate
saved-login library to create for this SDK.

The existing `AGENT_MANAGER_CONFIG` and `AGENT_MANAGER_HOME` settings are honored.
Update your separately installed `agent` CLI from the Agent Manager repository
before mixing CLI and SDK launches against the same registry.

## Source and test map

| Change | Read source | Focused evidence |
| --- | --- | --- |
| Public names/packaging | [exports](../../src/aixand/__init__.py), [pyproject](../../pyproject.toml) | Import/package compatibility; `py.typed` retained |
| Context/native launch | [agents](../../src/aixand/agents.py) | `test_scoped_context_forwards_maps_and_keeps_owner_lifetime`, `test_native_configuration_reaches_agent_manager` |
| Receipts/input locks | [Agent](../../src/aixand/_agent.py) | Direct/default/foreign receipt and concurrent send tests |
| Unknown outcomes | [Agent](../../src/aixand/_agent.py), [Binding](../../src/aixand/_binding.py) | Canceled write, known-absent, uncertain delivery tests |
| Delivery protocol | [Binding](../../src/aixand/_binding.py) | Acceptance sender checks, ack failure redelivery, direct/consumer serialization |
| Scope teardown | [Connection](../../src/aixand/_connection.py) | Borrowed runtime, stop-owned-only, inflight cancellation, cross-loop tests |
| Supervision | [Binding](../../src/aixand/_binding.py), [Connection](../../src/aixand/_connection.py) | Consumer failure interrupts wait and surfaces at close |
| Services/MCP | [Carrier resources](../../src/aixand/_carrier.py) | [integration suite](../../tests/test_integration.py), [fixture provider](../../tests/integration_provider.py) |

All named unit cases are in [test_composition.py](../../tests/test_composition.py). Test names are identifiers rather than Markdown anchors into Python files.

## Examples are different evidence

| Example | Behavior and limitation |
| --- | --- |
| [research.py](../../examples/research.py) | Two live direct turns, diagnostic screen, default-scope cleanup; screen is not a result contract |
| [team.py](../../examples/team.py) | Private Carrier, Brain/Implementer, correlated coordinator reply, sender check, result.json, acknowledgment, owned session cleanup |
| [integration_provider.py](../../tests/integration_provider.py) | Deterministic PTY display and real Carrier MCP calls; no paid provider |

Retained live example commands from `sdks/python`:

```sh
python examples/research.py --profile backup --cwd ../../../manager-suites/agent-manager
python examples/team.py --profile backup --cwd ../../../manager-suites/agent-manager
```

These require a real authenticated profile and may consume quota. They were not run for this documentation task. Native approvals may require `uc attach`; this SDK does not answer them automatically. The team protocol validates who replied and to which job, while application-specific result quality remains the caller's responsibility.

## Documentation maintenance

The [publication manifest](../publication.json) is relative to this docs directory and retains `python-sdk/development`, `python-sdk/composition`, and the existing lifecycle route. Preserve README heading anchors and existing reference contracts. Changes to restore or resource support should update [implementation status](../reference/implementation-status.md) with focused tests before claiming support.
