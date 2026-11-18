# Fix a bug and get an independent review

Delegate a focused fix, then use a separate reviewer to check the change and tests.
Only one agent edits the project at a time.

## Before you start

Complete [example preparation](prepare.md) with a fresh sample. Select workspace
access for the implementation and review the command approval policy.
Keep the reviewer read-only. Delegation cannot grant permissions the backend lacks.

## Send this prompt

```text
Fix this sample project's bug using Orchestration MCP delegation:
completed tasks must not appear in overdue_tasks, and tasks due today must
remain excluded. Confirm delegation and monitor tools are available. Save this
full mandate in a persistent monitor before dispatching. Use local native Codex
supervision, at most 16 evaluations, 8 actions each, and no automatic repair retries.

Delegate one implementation task. Ask it to reproduce the failing test,
make the smallest fix, run the tests, and submit its evidence through the
scoped task-result tool. Do not weaken or remove existing tests.

Checkpoint waiting and end each evaluation after dispatch. On the returned report,
inspect get_delegated_task for the accepted implementation result. If it fails,
stop and explain the blocker. After it completes, delegate a separate read-only
review task with the report and changed file paths. The reviewer must inspect
the actual files, rerun tests, and report regressions or missing coverage.
Do not let the implementation and review edit concurrently.

Use the captured provider, environment, and workspace; keep operation IDs stable
across retries. Leave approvals to me. Read both accepted reports and inspect
the final diff yourself. Deliver changes, test results, and findings in checkpoint
progress. Return the monitor link and end this turn.
Do not commit, push, install dependencies, or change unrelated files.
```

## Check the result

1. Inspect separate accepted implementation and review reports.
2. Run `python -m unittest -v` in the sample folder: all three tests should pass.
3. Run `python demo.py`: expect only `Write release notes`.
4. Inspect the diff: overdue filtering excludes completed tasks without weakening tests.

A completed report can contain review findings. Resolve them before accepting the
fix. Keep the reports for comparison; discard the disposable project when finished.

Next: [Run a project health check](project-health.md).
