# Source map and focused verification

Start from the advertised contract, follow the backend route into its owning service and select tests that exercise identity and failure boundaries. Static schemas can load without execution SDKs; native integration tests require their real local binaries and isolated homes.

| Change | Source owner | Focused tests |
| --- | --- | --- |
| Registration and optional dependencies | [backend](../../src/orchestration_mcp/backend.py), [optional](../../src/orchestration_mcp/optional.py) | [standalone](../../tests/test_standalone.py), [dependency boundaries](../../tests/test_dependency_boundaries.py) |
| MCP and captured bundle | [CLI](../../src/orchestration_mcp/cli.py), [transport](../../src/orchestration_mcp/transport.py), [publisher](../../src/orchestration_mcp/publisher.py) | [transport](../../tests/test_transport.py), [bundle wire](../../tests/test_bundle_wire.py), [catalog](../../tests/test_bundle_catalog.py) |
| Host and receipts | [broker](../../src/orchestration_mcp/broker.py), [executions](../../src/orchestration_mcp/executions.py) | [host](../../tests/test_host.py), [execution groups](../../tests/test_execution_groups.py), [profiles](../../tests/test_profiles.py) |
| Task state and reports | [delegations](../../src/orchestration_mcp/delegations.py), [task reports](../../src/orchestration_mcp/task_reports.py) | [delegations](../../tests/test_delegations.py), [reports](../../tests/test_task_reports.py) |
| Runner effects | [workflows](../../src/orchestration_mcp/workflows.py) | [execution workflows](../../tests/test_execution_workflows.py) |
| Captured resources | [resources](../../src/orchestration_mcp/resources.py) | [MCP capture](../../tests/test_mcp_resource_capture.py) |
| Environment handover | [sign-in](../../src/orchestration_mcp/signin.py), [Codex settings](../../src/orchestration_mcp/codex_servers.py) | [handover](../../tests/test_signin_handover.py), [settings](../../tests/test_codex_server_settings.py) |

## Commands and evidence

Run package commands exactly as retained in [development](../development.md). For the native integration prerequisites and full discovery command, see [delegation verification](../delegation-workflows.md#verification). The fixture child is [task_agent.py](../../src/orchestration_mcp/fixtures/task_agent.py); it is test machinery, not a production provider.

A skipped optional/native test does not establish runtime support. A fake client verifies a contract and failure path; a real local daemon test adds process/socket evidence. Neither establishes paid provider correctness. Review the actual test output before claiming coverage.

No UI is owned here, so screenshots add no useful evidence. Documentation diagrams describe source control and ownership boundaries, not observed production telemetry.
