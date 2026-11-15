# Develop the desktop shell

Suite Desktop wraps web assets with a Tauri native shell. Its source and lockfile
live in `apps/desktop`; [Suite Web](../README.md) owns the interface assets.
The development beta does not establish native installer qualification or public
release availability.

## Choose a workspace

The connection window offers **This computer** for the local runtime and **Server**
for a configured host. Local workspace access uses loopback port 8753 by default.
Remote access uses the selected host and its authentication policy. The shell
does not create SSH tunnels or start remote services. See
[authentication](../../server/docs/authentication.md) before configuring a listener.

[Client](client.md) is a separate frontend-only role with no local runtime.
[Installation roles](installation-editions.md) explain the payload boundaries.

Local setup chooses **Separate Suite installation** (Isolated, recommended) or
**Shared installation**. Isolated starts with fresh settings; Shared reuses the
selected normal user stores. Tool installation and license acceptance continue
inside workspace onboarding. Reopening a configured workspace preserves its
saved plan. The connection window's Advanced section provides service stop and
reviewed maintenance controls.

## Run or build the shell

Install Node 24, Rust and Tauri's native prerequisites for the target OS. Build
web assets and prepare runtime inputs deliberately; the native shell command does
not establish backend readiness. From `apps/desktop`:

```sh
npm ci
npm run desktop:dev
npm run desktop:build
```

The commands are declared in [package.json](../../desktop/package.json).
Inspect [Tauri configuration](../../desktop/src-tauri/tauri.conf.json) for asset
and runtime inputs. Use the root packaging tools for complete runtime installers;
a shell build alone does not qualify a complete Desktop installation.

## Export sources

From `apps/desktop`:

```sh
npm run desktop:export
```

The [export helper](../../desktop/scripts/export-desktop.py) defines the archive
contents. Copy the resulting source archive to the target machine and follow its
native build prerequisites. Native Windows uses Microsoft C++ Build Tools;
Linux cross-build output still requires native Windows testing.

For complete runtime packaging, inspect root `scripts/package-linux.py`,
`scripts/package-macos.py`, `scripts/package-windows.py` and `build-windows.ps1`.
See [Server build and qualification](../../server/docs/installation.md#build-and-qualification)
for role selection. Builds and exports do not publish installers.

## Preserve security and recovery

The trusted connection window owns native maintenance commands. Remote workspace
content must not gain launcher, cleanup or process-execution access. Keep server
session, exact Origin, CSRF and native certificate checks in place.

Review installation and removal plans explicitly. Retain exact operation IDs and
receipts across interruption; inspect uncertain work before retrying. Provider
accounts and workspaces require separate consent from software installation.
[Updates](updates.md) describes the disabled-by-default update foundation.
