# Examples

Runnable examples stay with their owning components. Follow each linked guide
for prerequisites, commands, expected results, and cleanup.

## Application tasks

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
