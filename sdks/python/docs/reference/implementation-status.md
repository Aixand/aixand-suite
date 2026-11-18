# Python SDK implementation status and gaps

These distinctions describe the inspected source, not a promise about installed dependency versions or a live environment. The SDK implements local composition and explicit recovery; it does not own durable orchestration.

| Area | Present implementation | Limit or missing evidence |
| --- | --- | --- |
| Agent composition | Module operations, native handles, context views | No mandatory application object or invented manager facade |
| Conversations | Launch, attach, send, readiness, inspect, screen, stop | No transcript/history CRUD; no fork/resume API |
| Resource configuration | `native_config` and CLI passthrough | `mcp`, `project`, `resources`, `application_resources` rejected; truthy `runtime_bindings` rejected |
| Manager queries | Profiles, budgets, metadata | Does not expose manager profile/auth administration as composition APIs |
| Messaging | Native application clients and bound consumers | No synthesized answers; result protocol belongs to application |
| Acceptance | Exact token plus authenticated sender | Proves acceptance only, not work completion |
| Unknown effects | Uncertain input blocks further sends; journal records intent | No auto retry, public uncertainty-clear API, or exactly-once task guarantee |
| Recovery | Explicit restore of same still-running external binding | No private-service restore, launch/resume/fork, or independent durable delivery worker |
| Recovery testing | Source identity and journal guards present | Current tests contain no direct restore coverage |
| Providers | Built-in Codex MCP launch flags | Other providers require callback; fixture is not live-provider qualification |
| Cleanup | Scope stop policy, borrowed-runtime protection, joined managed tasks | Application owns ordinary consumers; abrupt process death is not normal cleanup |
| Security | Claimed inboxes, sender checks, private run directory | No new sandbox, secret redaction, approval automation, or credential revocation layer |
| Execution | Native Undercurrent sessions via manager | Not Runner client, IR compiler, queued workflow execution, or success inference |

## Review checklist by contract

Before changing delivery, inspect both the direct and inbox paths: they share admission but deliberately differ in public wait boundaries. Before changing restoration, add isolated tests for identity mismatch, process replacement, missing/locked journals, pending acceptance, and `submitting` refusal. Before adding resource support, implement the actual manager contract and pre-provisioning validation rather than accepting unused options.

The [composition tests](../../tests/test_composition.py) establish mocked local concurrency, failure, and receipt behavior. The [integration tests](../../tests/test_integration.py) exercise real service boundaries with a deterministic PTY provider when configured. Live [examples](../../examples/team.py) are a separate qualification path and were not executed while authoring these docs.

Source reading path: [exports](../../src/aixand/__init__.py) → [spawn/get/restore](../../src/aixand/agents.py) → [Agent](../../src/aixand/_agent.py) → [Binding](../../src/aixand/_binding.py) → [Connection](../../src/aixand/_connection.py). See [development](../development/verification.md) for exact commands and test ownership.
