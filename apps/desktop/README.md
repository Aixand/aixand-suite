<p align="center">
  <img src="../web/public/favicon.svg" width="160" height="160" alt="Aixand logo">
</p>

# Aixand Desktop

<p align="center">
  <strong>The native shell for local Suite workspaces and Server connections.</strong>
</p>


This component provides Aixand's Tauri desktop shell. It owns the trusted
connection window, native transport, and desktop maintenance controls.
[Suite Web](../web/README.md) owns the workspace interface; [Server](../server/README.md)
owns backend operations and state.

[Applications](#choose-an-application) · [Development](#develop-the-shell) ·
[Packaging](#build-complete-installers) · [Documentation](#documentation)

## Choose an application

| Native application | Behavior |
| --- | --- |
| **Aixand Suite** (Desktop role) | Includes interface, local backend, and product runtimes. Choose **This computer** or connect to Server. |
| **Aixand Client** | Includes interface and a connection shell, without a local backend or product runtime kit. Connects only to Server. |

For installed applications, use the [Suite installation guide](../../README.md#installation)
or give your agent the [step-by-step instructions](../../agent-installation-instruction.md).
Normal local Suite use manages its connection automatically. Separate Server
connections require an existing SSH tunnel or HTTPS deployment; the shell does
not start remote services or create tunnels.

Windows downloads are unsigned and macOS downloads are not notarized in the
published alpha.3 release. See [platform requirements](../../README.md#platform-requirements).

## Develop the shell

Use Node 24, Rust, and the target OS's Tauri native prerequisites. Native Windows
requires Microsoft C++ Build Tools. Prepare frontend and runtime inputs as
explained in [desktop development](../web/docs/desktop.md); a Tauri build alone
does not prepare a complete local Server runtime.

From `apps/desktop`:

```sh
npm ci
npm run desktop:dev
```

Expect the native connection window. Check the selected workspace path or Server
address before opening a workspace. If local runtime inputs are absent, complete
the documented runtime preparation rather than treating an open window as a
working installation. Stop the development process with Ctrl+C when finished.

To build the shell or export its source archive from this directory:

```sh
npm run desktop:build
npm run desktop:export
```

[package.json](package.json), [Tauri configuration](src-tauri/tauri.conf.json),
and [the export helper](scripts/export-desktop.py) define those inputs and outputs.
Source exports and shell builds do not publish or qualify installers.

## Build complete installers

Use the Suite root packaging tools for the complete application payload. From
the Suite root, choose the command for the native target:

```sh
python3 scripts/package-linux.py --package desktop --output /fresh/desktop-build
python3 scripts/package-macos.py --package desktop --output /fresh/desktop-build
```

Windows PowerShell:

```powershell
.\build-windows.ps1 -Package desktop -OutputDirectory C:\fresh\desktop-build
```

Use `client` for the remote-only application or `all` for all three roles.
Use a fresh output directory and follow
[build and qualification prerequisites](../server/docs/installation.md#build-and-qualification).
Signing, notarization, and release publication are separate operations.

## Verify native behavior

Check launcher selection, authentication, reconnect, and the selected host's
workspace. For Client, confirm that no local backend starts. Keep remote
workspace content separate from trusted launcher and maintenance commands.

From the Suite root, focused fixture and transport checks include:

```sh
npm --prefix apps/web run test:desktop
npm --prefix apps/web run test:client
cargo test --manifest-path apps/desktop/src-tauri/transport/Cargo.toml
```

The browser checks need the Web package and Playwright browser runtime. These
checks do not replace running the exact packaged installer on its target OS.
Preserve exact operation IDs and inspect uncertain maintenance outcomes before
retrying. See [update behavior](../web/docs/updates.md) for consent and recovery.

## Documentation

| Task | Guide |
| --- | --- |
| Prepare native development inputs | [Desktop development](../web/docs/desktop.md) |
| Understand Client transport and storage | [Client contract](../web/docs/client.md) |
| Choose payloads and tool ownership | [Installation roles](../web/docs/installation-editions.md) · [Server setup](../server/docs/installation.md) |
| Configure remote access | [Advanced Server connections](../server/docs/installation.md#connect-to-a-separate-server) |
| Maintain installed updates | [Updates](../web/docs/updates.md) |

[Suite](../../README.md) · [Support](../../SUPPORT.md) · [License](../../LICENSE)
