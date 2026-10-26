# Aixand desktop client

New releases provide distributed **Aixand Desktop** and terminal-only **Aixand
Server** packages. See [installation and Server commands](../../aixand-server/docs/installation.md).
Standalone releases are retired; historical manifests and installation readers
remain available for migration. The older tool-copy flows below describe
compatibility behavior, rather than additional public installation choices.

The installer bundles a launcher that opens without a server. **This computer**
opens the local workspace; **Server** connects to an existing Suite. Server
addresses are remembered on this computer, with optional names under **Advanced**.
The selected Suite opens in a separate workspace window. The local workspace
uses **http://127.0.0.1:8753/** by default.

Full Desktop packages carry the complete React interface and connect it to the
selected backend through a private local HTTP/WebSocket gateway. A remote Server
package does not need frontend assets. Production web mode still supports browser
hosting on the backend's port. Vite remains a development tool.

Historical connected-client-only packages require a web-serving backend.
Full Desktop builds include the local Suite runtime described below. Native
releases require target-specific verification. Remote connections use the selected Suite host. The app does
not start or stop remote services or establish SSH tunnels.

## Complete Windows installation (preview)

The native x64 Windows build bundles the production frontend/backend, Node,
Python 3.12, Undercurrent (including ConPTY), Runner with SDK support, Carrier,
all seven Manager Suite distributions, Aixand SDK/Connect/MCP commands,
Git, FFmpeg, and a separate voice Python environment. Provider engines and CLIs
are installed separately through provider setup. WSL is not a
runtime dependency. User accounts and downloaded voice models are configured
after installation.

The source inputs include the independent `aixand-platform` project beside
`aixand-suite`, `manager-suites`, Carrier, Runner, and Undercurrent. The export
includes its metadata, lock, source, tests, and license. The former
Suite-owned platform directory is retained only for existing editable development
environments and is excluded from new runtime builds.

On the source machine, export the full build kit, including the sibling tools:

```sh
python3 scripts/export-windows.py
```

Copy `aixand-web/artifacts/desktop/aixand-windows-full-source.zip` to Windows and
extract it. From `aixand-windows/aixand-suite` in Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-windows.ps1
```

The build computer needs Rust/rustup and Microsoft C++ Build Tools with **Desktop
development with C++**. The script downloads checksum-verified build runtimes;
end users do not need build tools, Node, Python, Git, or a separate Aixand server
installation. Builds default to `$HOME\dev\aixand-windows-build` to keep native
Windows paths short; use `-OutputDirectory` to choose another location. The builder snapshots the sources, installs private
runtime dependencies, builds native executables, and runs isolated integration
checks in both setup modes before producing the NSIS `*-setup.exe`.
`-WithoutVoice` and `-RuntimeOnly` explicitly select smaller outputs.

Output lives under `$HOME\dev\aixand-windows-build\output`, or the
chosen output directory's `output` subdirectory. `verification.json` distinguishes
native runtime integration checks from desktop installation testing. A Linux
cross-build is also available through `python3 scripts/package-windows-cross.py`;
its artifacts are explicitly unqualified test builds until exercised on Windows.

Install the resulting `*-setup.exe`, then launch **Aixand** from Start. Choose
**This computer → Open workspace**. First run automatically saves the
**Self-contained** default. To use compatible installed tools, choose
**Advanced → Tools → Use system tools** before opening the workspace. The browser uses the same
`http://127.0.0.1:8753/` address. Stop a previous SSH tunnel if it occupies 8753.

Windows keeps Suite state in `%LOCALAPPDATA%\Aixand\local`. System-tool setup
installs an independent toolset into `%LOCALAPPDATA%\AixandTools\versions` and
ordinary `.exe` commands into `%LOCALAPPDATA%\AixandTools\bin`. It registers that
CLI directory in the user PATH; open a new PowerShell window afterward. Existing
commands in the selected directory are preserved and reported. These tools
remain installed when the desktop is removed; they do not call back into the
application package or depend on aliases. Configuration reuse is explicit and
shares only the selected manager stores, with Suite/service state kept private.

The app's private runtime CLI is in the installation's `runtime\bin` directory.
Upgrade and uninstall hooks ask that runtime to stop its own services before
removing executable files. They retain user data and independent system tools.
Windows stops the private UC Job Object process trees; active work is interrupted.
Finish running work before upgrading or uninstalling.

Windows local IPC uses random, authenticated loopback endpoints whose descriptor
files are restricted to the current Windows account. The public Suite API stays
on 8753; private service endpoints are chosen dynamically. Native Codex listeners
also require capability authentication. Unix builds retain their socket protocol.
Authentication storage uses Windows ACL checks and rejects shared or linked
directories. Existing directory permissions are never silently changed.

## Claude setup and existing accounts

The application includes the Claude Agent SDK library, with its license, but
excludes its embedded Claude Code executable. Install Claude Code through the
provider setup screen or select an existing official installation on the backend
computer. Subscription chats and API-key chats both require that executable.
Antigravity SDK chat is a separate, explicit SDK installation and can work without
the Antigravity CLI. These choices apply equally to desktop and browser clients.

In **Agents → Manage profile**, create a Claude account directory or connect an
existing Claude configuration directory on the backend computer. Complete the
official sign-in, then select **Claude account login** for subscription chats.
Several profiles may share one account. Aixand keeps the account's directory and
public status; Claude owns its credentials and refreshes them. API-key mode uses
an explicitly selected API credential and never substitutes for a failed
subscription login. Changing a profile's account affects new conversations;
continuing an existing conversation requires its original account.

Older saved Claude logins show a migration review. Migration preserves chat
history, removes Manager's old credential snapshots, and requires official
sign-in again. It does not copy tokens into the new account directories.
**Reset everything** signs out Aixand-owned Claude accounts before resetting
setup. Connected external account directories stay signed in unless the shared
account sign-out option is selected. Disconnecting an account preserves native
history and allows reconnecting it later.

The same account actions are available through Manager's SDK, MCP, and CLI:

```sh
agent claude account list
agent claude account create personal
agent claude account bind work ACCOUNT_UUID
agent claude login --agent work
agent claude account check ACCOUNT_UUID
agent claude account logout ACCOUNT_UUID --yes
agent claude account migrate --yes
```

Use `aixand-runtime exec` before these commands when using the private runtime
instead of the separately installed system tools. Paths always refer to the
computer running the Suite backend.

## Complete Linux installation

From the full `aixand-suite` checkout on the build computer:

```sh
python3 scripts/package-linux.py
```

The build computer needs Python and Podman (or Docker with `--engine docker`).
The script snapshots the required sources, excluding environments, credentials,
runtime state, virtual environments and development build outputs. It builds in
an Ubuntu 22.04 container, with private build caches under
`aixand-web/artifacts/desktop/full-linux`. It does not restart the running Suite.

The output directory `aixand-web/artifacts/desktop/full-linux/output` contains a
Debian installer and a relocatable runtime archive. The full installer bundles
Node.js, Python 3.12, NestJS, the built frontend, Runner with SDK support,
Undercurrent and its bridges, Carrier, all seven Manager Suite packages, Aixand's
Python SDK, Connect, MCP entry points, and voice dependencies. Core services
use their own Python runtime; voice uses a separate private runtime so its audio
dependencies do not conflict with the optional provider SDKs. These runtimes are
part of the same installation. Provider engines and CLIs are excluded from the
application payload, including the executable normally embedded in the Claude SDK.
Provider setup can use an existing installation or install official tools explicitly.
Antigravity's SDK and its required engine are installed with the separate
“Install SDK for chat” action, not by the Aixand installer.
Voice model preparation downloads model data; use
`aixand-runtime prepare-voice` before first voice use.
Provider accounts require the user's own login. Other provider applications and
third-party MCP packages use their existing application-managed setup flows.

The installer targets the builder's architecture. The Linux builder targets Linux; use the separate Windows workflow above for its
native runtime. The connected client remains available on macOS.
Build flags `--runtime-only` and `--without-voice` explicitly select smaller
artifacts. `--skip-image-build` reuses the existing builder image.
`--install-clis` opts in to installing the bundled tool commands into `/usr/bin`;
the default self-contained build keeps those tools private to Aixand.
The CLI-enabled installer is written under `output/cli-enabled` to distinguish it
from the default package.

Copy the `.deb` to the test computer. In Ubuntu/Debian WSL, install it with apt
so its Linux system-library dependencies are installed automatically:

```sh
sudo apt install ./Aixand_0.1.0-beta_amd64.deb
aixand-desktop
```

Use the actual filename emitted by the build if it differs. Close any existing
Aixand desktop window. Choose **This computer → Open workspace** to start with
the included tools. The **Tools** dropdown under **Advanced** offers two choices:

- **Self-contained:** use the private bundled toolset. This is the default.
- **Use system tools:** check installed Undercurrent, Runner, Manager Suite and
  SDK Python environments. Exact supported tool/package versions and Runner SDK
  support are checked before the selection is saved and again before startup.
  Use **Tool paths** when automatic discovery needs help.

If the system toolset is incomplete, **Install compatible tools** installs a
complete supported toolset under `~/.local/share/aixand-tools/versions`. It creates
normal CLI executable links in `~/.local/bin`; no aliases or shell-profile edits
are used. It preserves commands belonging to other installations and reports
those conflicts. If the CLI directory is missing from `PATH`, setup explains how
to make it available to ordinary terminals; the app can use it immediately.
These tools and their Python/Node dependencies live outside the desktop package
and remain installed when the desktop package is removed. Managed tool versions
are retained so a running process is not replaced in place.

**Use existing manager configuration** is unchecked by default. Selecting it
shares the normal Agent, MCP, Prompt, Skill and Server Manager stores (or their
explicit environment overrides). It does not copy credentials or import Suite
authentication, chats, Carrier databases, Runner state or Undercurrent sessions.
Those services always use Aixand's separate local state. Regular standalone
commands retain their normal environment and configuration conventions;
`aixand-runtime exec uc ls` targets Aixand's private service namespace.

Choose **Open workspace** to apply any tool changes and start the local workspace.
Stop the previous SSH tunnel first if it occupies port 8753. The app
starts its own private Undercurrent daemon, Carrier, Runner, and production server,
then opens `http://127.0.0.1:8753/`. The same address works in a browser. Saved
remote connections remain available and never start the local services.

Local data belongs to `~/.local/share/aixand/local`, independently of the software
installation and the remote server. The local workspace starts with fresh data;
it does not copy credentials, projects or configuration from the build computer.
Closing the desktop leaves local services and their work running. Inspect or
explicitly stop them with:

```sh
aixand-runtime doctor
aixand-runtime status
aixand-runtime stop
aixand-runtime start
aixand-runtime exec agent --help
aixand-runtime exec runner --help
aixand-runtime exec carrier --help
```

After installing system tools (or using the optional CLI-enabled Debian build),
commands are also available directly:

```sh
uc --help
runner --help
carrier --help
agent --help
mcp-manager --help
prompt-manager --help
skill-manager --help
server-manager --help
orchestration-mcp --help
aixand-mcp --help
```

When built with `--install-clis`, the Debian package installs these commands into
`/usr/bin`, together with
`agent-manager-mcp`, `aixand-connect` and, when voice is included,
`aixand-vox` and `aixand-vox-prepare`. They are executable CLI entry points managed
by the package manager. No shell aliases, shell-profile edits, developer tools,
running desktop window, or `aixand-runtime exec` prefix are required. The commands
use the bundled dependencies and the same local configuration and data as the
desktop. Removing the package removes its CLI entry points as well. Another
installation earlier in your shell's `PATH` still takes precedence; `command -v uc`
shows which executable the shell selects.
Without that build option, use `aixand-runtime exec COMMAND` for the selected local
toolset. The optional `/usr/bin` entry points belong to the desktop package;
the user-level system-tool installation is independent of that package.

Reopen **This computer → Advanced** to change tools. Changes are saved when you
choose **Open workspace**. Stop local services first when changing tools; changing
mode while work is active is refused. Reopening an unchanged workspace does not
save the tool selection again. The selected tool paths and configuration reuse
setting are saved in the local data directory's `config/setup.json`.
The application runtime, NestJS, frontend and internal terminal/workflow bridges
remain packaged in both modes. Selecting system tools changes the tool source,
not the download size of this full installer.

The same setup is available without opening the desktop:

```sh
aixand-runtime setup info
aixand-runtime setup check '{"mode":"system"}'
aixand-runtime setup install '{"mode":"system"}'
aixand-runtime setup save '{"mode":"system"}'
# To switch back, stop local services first:
aixand-runtime stop
aixand-runtime setup save '{"mode":"bundled"}'
```

`stop` stops work owned by this private local runtime and retains its data and
logs. It does not stop a separate development or remote Suite. Stop the local
runtime before replacing or relocating its software. Reopening it preserves
authentication and workspace data. Removing the software package retains that
user data as well.

Optional configuration belongs in the user's `config/runtime.env` under the local
data directory; credentials are read by service children after launch and are
not saved in Undercurrent launch arguments. `AIXAND_LOCAL_HOME` chooses a separate
absolute data directory. `AIXAND_LOCAL_PORT` and `AIXAND_LOCAL_CARRIER_PORT` select
unused local ports, defaulting to 8753 and 8765. Set them in the desktop process
environment when launching the app to use the same selection for startup and CLI
commands. An occupied port is reported without stopping its current owner.
To return to the remote server using the same forwarded port, stop the local
runtime before reopening the SSH tunnel and selecting the remote connection.

## Prepare the production Suite on Linux

From the full `aixand-suite` checkout:

```sh
node scripts/production.mjs build
```

This builds the existing frontend, Connect download, and NestJS backend. Preserve
the existing Suite runtime configuration in `aixand-server/.env`. Optional
production overrides belong in `aixand-server/.env.production`:

```dotenv
AIXAND_PRODUCTION_PORT=8753
AIXAND_PRODUCTION_ORIGINS=http://127.0.0.1:8753,http://localhost:8753
```

Start production from `aixand-suite`, using the existing Undercurrent daemon:

```sh
./dev.sh serve --production
```

This starts or reuses Carrier, Runner, and the compiled backend in detached
managed sessions. When switching this checkout from managed development, it
checks prerequisites first, gracefully stops the managed development backend
and Vite session, then replaces the backend's saved command with production.
Carrier and Runner remain available. Repeated production starts reuse healthy
services. Preview the switch with `./dev.sh serve --production --dry-run`.

It reuses your existing Linux configuration and data. Do not run two backends against the same
active runtime directories and sockets. Use separate disposable state for parallel
testing. Production deployment details are in `aixand-server/docs/production.md`
in the full Suite checkout.

Verify `http://127.0.0.1:8753/` and `/api/health` on Linux. Health reports NestJS
liveness, not the readiness of every agent or runtime. Production uses its own
cookie namespace. Sign in again after changing from the development address;
browser-local preferences at the old origin are not automatically migrated.

## Export the desktop sources

On Linux, from `aixand-web`:

```sh
npm run desktop:export
```

The result is `artifacts/desktop/aixand-desktop-source.zip`. It includes the Rust
shell, bundled connection page, icons, configuration, Cargo lockfile, this guide,
and a minimal npm package containing the Tauri CLI. It excludes environment
files, runtime state, backend code, node_modules, and native build directories.

Run these commands in **Windows PowerShell**, outside the remote SSH session:

```powershell
scp mbeepboop@10.10.0.7:/data/dev/projects/aixand/main-prod/aixand-products/aixand-suite/aixand-web/artifacts/desktop/aixand-desktop-source.zip .
Expand-Archive .\aixand-desktop-source.zip -DestinationPath .\aixand-desktop-production
cd .\aixand-desktop-production\aixand-desktop
npm install
```

Replace the SSH address and remote path if your host or checkout differs. Export and
copy again after changes to the native shell or bundled connection window. The
main application interface is bundled with full Desktop; historical thin clients
load it from the selected Suite server.

## Windows prerequisites and installer

Source builds need Node.js 24, Rust 1.95+ with its MSVC toolchain, Microsoft C++
Build Tools with **Desktop development with C++**, and WebView2. See the
[official Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows).
Restart PowerShell after installing build tools.

From the extracted `aixand-desktop` directory:

```powershell
npm run desktop:build -- --bundles nsis
explorer.exe .\src-tauri\target\release\bundle\nsis
```

Install the resulting `*-setup.exe`. `installer.nsi` is an intermediate script,
not the finished installer. After installation, launch Aixand from the Start
menu. End users do not need Node, Rust, or C++ build tools; the installer handles
the WebView2 runtime when it is missing. Signing and updates remain later work.

To run from source instead:

```powershell
npm run desktop:dev
```

`desktop:dev:ssh` is an alias. Neither command starts Vite or Suite services.
Both development and release desktop builds include the same local launcher.
During `desktop:dev`, Tauri serves the launcher from its own local development
URL; only that configured origin in the connection window is allowed to manage
connections. Packaged builds use the embedded launcher instead.

## Connect Windows to Linux

In a separate **Windows PowerShell** window, open the production tunnel:

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8753:127.0.0.1:8753 mbeepboop@10.10.0.7
```

Keep it open. First verify `http://127.0.0.1:8753/` in your Windows browser. In
Aixand's launcher, choose **Server**, enter that address and choose **Connect**.
The server is remembered automatically. Choose **Add a server…** in **Saved
servers** to connect to another one; optional names and **Forget server** are
under **Advanced**. Enable **Open automatically next time** to reopen the chosen
workspace on app launch.
For a direct network deployment, use the Suite's HTTPS root address.

For the Linux desktop app running through WSLg, open the tunnel **inside WSL**
using the same SSH command. This makes `127.0.0.1:8753` available in the app's own
Linux environment. A Windows-side tunnel is not assumed to share WSL's loopback.
The production service must already be running on Linux; an SSH error saying
`channel ... connect failed: Connection refused` means the forwarding destination
could not be reached. Check the Suite service and its configured port first.

If port 8753 is already occupied on Windows, choose another local forwarding
port and add its exact frontend origin to `AIXAND_PRODUCTION_ORIGINS` on Linux.
Then connect using that forwarded address in the desktop launcher.

The workspace has its own cookie store, separate from your ordinary browser.
Projects, terminals, agents, directories, and backend configuration belong to
Linux. Saving a desktop connection does not copy or move any of that state.

The connection window stays available behind the workspace. Closing a workspace
returns to connection settings and leaves remote work running. If the server or
tunnel disappears, the connection window reports it. Monitoring only checks
health; it does not resend actions or automatically reload your workspace. Once
the server returns, choose **Open workspace**, or **Reconnect** for an explicit
reload if the page needs it. Reconnect does not retry failed mutations.

## macOS, Linux, and development connections

Build packages on each target operating system with `npm run desktop:build`.
macOS needs Xcode Command Line Tools and Rust. Linux needs the GTK/WebKit
packages in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
Native GUI behavior still requires platform testing. The macOS microphone
usage description is included; forwarding the frontend over SSH does not forward
WebRTC media, so voice may require separate network configuration.

For frontend development, you can save an explicit connection to an already
running Vite server at `http://127.0.0.1:5173/`. Port 5173 is not a production
dependency. The development backend's current port remains separately configured.

Only the bundled connection window receives native permissions to manage
profiles and open a workspace. Remote workspace pages receive no native command
permissions. Core application behavior continues through shared Suite APIs.
HTTP(S) links that request a new window open in the system browser, including
provider sign-in links. The sign-in card also offers **Copy sign-in link** as a
fallback. File links and custom URL schemes cannot use this browser handoff;
workspace pages retain no native command permissions.

Native file dialogs, download integration, automatic SSH tunnels, signed
updates, and complete macOS runtime packages remain separate milestones. Windows full
runtime builds use the preview workflow above.

## Verification

Native Rust tests cover launcher origin checks for development and packaged
builds, including refusal of native commands from workspace windows and other
local services. Run them on a machine with the native prerequisites using
`cargo test --manifest-path src-tauri/Cargo.toml`.

`npm run test:desktop` checks the bundled launcher in Chromium using mocked
native commands, including offline startup, first-run defaults, system-tool
selection, saved servers, automatic connection, explicit reconnect, keyboard
navigation, and accessibility in light and dark modes. It does not replace a
native GUI test.

After installing a new package, check sign-in, a chat or terminal, and connection
loss/recovery on the target OS. The server tests separately cover same-port
frontend/API delivery, setup, sessions, CSRF, and authenticated WebSockets.

The full Linux build runs `scripts/runtime/verify.mjs` against its assembled
runtime before packaging. This exercises isolated startup, authentication,
agent and workflow catalogs, terminal creation, an actual Runner workflow,
CLI entry points, an MCP handshake, shutdown, occupied-port refusal and restart
with preserved authentication. `scripts/runtime/Containerfile.verify` provides
a clean Ubuntu environment for installing the resulting Debian package and
rerunning that check without development tools or source checkouts.
Pass `--installed-commands` after the runtime path to exercise the package's
commands by name on a clean `PATH`, including a fresh shell without aliases,
CLI exit codes, the local daemon and Runner, and the stdio MCP entry point.
`--system-tools` checks discovery without a bundled fallback, independent tool
installation, ordinary CLI commands, paths containing spaces, reuse of an
external Python virtual environment, preservation of existing commands, explicit
manager-store reuse, and the complete authenticated backend/workflow/MCP flow.
The installed-package check verifies every runtime symlink; the Debian
post-install step restores links materialized by the resource bundler.
`verify-independent.mjs` runs in a disposable root test container: it installs
tools as an ordinary user, removes the desktop package, then verifies normal
CLIs, Node/npm, Python/voice imports, default SDK bridge discovery, a standalone
Undercurrent daemon and Runner with SDK support.
`scripts/runtime/verify-native.mjs` drives the installed executable with
`tauri-driver` and WebKit WebDriver to check local startup, opening a workspace
and native permission boundaries. Live provider accounts, microphone/audio
devices and downloaded speech models need additional testing on the user's
computer.

### Selective cleanup and fresh installation

The native launcher has **This computer → Advanced → Reset or remove
components**. This is a local desktop operation; a remote workspace cannot invoke
it. Interactive Windows uninstall opens the same checklist. On Mac and Linux,
use the checklist before moving the app to Trash or removing its OS package.

In Windows setup, **Uninstall Aixand** opens the installed uninstaller and exits
setup after removal. This choice also works when setup was launched with
`/UPDATE`; cancelling returns to maintenance. **Add/reinstall components**
continues installation and preserves saved data. When changing versions,
uninstall-before-install also preserves data and skips optional cleanup. The
custom NSIS maintenance template follows the pinned Tauri CLI version; see
`src-tauri/windows/README.md` when upgrading the bundler.

Every checkbox starts unchecked. Workspace data includes the password database,
chats, local terminal history, onboarding, caches, and manager resources. Provider
accounts, downloaded SDKs, private provider tools, desktop browser data and each
shared product are separate choices. Select all selects available components;
unverified provider installations show manual removal instructions. Shared Codex,
Claude and OpenCode native data have additional choices marked **shared**; official
Codex/Claude sign-out runs before deleting their account files or CLI software.
Other native credential stores and unrelated installations are retained.
On Windows, Codex's native launcher junction and its
`~/.codex/packages/standalone` software store are one CLI component. Cleanup
checks both vendor junction targets and the release metadata without traversing
the links. Selecting only provider accounts preserves this software store;
selecting only the CLI preserves saved accounts. Custom redirects remain manual.
Command lookup suggestions are labeled as diagnostics, not uninstall commands.
Private provider data is removed even when the current workspace reuses an
external manager home; that external manager home remains intact. Keeping
provider accounts also keeps their private OpenCode configuration and state.

Removing one Manager Suite member preserves the other members and their existing
payloads. It dissolves the collection pin into independent installations; actual
product dependency constraints still apply. Independent product data and personal
project folders outside the Suite-owned stores are retained. Clearing the Suite
workspace unregisters only its matching, owned `aixand-suite` UC connection. UC's
permanent `default` and unrelated profiles remain.

Normal reinstall, updates and silent uninstall retain user data and shared tools.
For a fresh setup, select workspace data, provider accounts and desktop browser
data; additionally select software you want removed. Windows finalizes desktop
browser-directory removal after the cleanup window exits. The existing web
**Reset everything** action continues to preserve the workspace password and
installed software; its help text directs desktop users to this fuller checklist.

For automation, `aixand-runtime cleanup plan` returns a read-only JSON checklist
and revision. `cleanup apply` requires JSON with `selected`, the reviewed
`revision`, and `confirmed: true`. Changed software receipts, unknown components,
redirected paths and incompatible retained dependencies are rejected. Selected
cleanup automatically stops the Suite's local services, then checks selected
files before any provider sign-out, data deletion or product removal. If another
application is using them, the checklist shows its name, PID, executable and
affected paths. **Stop and retry** requests a graceful shutdown of the reviewed
processes. If an application remains, a separate acknowledgement enables
**Force stop and retry**; active work in that application can be lost. Stopping
applications does not itself delete saved conversations, accounts or settings.
Those remain separate component choices.

Windows uses Restart Manager to identify file users, including background
processes holding provider guard files. macOS checks open files with its system
`lsof`; Linux checks the current user's open files, executable and memory maps.
Only processes still using selected paths, with the same reviewed PID and birth
identity, can be stopped. New file users require another review. Cleanup never
uses blanket process-name or process-tree termination. Protected, unverifiable or
unidentified blockers require manual closure; an incomplete check prevents
removal. A file becoming busy later can still cause a partial failure, which
reports completed components and requires reviewing a fresh checklist.

The Store-installed Codex Windows sandbox service can also hold a native
provisioning guard with no terminal open. Cleanup verifies its registered service,
Store package image, non-critical process, PID and birth before sending a graceful
stop. If the desktop account cannot inspect its process, Restart Manager and SCM
must identify the known Codex service before offering administrator verification.
The elevated helper temporarily enables its token's existing `SeDebugPrivilege`
so it can inspect the LocalSystem service even when UAC approval alone leaves
process queries denied. It restores the previous privilege state on success or
failure. It rechecks the guard owner, actual image and process birth; it
can only stop that reviewed service and cannot remove files or uninstall services.
Services never receive force termination, and the Codex desktop application stays
installed. If it starts the service again, the new instance needs a fresh review.

The automation action `cleanup stop-processes` requires the same selected IDs,
revision and confirmation plus a `reviewed` list of `{pid, birth}` from the blocked
report. Force stopping additionally requires `force: true` and
`forceConfirmed: true`. It stops processes only; invoke `cleanup apply` again to
recheck and perform the selected removals.

`cleanup.test.mjs`, `test_provider_cleanup.py`, `test_cleanup_processes.py` and desktop launcher tests cover
selection, preservation, path boundaries and failure handling. `verify-cleanup.mjs`
uses disposable homes with the packaged runtime to exercise granular removal,
individual manager removal, all-component cleanup and password setup after reset.
