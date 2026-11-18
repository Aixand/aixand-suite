# Examples

Use Suite to delegate useful work and inspect the accepted results. Start with
[example preparation](../examples/prepare.md), then choose a task.

| Example | Orchestration capability |
| --- | --- |
| [Explore a project](../examples/explore-project.md) | Parallel specialist tasks and accepted reports |
| [Fix a bug and review it](../examples/fix-and-review.md) | Implementation followed by independent verification |
| [Run a project health check](../examples/project-health.md) | Runner dependencies and canonical workflow results |
| [Fix a bug autonomously](../examples/autonomous-fix.md) | Persistent supervision, repair, parallel tests/review, final evidence |
| [Build a feature](../examples/feature-pipeline.md) | Eight-stage workflow with parallel analysis and verification |
| [Prepare a release decision](../examples/release-readiness.md) | Parallel checks joined into an evidence-based GO/NO-GO |
| [Supervise existing work](../examples/supervise-work.md) | Watch a worker, request corrections, verify, obtain a brief |
| [Watch regressions](../examples/scheduled-checks.md) | Timer-based supervision of repeated test/triage workflows |

These are copyable prompts, not recorded live outcomes. Agent runs require
provider access and can consume quota.

## Other application tasks

| Task | Guide |
| --- | --- |
| First provider response | [First workspace](../getting-started/first-workspace.md) |
| Check terminal execution | [Terminals](terminals.md) |
| Connect Client to Server | [Remote access](remote-access.md) |
| Transfer a file/project | [Connect](../../services/connect/README.md#verify-your-first-transfer) |
| Start a voice call | [Vox](../../services/vox/README.md#verify-a-first-call); separate source setup, excluded from alpha.3 downloads |

## Run a workflow without a provider

Use the [Runner verifier tutorial](../../workflow/runner/README.md#run-the-mvp).
It needs no agent account. Source:
[workflow](../../workflow/runner/examples/verify.json) ·
[inputs](../../workflow/runner/examples/inputs.json).

For Python submission, use the [Runner Client walkthrough](../../workflow/runner/python/README.md#submit-your-first-job)
and [script](../../workflow/runner/examples/submit.py).

## Code integrations

| Example | Prerequisites |
| --- | --- |
| [Data-only IR](../../workflow/ir/README.md#try-it) | Rust; no provider |
| [Conditional branches](../../workflow/ir/examples/branching/README.md) | IR toolchain |
| [Python agents and Carrier replies](../../sdks/python/README.md#runnable-examples) | Native runtime, authenticated profile, provider quota |
| [Hand-authored agent workflow](../../workflow/ir/examples/real-agent/README.md) | SDK adapter and live provider setup |
| [Python-to-IR lowering](../../workflow/ir/examples/python/README.md) | Frontend feature; executing generated agent workflows needs live setup |

Use disposable projects. Check the final result, then perform the documented
cleanup. Existing example evidence is not a guarantee for another platform.

New component examples belong in that component's `examples/`. Use root
`examples/` only for runnable cross-component integrations. Link to one executable
source rather than copying it into several guides.
