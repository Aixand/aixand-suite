# Prepare the orchestration examples

Use a disposable project with a working provider/profile. These examples describe
this checkout; tools depend on your installed backend and captured permissions.

## Get the sample project

With Git and Python 3.11 or newer installed, run in PowerShell or a terminal:

```sh
git clone --depth 1 https://github.com/Aixand/aixand-suite.git aixand-examples
cd aixand-examples/examples/orchestration-demo
python -m unittest -v
```

Use `python3` if needed. Expect three tests with **one intentional failure**:
completed tasks appear in the overdue list. The
[sample README](../../examples/orchestration-demo/README.md) explains the baseline.
Use a fresh copy for each example.

[Add this folder as a Suite project](../guides/projects.md). With Client, clone
and register it on Server. No Suite source build is needed.

## Check orchestration access

1. Start a new conversation with the sample project and your provider/profile.
2. Check **Model → Chat settings → Tools** and the resource readiness report.
   Use the supported Suite controller tools; Basic chat disables application defaults.
3. Ask the agent to inspect its advertised tools before launching work.

| Example | Required tools |
| --- | --- |
| Project exploration and bug fixing | `delegate_conversation_task`, `get_delegated_task` |
| Runner workflow examples | `submit_conversation_workflow`, `inspect_execution_workflow`, `get_execution_workflow_result` |

Runner/effect-host and Carrier must be ready for workflows and delegated results.
If a required tool is unavailable, resolve [resource readiness](../guides/resources.md)
first. Do not launch a separate standalone MCP home to imitate Suite context.

The agent must use the supplied provider, environment, and absolute workspace.
Keep operation IDs stable across retries. Children may request human approval;
answer in Suite. Delegation does not expand their permissions.

Use accepted results to verify delegated work. After a reconnect, inspect retained
task/run IDs before retrying. Never treat a launch receipt, process exit, or final
chat message alone as a delegated result.

Next: [Explore a project with specialist reviews](explore-project.md).

## Supervision and autonomous work

Autonomous examples require `create_monitor`, `get_monitor`, `checkpoint_monitor`,
and watch/lifecycle tools in a **local native Codex** controller. Runner examples
also require the workflow tools above. Other provider conversations can be watched
when supported; they are not automatically supported supervisor backends.

Save the mandate before dispatching. The controller returns the monitor link and
ends its turn. Each supervisor evaluation checkpoints progress and pending IDs,
then ends; reports/timers wake later evaluations. Do not hold a turn open by polling.
Read full evidence before marking completion. An unconfirmed action needs inspection,
not another submission.

Autonomy works within the chosen access policy. Configure permitted commands first;
unavailable authorization or an out-of-scope decision produces **Needs you**.
Evaluation/action/deadline limits bound supervision, not provider billing.
Pause/stop affects future supervision; already running workers need separate cancellation.
Keep the backend and state directory available. Closing Client is supported;
monitoring cannot run while its host is stopped.

Workflow screenshots illustrate authored drafts in the real builder. They do not
show live MCP execution or imply that submission creates a saved canvas automatically.

[Supervision contract](../../apps/server/docs/lifecycles/supervision.md)
