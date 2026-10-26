# Desktop and terminal-only Server installation

New releases use one distributed installation model. **Aixand Desktop** includes
the native desktop shell, its complete interface and a local backend.
**Aixand Server** includes the backend and its runtime, with no frontend assets,
Tauri executable or WebView dependency. Both use the same independent product
packages and installation receipts. All first-party products are 0.1.0-beta.

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
explicit HTTPS reverse proxy. Configure exact origins and trusted proxy peers:

```sh
aixand-server configure --yes --transport https-proxy \
  --origins https://suite.example --trust-proxy 127.0.0.1
```

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

## Repair, reset and removal

Use a fresh qualified setup executable to repair the application runtime.
`aixand-server repair` explicitly reinstalls/verifies its independent product kit.
Updates and repair preserve workspace data and provider accounts.

`reset` and `uninstall` show the shared component checklist. Nothing is selected
by default. Workspace/password data, managed accounts, provider software, shared
provider logins, SDKs, private tool stores and individual products remain separate
choices. Shared selections affect other applications. Project folders outside
the managed stores are retained. Locked files require reviewing the exact listed
applications before asking them to stop.

On Windows, an uninstall launched by the installed command finishes application
file removal after that command exits; it reports an external result-log path.
The helper waits for process exit and never kills processes to delete the app.
Other selected cleanup is completed and reported before this final application
removal. Failed or blocked components remain explicit; removal is not a single
cross-component transaction.

Old standalone manifests remain readable for upgrades. Their private product
store is retired only after independent replacements verify and the workspace
daemon stops. Unverified private stores are retained with a migration report.

## Build and qualification

```sh
python3 scripts/package-linux.py --engine podman --package server --without-voice
python3 scripts/package-macos.py --output /absolute/build --package server --without-voice
```

```powershell
.\build-windows.ps1 -Package server -WithoutVoice
```

`--package desktop`, `server` or `both` selects package roles. The installation
model is always distributed. Public entry points no longer build standalone
editions. `--runtime-only` emits verified runtime archives without native
installers. Server-only builds skip frontend compilation and Tauri packaging.
Native installers embed the exact verified archive in the executable, allowing
native code signing to cover the payload. Publication and platform signing or
notarization require separate release configuration and qualification.

Qualification uses disposable homes, state directories, ports and receipts. It
checks headless startup, APIs/authentication, restart, independent products,
console extraction, corruption/escape refusal, and selective maintenance. A
successful cross-platform source check does not substitute for native runtime
and installer execution on that target.
