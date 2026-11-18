# Troubleshooting

Check the selected workspace first. Server commands and provider setup run on
that host, even when you use Client on another computer.

## Connection and sign-in

| Problem | What to do |
| --- | --- |
| Installation or launch fails | Check [platform requirements](../reference/compatibility.md) and the installer error. |
| Client cannot reach Server | Check Server status, its saved address, and the SSH tunnel or HTTPS proxy. Follow [remote access](remote-access.md). |
| Password accepted but access rejected | Check the exact origin, HTTPS, trusted proxy peers, and session settings in [connection troubleshooting](../../apps/server/docs/operations/installation.md#troubleshoot-a-remote-connection). |
| Server password forgotten | Run `aixand-server password` on its host and use the private prompt. Keep authentication files. |
| Provider sign-in is pending | Return to the retained sign-in terminal and finish its instructions. See [profiles and sign-in](../onboarding/profiles-sign-in.md). |
| Conversation fails after sign-in | Confirm its provider/profile, quota, model access, and the displayed provider error. |

## Conversations, projects, and tools

| Problem | What to do |
| --- | --- |
| Conversation seems stuck | Check pending approvals and queued messages. Reopen the existing conversation before starting another. See [conversation controls](conversation-controls.md). |
| Project folder is missing | Check that the folder exists and is accessible on the workspace host. A Client folder is not automatically available on Server. See [projects](projects.md). |
| Resource is missing | Check its owning manager, preparation, and supported [delivery path](resources.md). |
| Terminal will not attach | Check the existing session and runtime connection before creating another. See [terminals](terminals.md). |
| Workflow has no answer | Open its existing run and inspect stages, approvals, reports, and delivery. See [workflows](workflows.md). |
| Update is blocked or interrupted | Read the blocker/recovery message and follow [Updates](updates.md). Preserve recovery files and operation IDs. |

When the outcome is unknown, inspect the existing conversation or run before
retrying. A second submission can repeat work.

## Collect diagnostics

On Server, run these commands on its host:

```sh
aixand-server status
aixand-server doctor
aixand-server logs server
```

For local Suite, check launcher service controls and application messages.
If a recovery screen offers **Crash diagnostics**, copy the report before retrying;
review its errors and chat IDs before sharing.

After correcting the problem, repeat the smallest failing action. Avoid reset or
reinstallation as the first troubleshooting step. For source builds, use
[component checks](../development/testing.md).

## Ask for help

Follow [Support](../../SUPPORT.md). Include the OS, application/component versions,
Suite or Client/Server setup, failing action, redacted error, and relevant operation
ID. Remove passwords, cookies, tokens, and private conversation content.

Next: [Back up, restore, or remove a workspace](backup-and-removal.md).
Back up before destructive recovery.
