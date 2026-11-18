# Explore a project with specialist reviews

Get a project map and test assessment from two delegated agents, then combine
their evidence into a short onboarding report.

## Before you start

Complete [example preparation](prepare.md). Use read-only access; this task needs
no project edits. Running the tests needs command access and may request approval.

## Send this prompt

```text
Use Orchestration MCP to explore this project without changing files.
First inspect the available delegation tools and captured execution context.

Delegate two read-only conversation tasks:
1. Architecture: identify entry points, modules, data flow, and limitations.
2. Tests: run the documented tests and explain coverage and existing failures.

Use the supplied provider, environment, and absolute workspace. Keep each
operation ID stable across retries. Tell each child to submit its report through
its scoped task-result tool. Do not create replacement tasks after a disconnect.

Save a persistent monitor before dispatching, with this full mandate and project.
Use a ready local native Codex supervisor. Limit it to 12 evaluations and 8 actions
per evaluation. After dispatch, checkpoint waiting and finish the current turn.
On retained reports, inspect get_delegated_task and read complete evidence.
Report any failure/blocker; do not answer approvals on my behalf.
Combine the reports into a project map, verified test commands/results, and
three useful next steps in final checkpoint progress. Cite file paths and
distinguish findings from guesses. Return the monitor link and end this turn.
Do not fix the intentional bug.
```

## Check the result

- Two distinct task IDs and accepted reports are available.
- The map identifies `demo.py`, `tasks.py`, and `test_tasks.py`.
- The test report records three tests and the completed-task failure.
- Project files are unchanged. Review the diff if you used a Git checkout.

Open child conversations for pending questions or approvals. An `awaiting_report`
task is still incomplete, even if its conversation has ended.

Next: [Fix a bug and get an independent review](fix-and-review.md).
