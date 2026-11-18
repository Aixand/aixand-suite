# Retained Connect application examples

These examples document intended application presentation for restoring and reviewing the missing Server adapters. They are not current availability promises. [Server integration](../../../../apps/server/docs/integrations/connect.md) owns orchestration and parent-report contracts; companion APIs alone do not implement these flows.

| Intent and sample request | Retained presentation and interpretation |
| --- | --- |
| Send `dist/app.zip`: “Copy `dist/app.zip` to my Windows PC.” | Source is on the Suite host inside the chat's saved project; browser-local files require separate upload. Check delivery receipts before retrying. |
| Start a remote chat | Choose a paired device, existing directory and access mode; Direct Codex uses native login. Remote failures must not route execution to the host. |
| “Copy this project to my Mac.” | **Project ready** requires confirmed extraction; **Project folder** identifies the isolated destination. Copy alone runs no agent, installation or tests. |
| “Copy this project to my Mac and run its tests.” | **Open remote chat** exposes output and approvals. Reports distinguish passed, failed, blocked and unconfirmed. Completed turns alone do not prove tests passed. |
| “Test this project on the Linux host and my Mac, then compare the results.” | **Stop machine** and **Stop all machines** have distinct scope. Different OSes may use different test commands; specify the command when needed. |
| Recover uncertain work | **Check project copy**, **Check project run**, **Check machine** and **Check all machines** reconcile retained identities without repeating an unconfirmed submission. |
| Remove conversation history | **Settings → Devices → Background work** retains unresolved work independently. **Stop and delete** requires confirmed stop; ordinary history deletion does not stop execution. |

Snapshot limits, exclusions, source identity and retained workspaces belong to the [project lifecycle](../lifecycles/projects.md). File bounds, no overwrite and receipt uncertainty belong to the [transfer lifecycle](../lifecycles/transfers.md). Profile selection and immutable device ownership belong to [managed conversations](../integrations/managers.md); no current quota-display or comparison scheduler qualification is claimed.

## Historical qualification note

The former README reported a paired Mac over live NetBird with native Codex 0.159.2: transfer, file read/write, output, bridge reconnect and Stop. It also reported four snapshot tests for macOS, modified source, untracked source and dependency/credential exclusions, plus parent-report and conversation reopening. No date, hardware, source revision or raw run artifacts were recovered in this cleanup. This is retained only to identify the prior qualification scope for a future rerun; it is not verified evidence for the current checkout. Windows native Codex execution remains unverified.

## Retained manual remote-chat entry

In the historical UI, choose **Chat → Remote chat**, or **Settings → Devices → Start chat on device**. Select an existing directory and access mode. A local chat request can instead say “Start a chat on my Mac in ~/dev/my-project and run its tests.” The manual dialog defaults to Workspace write; spawned work follows the saved spawn setting. Existing files are not synchronized automatically. These entry points require restoration of the current Server adapter.
