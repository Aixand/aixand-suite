# Desktop and terminal-only Server installation

New releases use one product kit with a setup-time choice of shared or isolated installation. **Aixand Desktop** includes
the native desktop shell, its complete interface and a local backend.
**Aixand Server** includes the backend and its runtime, with no frontend assets,
Tauri executable or WebView dependency. Desktop and Server use the same independent product
packages and installation receipts. **Aixand Client** includes the complete frontend
and a native connection shell, connects only to Server, and runs no local backend
or localhost gateway. See [Client installation](../../web/docs/client.md). All first-party products are 0.1.0-beta.

The Server installer is a native console program. Run it from PowerShell on
Windows, or a terminal on macOS/Linux. It stays in that terminal:

```powershell
.\Aixand-Server-windows-x86_64-setup.exe
```

```sh
chmod +x ./Aixand-Server-linux-x86_64-setup
./Aixand-Server-linux-x86_64-setup
```

Choose Install, Update, Repair, Reset or Uninstall. The installer carries its own
Node/Python runtimes and qualified first-party product kit. Provider software,
provider SDKs and speech models can require explicit network downloads later.
No source checkout or developer toolchain is required by the installed server.

On Windows, open a new terminal after installation to pick up the command's PATH
entry. macOS/Linux expose the command in `~/.local/bin`; add that directory to
PATH if your shell does not already use it. You can also run
`<application directory>/bin/aixand-server` directly (`aixand-server.exe` on Windows).

## Installation choices

Desktop's local-workspace launcher and Server's terminal setup use the same saved
installation plan. On a new workspace, setup checks existing tools, native manager
stores and the selected Undercurrent CLI connection before services start.

Server setup always offers **Isolated installation (recommended)** and **Shared
installation**. Isolated installs tools under `<workspace>/software/products`.
It keeps manager settings and tool data in the workspace. Its commands stay
private. Shared uses the normal user settings and the selected Undercurrent
connection. It reuses compatible external tools when all commands for a product
are available. It installs missing products in the normal independent product
store. This is also the default store used by each product's artifact installer.
Suite authentication, chats, Carrier and workflow service state remain specific
to the workspace in both modes.

Shared manager defaults use `${XDG_DATA_HOME:-~/.local/share}/aixand/manager`.
The five product directories are `agent`, `conversation`, `mcp`, `prompt`, and
`skill`. Agent state uses `agent/state`; its managed provider homes use
`agent/home`. Conversation state uses `conversation/state`. Their settings files
are `agent/providers.toml` and `conversation/config.toml`.

`AIXAND_MANAGER_ROOT` changes the common root. Explicit product home and config
overrides take precedence. Setup records the resolved paths. Empty or relative
`XDG_DATA_HOME` values use `~/.local/share`. Isolated mode continues to pass its
private workspace paths. It does not use the user's shared manager homes.

The terminal uses arrow keys and Enter for menus. Use Space for checkboxes.
Use A to select or clear all entries. Esc cancels the current operation. Lists
scroll in short terminals. Color is optional; `NO_COLOR` disables it. Paths,
ports and passwords still use text input. Scripts must supply explicit options.

If settings exist, Isolated can start with empty settings or copy supported
provider definitions. A copy can include credentials and external paths. It does
not copy accounts, live databases or runtime connections. The source stays
unchanged. Shared uses existing settings directly. Deleting existing settings
requires a separate removal choice.

Shared setup checks product versions. It keeps receipt-tracked products that
match the required release. It checks reused external tools again before
startup. An existing UC executable must match the bundled version. Otherwise,
update it or choose Isolated. Suite API/Python dependencies stay in the
application runtime. Desktop uses the same Shared and Isolated choices; Isolated is the default.

The schema-2 plan is stored in `<workspace>/config/installation-plan.json` and
retained through restarts, repair and updates. Fresh setup requires an explicit
Shared or Isolated selection. Unsupported plans, retired setup formats and
missing plans for populated workspaces are rejected without moving or deleting
data. Restore the saved configuration before resuming an established workspace;
setup does not infer ownership or switch its mode.

For unattended fresh Server setup, `--yes` defaults to Isolated. Use
`--installation-mode shared` for Shared. Supported settings are `fresh` or `copy`
for Isolated and `reuse` for Shared.

```sh
aixand-server setup --installation-mode isolated --settings fresh
aixand-server setup --installation-mode shared --settings reuse
```

Existing installations keep their saved mode. `--yes` alone does not select data
for deletion. Shared UC sessions carry an instance identifier. Normal stop only
stops this instance's sessions. Shared tool or data removal lists other affected
processes before it asks to stop them.

## Setup and operation

The installer reviews application and workspace directories, required products,
their terms, command conflicts, the workspace password, and optional startup
after user login. Passwords are entered through a hidden terminal prompt.
Provider installation and sign-in can be completed later.

```sh
aixand-server setup
aixand-server configure
aixand-server start
aixand-server status
aixand-server logs server
aixand-server doctor
aixand-server stop
```

`run` stays attached to the terminal; Ctrl+C stops that workspace. `start` starts
the existing managed background services and returns. It survives terminal/SSH
disconnection. `startup enable`, `startup status`, and `startup disable` manage
optional startup after user login. They never register a root/SYSTEM service or
enable system-wide boot startup. macOS uses a user LaunchAgent; Windows uses a
limited user logon task; Linux requires a working systemd user session.

Provider operations run Agent Manager with this workspace's configuration:

```sh
aixand-server providers install
aixand-server providers codex login
```

Use `aixand-server providers --help` and the provider-specific help for supported
profiles and authentication methods. Authorization may require opening a vendor
URL in an external browser. Aixand's own setup and maintenance stay in the terminal.

The default backend remains on loopback port 8753. Remote access uses SSH or an
explicit HTTPS reverse proxy. Follow the [advanced connection steps](#connect-to-a-separate-server)
below to configure and verify either route.

Shared installations use Agent Manager's bundled provider defaults when the
standard `providers.toml` preferences file is absent. An explicitly selected
custom configuration file must exist. `aixand-server doctor` checks provider
initialization and reports the configured production origins and transport.
On first use, it prepares missing default configuration and preserves existing
preferences.
Origin changes take effect when the managed services restart.

The server is single-owner: its workspace password authorizes work as its OS
user, matching Desktop. It does not introduce multi-user isolation.

## Connecting Desktop

Full Desktop packages carry the complete interface. A private loopback gateway
serves those assets and relays API/WebSocket traffic to the selected backend.
The gateway validates its Host, browser origin and private access cookie, keeps
connections isolated, and translates only Aixand session cookies. Remote HTTPS
certificate validation, upstream authentication and CSRF checks remain enabled.
The gateway cannot launch desktop maintenance from remote workspace content.

Choose Server in Desktop and enter the backend's root address, including an SSH
forwarding address such as `http://127.0.0.1:8753/`. Projects, tools, accounts and
running work belong to that selected server. A frontend-free server does not
serve a browser interface at `/`; browser hosting remains a separate web mode.
Historical thin desktop clients still require a web-serving backend.

Two backends must never open the same active workspace. Separate instances need
separate state directories and ports. Newly registered Server UC connections use
instance-specific names; existing Suite connection records are reused for the
same workspace. Server setup does not change the terminal's selected UC profile.
The permanent `default` profile is preserved.

## Connect to a separate Server

These instructions are for advanced users connecting Client or full Suite to a
separately hosted Server. Normal full Suite use with **This computer** manages
its local connection automatically. Isolated and Shared tool installation are
independent of this network configuration.

Run `aixand-server` commands on the Server host, in a terminal or through SSH.
The commands below work in POSIX shells and PowerShell. They assume the default
Server port, 8753, and an installed Server command on `PATH`.

### Connect through an SSH tunnel

For a fresh Server, complete setup interactively on the host. This creates the
workspace password without exposing it in a command-line argument:

```sh
aixand-server setup
aixand-server start
aixand-server status
```

With the default loopback configuration, no origin changes are needed for this
tunnel. On the client computer, replace `user@server-host` with your SSH login
and destination. An SSH client and access to that host are required.

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8753:127.0.0.1:8753 user@server-host
```

Keep the SSH command running. In Client, save `http://127.0.0.1:8753/` as the
Server address. In full Suite, choose Server and enter the same address. Sign in
with the workspace password. A successful connection opens the host's workspace.
The frontend-free Server does not provide a browser interface at that address.

If local port 8753 is already occupied, choose another unused local port, such
as 18753, in the first port position of `-L`. Connect to
`http://127.0.0.1:18753/` and include `http://127.0.0.1:18753` in the Server's
configured origins using the configuration procedure below with
`--transport loopback`. Keep all required loopback origins in that list.

Close Client's workspace connection and press Ctrl+C in the SSH terminal to
close the tunnel. This does not stop Server or its running work. Client neither
creates the tunnel nor starts the remote services.

### Connect through an HTTPS reverse proxy

Complete `aixand-server setup` on the host before enabling remote access. This
creates the password locally. Initial HTTP password creation through a reverse
proxy is rejected; normal sign-in works through the configured HTTPS proxy.

You need a domain, a TLS certificate trusted by the client computer, and a
reverse proxy that can reach Server's loopback listener. These commands configure
Aixand; they do not install a proxy, configure DNS, or obtain a certificate.

Replace `https://suite.example.com` with your public origin, without a path or
trailing slash. The example assumes the proxy connects to Server from
`127.0.0.1`. Use the proxy's actual peer IP address if different.

Configuration changes require stopped services and disabled automatic startup.
Stopping the workspace interrupts its services; choose a suitable maintenance
time. First check whether automatic startup is enabled:

```sh
aixand-server startup status
```

If enabled, disable it before changing configuration:

```sh
aixand-server startup disable
```

Then stop the workspace, save its network settings, and start it again:

```sh
aixand-server stop
aixand-server configure --yes --transport https-proxy --origins https://suite.example.com --trust-proxy 127.0.0.1
aixand-server start
aixand-server doctor
```

`configure --yes` saves the supplied settings without interactive path and port
prompts. It preserves workspace data. If automatic startup was enabled before
the change, restore it with `aixand-server startup enable`.

Configure the reverse proxy to:

- Terminate HTTPS with the trusted certificate.
- Forward API and WebSocket traffic to `http://127.0.0.1:8753`.
- Preserve Host, Origin, and cookie headers, and forward WebSocket upgrades.
- Set `X-Forwarded-Proto: https` for requests received over HTTPS.

Trust only actual proxy peer addresses. Forwarded HTTPS headers from other peers
do not establish a secure connection. Server continues to bind loopback; do not
try to expose it by changing the production listener to `0.0.0.0`.

Open Client or Suite's Server connection window and enter
`https://suite.example.com/`. Sign in and open a conversation or terminal to
check both authenticated requests and live WebSocket traffic. Use
`aixand-server doctor` and `aixand-server logs server` on the host if it fails.
A healthy `/api/health` response alone does not verify authenticated access.

### Understand origins and authentication

An origin is the scheme, hostname, and port. It contains no path or trailing
slash. `https://suite.example.com`, `http://suite.example.com`, and
`https://suite.example.com:8443` are different origins. `localhost` and
`127.0.0.1` are also different hostnames.

Native Client sends the selected Server address's origin for HTTP and WebSocket
requests. Allow that origin, rather than a Tauri origin or the client computer's
LAN address. Multiple exact origins use a comma-separated value:

```sh
aixand-server configure --yes --transport https-proxy --origins "https://suite.example.com,https://suite.example.com:8443" --trust-proxy 127.0.0.1
```

Use the same disable-startup, stop, configure, start, and restore-startup sequence
above. `--origins` replaces the list; include every origin you intend to retain.
HTTPS proxy mode requires HTTPS origins. Loopback mode requires loopback origins.

Allowed origins do not grant access by themselves. Protected operations require
an authenticated session, and mutations also require a valid CSRF token.
WebSocket connections validate the session and exact origin. The workspace
password grants the authority of the Server's OS user; it is not a multi-user
account system. See [authentication](authentication.md) for session and recovery
details.

### Troubleshoot a remote connection

| Symptom | Check and corrective action |
| --- | --- |
| Connection refused or timeout | Run `aixand-server status` on the host. Check the SSH tunnel or proxy upstream address and port. |
| Client rejects an HTTP network address | Use HTTPS, or connect through SSH at an HTTP loopback address. |
| `Origin is not allowed` | Match the selected Server address's scheme, hostname, and port to the configured origin list. Restart services after configuration changes. |
| `HTTPS is required. Local connections need explicit loopback HTTP configuration.` | For HTTPS, check the actual proxy peer and its `X-Forwarded-Proto: https` header. For SSH, use loopback transport and an allowed loopback origin. |
| `Sign in required` | Sign in through the selected connection again; its session may have expired or been revoked. |
| `Invalid CSRF token` | Reload the workspace and sign in again if needed. Check that the proxy preserves cookies and uses the same selected origin. |
| Login succeeds but live updates fail | Check WebSocket upgrades, Origin forwarding, and cookies at the proxy. Inspect Server logs for authentication rejection. |
| `configure` refuses to save | Stop the workspace services and disable automatic startup before changing configuration. |

The owning checks are [production configuration](../src/production.ts),
[transport and origin validation](../src/auth/config.ts),
[authentication](../src/auth/auth.service.ts),
[native Client transport](../../desktop/src-tauri/transport/src/lib.rs), and
[saved Server configuration](../../../scripts/runtime/server-installer.mjs).

## Repair, reset and removal

Use a fresh qualified setup executable to repair the application runtime.
`aixand-server repair` explicitly reinstalls/verifies its independent product kit.
Updates and repair preserve workspace data and provider accounts.

Uninstall first asks whether to remove the application, tools, both, or
**Everything managed by Aixand**. Everything selects the application and all
available managed software, settings, and data. Native provider logins are kept;
remove those through their separate component choices. Other scopes then ask
whether to keep settings and data. The final review lists what will be
removed and kept, with paths. Reset offers data removal while it keeps software.

Private tools, shared products, tool data, provider accounts, provider software,
and retained product runtimes have separate choices. Removing shared store
records requires removing all products in that store. Product removal alone
keeps tool data. Additional application files are listed separately, with an
explicit choice to keep or permanently delete them. Tools without a supported
uninstall record are reported and kept; their original installer or package
manager must remove them.

The setup executable can remove supported tools and data even when the Aixand
application is absent. Use `--directory` to select another application location.
Use `--home` to select a workspace when its application record is absent. If no
installation is found, the terminal offers another path or Exit.

For scripts, use `--remove-target application|tools|both|everything`, `--purge`,
and `--yes`. Everything includes managed data without requiring `--purge`.
Add `--existing-files remove` to explicitly delete additional application files;
otherwise automation preserves them.
`--purge` selects data within that removal scope. `--select COMPONENT` selects
explicit components. `--all` selects all available components. `--json` returns
the removal result as JSON and sends review text to stderr.

When Install finds a nonempty application directory without its installation
record, it lists the files and offers to back up the entire directory to a unique
timestamped sibling, permanently remove its contents, choose another path, or
cancel. Permanent removal requires confirmation. For automation use
`install --existing-files backup|remove --yes`; `--yes` alone never authorizes
removing existing files. The installer verifies its payload before recovery and
continues to reject unsafe or redirected application paths. Backup directories
stay outside the fresh installation and are retained for manual review.

Removal disables affected application startup, stops its services, checks for
processes using selected paths, and applies the reviewed plan. Shared processes
require a separate review before they stop. Partial failures list completed and
unfinished components. Personal project folders outside managed stores stay.

On Windows, an uninstall launched by the installed command finishes application
file removal after that command exits; it reports an external result-log path.
The helper waits for process exit and never kills processes to delete the app.
Other selected cleanup is completed and reported before this final application
removal. Failed or blocked components remain explicit; removal is not a single
cross-component transaction.

## Build and qualification

```sh
python3 scripts/package-linux.py --engine podman --package server --without-voice
python3 scripts/package-macos.py --output /absolute/build --package server --without-voice
```

```powershell
.\build-windows.ps1 -Package server -WithoutVoice
```

`--package desktop`, `client`, `server`, `both` (Desktop and Server), or
`all` (the default, all three installers) selects package roles. The installation
model is distributed. `--runtime-only` emits verified runtime archives without native
installers. Server-only builds skip frontend compilation and Tauri packaging.
Native installers embed the exact verified archive in the executable, allowing
native code signing to cover the payload. Publication and platform signing or
notarization require separate release configuration and qualification.

Qualification uses disposable homes, state directories, ports and receipts. It
checks headless startup, APIs/authentication, restart, independent products,
console extraction, corruption/escape refusal, and selective maintenance. A
successful cross-platform source check does not substitute for native runtime
and installer execution on that target.
