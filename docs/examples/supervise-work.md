# Supervise an existing implementation

Let a supervisor check another agent's work, request corrections, and obtain an
independent review. It follows the saved goal instead of a fixed sequence alone.

Use an existing implementation conversation with explicit requirements. Open a
new controller conversation in the same project. Complete the
[supervision prerequisites](prepare.md#supervision-and-autonomous-work).

## Send this prompt

Replace `WORKER_CHAT_ID` with the existing conversation's exact ID or Suite link.

```text
Supervise WORKER_CHAT_ID until its requested implementation is verified.
First resolve the exact conversation and read its requirements and existing work.
If its target or acceptance criteria are ambiguous, ask me before creating anything.

Create one persistent monitor with the complete mandate and exact worker ID.
Use a local native Codex supervisor. Limit it to 20 evaluations, 8 actions per
evaluation, and two corrective follow-ups. Do not launch a replacement worker.

Watch the existing worker. When it finishes, read its complete report and inspect
its actual changes. If requirements are missing, send a focused correction to the
same worker. Wait on that exact follow-up receipt before evaluating again.
Only one conversation may edit the project at a time.

Once it appears ready, run a read-only verification workflow: tests and independent
review in parallel, then a verdict depending on both reports. Inspect canonical
Runner results and full evidence, including any blocking findings.
If verified, ask the original worker for a short final brief. Wait for that new
receipt's result, check it against the evidence, and deliver it in checkpoint progress.
If verification fails or the correction limit is reached, use needs_input.

Checkpoint exact IDs, pending dependencies, and next actions before ending each
evaluation. Resume on observations; do not poll or sleep. No commits, pushes,
new dependencies, or permission escalation. Return the monitor link and end this turn.
```

## Check and control supervision

Open **Supervising** in the controller chat or **Supervised by** in the worker.
Inspect the mandate, full evidence, follow-up receipts, and final brief.

- **Pause** stops new supervisory actions; existing worker work can continue.
- Send a new direction to update the existing mandate.
- **Stop** ends future supervision; cancel worker tasks separately if needed.

Closing Client does not stop the host. Keep Suite's backend running. After a host
restart, inspect the same monitor before starting anything new.

[Supervision reference](../../apps/server/docs/lifecycles/supervision.md)

Next: [Watch regressions for a fixed period](scheduled-checks.md).
