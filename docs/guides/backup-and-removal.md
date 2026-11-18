# Back up, restore, or remove a workspace

Back up data on the workspace host: the local Suite computer or the connected
Server. A Client-only backup does not contain the Server's workspace.

## Back up

1. Find the workspace path in Suite's connection window or with
   the `dataDirectory` field from `aixand-server status` on Server. Record the application and component versions.
2. Finish active conversations, workflows, and terminal commands. Stop the local
   workspace using **This computer → Advanced → Stop local services**, or run
   `aixand-server stop` on Server.
3. Copy the entire workspace directory to a separate backup location. Preserve
   file permissions and `config/installation-plan.json`.
4. Back up project folders separately. Registering a project does not move its files
   into the workspace.
5. If using **Shared** installation, also back up the resolved manager settings,
   provider homes, tool data, and selected Undercurrent storage. Stop other
   applications writing to those stores before copying them. See
   [installation paths and overrides](../../apps/server/docs/operations/installation.md#installation-choices).
6. Confirm the copy completed and contains the expected files before restarting.

Keep credentials and provider homes in protected backup storage. External paths
and services need their own backups, including any used by an Isolated installation.

Update snapshots are recovery aids, not complete backups: they exclude provider
account directories and shared data outside the workspace.

## Restore

There is no full-workspace restore control in Settings.

1. Keep the original backup unchanged. Stop the destination workspace and retain
   a copy of its current data.
2. Use a compatible application/component installation. Restore the workspace
   as a complete set, including its saved installation plan, with the original
   paths and ownership where possible.
3. Restore separately backed-up projects and shared stores before starting.
   A different host or changed paths may require component-specific recovery;
   do not merge live databases or edit ownership records to force startup.
4. Start the workspace. Check projects, conversation history, profiles, and resources;
   then run a small conversation and terminal command. Provider sign-in may need renewal.

Do not downgrade databases after a newer runtime has used them. For an interrupted
update, follow the [update recovery procedure](../../apps/web/docs/updates.md#installation-and-recovery)
instead of replacing individual database files.

## Reset or uninstall

For Server, run one command on its host and review the choices:

```sh
# Remove selected data while keeping software.
aixand-server reset

# Review application, tool, and data removal.
aixand-server uninstall
```

For Suite, open **This computer → Advanced → Reset or remove components…** in
the connection window. To uninstall the application itself, use its installer or
OS package manager.

Client's **Client settings → Clear Client data…** clears saved connections,
sign-ins, and local browser data. It does not delete Server data. Uninstall Client
through its installer or OS package manager; Server remains installed.

Read the final list of removed and retained paths before confirming:

- Application/tool removal can keep settings and data.
- **Everything managed by Aixand** includes managed data. Native provider logins
  have separate removal choices.
- Shared tool removal can affect other applications.
- Personal project folders outside managed stores stay.

Settings-based workspace reset is unavailable in this alpha. Keep the removal
report and check unfinished components; a partial result is not a complete uninstall.

[Detailed removal options](../../apps/server/docs/operations/installation.md#repair-reset-and-removal)
