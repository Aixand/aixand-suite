# Install Aixand with your agent

Give this guide to an agent that has terminal access to the computer where you
want Aixand installed. It covers published application installation, first setup,
and verification. No source checkout or developer toolchain is required.

The agent should perform the installation and checks it can complete, and guide
you through native dialogs, passwords, and provider sign-in when needed. A
terminal-only agent cannot complete every desktop interaction unattended.

## Give your agent this task

Copy the following instruction and attach this file or provide its public link:

> Install Aixand using agent-installation-instruction.md from the Aixand Suite
> repository. Use the published installer for this computer, not a source build.
> Unless I requested a remote setup, install full Suite for a local workspace
> with Isolated tools. Inspect existing installations before making changes.
> Complete installation and all available verification steps. Guide me through
> private password entry, provider sign-in, and any native dialogs you cannot
> operate. Never ask me to paste credentials into chat. Report what passed,
> failed, or still needs my interaction. Do not claim success from an installer
> exit code alone. For remote access, offer a persistent connection setup so I
> do not have to start an SSH tunnel manually each time. Explain the exact
> startup changes and obtain my approval before applying them, unless I already
> authorized that setup. Verify both the Server startup and connection behavior.

If you already have a Server, add its address and request **Client**. If you want
to host the workspace elsewhere, identify the Server computer and the client
computer. The agent needs access to each computer it will modify.

## Step 1: Inspect the computer and choose a role

Run checks on the destination computer, from any directory. On Linux/macOS:

```sh
uname -s
uname -m
```

On Linux, also identify the distribution and libc:

```sh
cat /etc/os-release
ldd --version
```

On macOS:

```sh
sw_vers
```

In native Windows PowerShell:

```powershell
[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
[System.Environment]::OSVersion.Version
```

Distinguish a native Windows installation from a Linux installation inside WSL.
Do not install a Linux package into WSL when the requested destination is the
Windows desktop.

Choose the application according to the user's request:

| Application | Destination and purpose |
| --- | --- |
| **Suite** (default) | Desktop computer that will run its own workspace; can also connect to Server |
| **Server** | Host that will store the workspace and run its agents and tools |
| **Client** | Desktop computer connecting to an existing Server; no local backend |

The documented release is **0.1.0-alpha.3**, for Windows x86_64, macOS ARM64,
and Linux x86_64. Full Suite and Server payloads require Windows build 26200,
macOS 26.5.1, or Linux glibc 2.35 or newer. Linux Suite/Client use Debian packages;
Server also supports Fedora. Client still requires its native WebView and TLS
platform dependencies. Do not force an installer onto an unsupported target.
See [installation requirements](README.md#installation).

Inspect the OS's installed application list and existing Aixand launchers. If
`aixand-server` is already available, use `aixand-server status` to inspect its
workspace before changing anything. Preserve existing installation paths,
workspace data, saved installation modes, and provider accounts. An existing
installation is an update or repair task, not a fresh empty workspace.

## Step 2: Download the matching installer

Use an empty working directory you can write to. Download only the script for
the selected application. The official routes are:

| Application | Linux/macOS script | Windows PowerShell script |
| --- | --- | --- |
| Suite | `https://installer.aixand.org/aixand-suite` | `https://installer.aixand.org/aixand-suite/install.ps1` |
| Server | `https://installer.aixand.org/aixand-suite/server` | `https://installer.aixand.org/aixand-suite/server/install.ps1` |
| Client | `https://installer.aixand.org/aixand-suite/client` | `https://installer.aixand.org/aixand-suite/client/install.ps1` |

For Linux/macOS, replace the URL for Server or Client as needed:

```sh
curl -fsSL https://installer.aixand.org/aixand-suite -o install-aixand.sh
```

For Windows, replace the URL for Server or Client as needed:

```powershell
Invoke-WebRequest -UseBasicParsing 'https://installer.aixand.org/aixand-suite/install.ps1' -OutFile install-aixand.ps1
```

Inspect the downloaded script before execution. It selects a native release
package and checks its expected size and SHA-256 digest. If the user requested
an exact release, use its release download rather than assuming the default
installer channel will always select alpha.3. Record the actual selected version.

Optional download-only verification uses these commands on the respective OS:

```sh
sh ./install-aixand.sh --download-only
```

```powershell
.\install-aixand.ps1 -Mode DownloadOnly
```

Expect `Verified native package:` followed by the retained package path. A
digest or size mismatch is a failed verification; do not execute that package.
Download-only retains a temporary package directory. Record it for cleanup.
Running the install mode next downloads and verifies a package again.

## Step 3: Run the native installation

On Linux/macOS:

```sh
sh ./install-aixand.sh --install
```

On Windows:

```powershell
.\install-aixand.ps1 -Mode Install
```

Use the agent environment's normal permission mechanism for required elevation
or GUI access. Linux desktop packages use `sudo` and `apt-get`. Native Server
setup needs an interactive terminal. On macOS, complete the application copy in
the opened disk image. Opening that image alone does not install the application.
Windows can display installer or elevation dialogs. Ask the user to complete
interactions the agent cannot operate, then continue verification.

Windows downloads are unsigned and macOS downloads are not notarized. Report OS
blocks accurately; do not disable system security controls to make installation
appear successful. If PowerShell policy blocks the script, use the native
installer from the [official release downloads](https://github.com/Aixand/aixand-suite/releases/tag/suite/v0.1.0-alpha.3)
or ask the user to follow their organization's approved execution method.

## Step 4: Complete the chosen application's setup

### Full Suite on this computer

1. Launch the installed **Aixand Suite** application.
2. Choose **This computer**.
3. Review the workspace location. For a fresh installation, use **Isolated** unless the user requested Shared tools.
4. Complete product and license review, then finish tool setup.
5. Let the user create the workspace password privately in the application's password fields.
6. Configure Codex, OpenCode, or both according to the user's request. Detect existing software before requesting a managed installation.
7. Let the user complete native provider sign-in. Preserve the selected environment and profile identities.
8. Register or select the intended project, or use a disposable project for the smoke test below.

Local Suite manages its network connection. Do not configure HTTPS, proxy trust,
or remote origins for normal **This computer** use. Shared versus Isolated tools
is a separate choice from networking. See [installation modes](README.md#understand-installation-modes).

### Server

On the host, open a new terminal if necessary to pick up the installed command:

```sh
aixand-server setup
aixand-server start
aixand-server status
aixand-server doctor
```

Run setup interactively so the user can create the password privately. Keep the
saved mode on an established workspace. For provider setup, use:

```sh
aixand-server providers install
aixand-server providers codex login
```

Use provider-specific help for OpenCode or other supported login options. Let
the user complete provider authorization privately. Configure either an
[SSH tunnel](apps/server/docs/installation.md#connect-through-an-ssh-tunnel) or
[HTTPS proxy](apps/server/docs/installation.md#connect-through-an-https-reverse-proxy)
when access is remote. Do not expose a plain HTTP LAN listener.

### Client or Suite connecting to Server

1. Verify the Server has completed setup and is running.
2. Establish the existing SSH tunnel, or verify the configured HTTPS proxy.
3. Launch Client, or choose Server in full Suite's connection window.
4. Save the HTTPS Server address or the tunnel's HTTP loopback address.
5. Let the user enter the workspace password privately.
6. Confirm that the selected host's workspace opens.

Client does not start Server, create tunnels, or install provider tools locally.
Do not treat the absence of local Server runtimes as a Client installation error.
See the [connection FAQ](README.md#connection-faq) if access is rejected.

### Offer persistent access for a remote workspace

After the first remote connection works, proactively offer to make access
persistent. Do not finish by only telling the user to keep a terminal open.
This step applies to separate Server connections; normal local Suite usage does
not need a tunnel or reverse proxy.

Explain two independent requirements: the Server must be running on its host,
and the client must have a working route to it. Saving a Server address in Client
does not keep an SSH tunnel alive. Server startup does not start a client tunnel.

Present a concrete option appropriate to the user's computers:

| Option | What the agent should propose |
| --- | --- |
| SSH access without a domain | A supervised tunnel on the client computer, started at user login and restarted after failures. Use a systemd user service on Linux where available, a LaunchAgent on macOS, or a per-user scheduled task on Windows. |
| Existing HTTPS infrastructure | A managed HTTPS reverse proxy on the Server host, with a trusted certificate and certificate renewal. Client connects directly to the HTTPS address without an SSH tunnel. |
| Occasional remote use | Keep the manual tunnel, if the user prefers no persistent configuration. Explain how to open and close it. |

Inspect the OS, existing services, SSH configuration, and permissions before
writing startup files. Show the user the proposed host, local port, account,
startup trigger, retry behavior, files or task names, and removal commands.
Explain any network exposure or additional installed software. Obtain approval
for that concrete plan unless the user already authorized those changes. If
declined, preserve the working manual connection and document its command.

For an SSH tunnel, first verify the host key interactively and establish an
approved key-based login. Never disable host-key checking or put passwords in
scripts. The supervised command should use noninteractive authentication,
failure detection, and keepalives. Replace `user@server-host` with the verified
destination and keep the local listener on loopback:

```sh
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:8753:127.0.0.1:8753 user@server-host
```

Keepalives detect a broken connection; the OS supervisor must restart the
process. Check that credentials or an approved SSH agent are available in the
startup context. A login that works in an interactive terminal may still fail
in a background task. Adapt and inspect the actual service configuration rather
than promising unattended access from the SSH command alone.

For Server startup, offer its built-in per-user login integration on the host.
After approval, run:

```sh
aixand-server startup enable
aixand-server startup status
```

This enables startup after the owning user logs in. It does not establish an
always-on boot service before login. Linux requires a working systemd user
session; macOS uses a LaunchAgent; Windows uses a limited user-logon task. If the
user needs service before login, explain that requirement separately and review
a host-specific plan rather than claiming this command provides it.
To undo the built-in startup setting, use `aixand-server startup disable`.

After implementing the approved plan:

1. Verify the Server's status on its host and the tunnel or proxy supervisor's status on its owning computer.
2. Close the original manual tunnel and confirm Client still connects through the managed route.
3. Restart only the new tunnel or proxy service and verify that Client can reconnect. Avoid interrupting unrelated services.
4. With the user's agreement, test a login cycle to check automatic startup. Otherwise report login-cycle verification as pending.
5. Record the service or task name, logs, start/stop commands, and exact rollback steps in the final report.

If noninteractive authentication, supervisor permissions, or certificate setup
cannot be completed, report persistent access as pending and retain the manual
connection instructions. Do not describe an untested startup entry as permanent
or reliable access.

## Step 5: Test the installed application

Perform these checks against the installed application, not a development server.
Use a disposable empty project for execution checks. Avoid modifying a real
project just to prove that installation worked.

| Check | Action and expected result |
| --- | --- |
| Installed identity | Launch the chosen application and inspect its displayed version where available. For Server, `aixand-server --help` identifies the command and version. Record the actual version. |
| Workspace access | Open the local workspace or connect to the intended Server. Confirm the intended project list and host, rather than another running instance. |
| Authentication | Sign out and sign in again with the user's private input. Confirm the workspace opens without origin or transport errors. |
| Server services, when applicable | Run `aixand-server status` and `aixand-server doctor` on the host. Record any failed component checks. |
| Terminal execution | Open a native terminal in the disposable project. Run `echo aixand-install-ok` and confirm that exact output appears. Close the test shell when finished. |
| Provider access | Open a conversation with the selected provider. Ask: “Reply with exactly aixand-install-ok. Do not run tools or change files.” Confirm the completed response appears. This can consume provider quota. |
| Reconnection | Close and reopen the workspace interface. Confirm it reconnects to the same workspace and can show the test conversation. |

If provider authorization or quota is unavailable, report application setup and
provider access separately. Successful provider login alone does not prove model
access. If browser/desktop automation is unavailable, have the user perform the
UI checks and record which results they confirmed; do not mark them agent-tested.

For a Server-only installation without an available Client, verify its services
and diagnostics and report the UI, terminal, and conversation checks as pending.
An installer exit code or health endpoint alone does not prove end-to-end success.

## Step 6: Diagnose failures and finish

Use `aixand-server logs server` and `aixand-server doctor` on the Server host for
startup or remote-access failures. Use the
[remote connection troubleshooting table](apps/server/docs/installation.md#troubleshoot-a-remote-connection)
for origin, HTTPS, session, and WebSocket errors. Redact credentials from any
reported logs. Preserve existing data and installation receipts during recovery.
Never delete authentication files to reopen setup; use
`aixand-server password` for host-side password recovery when needed.

Close test terminals and remove only disposable test material created for this
installation. Remove retained download-only package directories once no longer
needed. Keep the application, workspace, user projects, and provider accounts.
If an SSH tunnel is needed for ongoing access, tell the user to keep it running;
closing it disconnects Client without stopping the Server's work. If the user
approved persistent access, verify the managed tunnel first and close only the
temporary manual tunnel. Do not stop the managed route during cleanup.

Finish with a concise report:

- Application, version, OS/architecture, installation location, and workspace or Server address.
- Isolated or Shared mode, when applicable, and whether existing data was preserved.
- Passed checks, failed checks, and unverified checks with reasons.
- Remaining user interactions and how to launch or reconnect next time.
- Persistent access offered, accepted or declined, its verification results, and how to disable it; distinguish user-login startup from startup before login.
- Any temporary downloads or test resources left behind.

## Maintainer references

These instructions follow the [application roles](apps/web/docs/installation-editions.md),
[Server lifecycle and setup](apps/server/docs/installation.md),
[Client behavior](apps/web/docs/client.md), and
[provider onboarding](docs/onboarding.md). Update this guide when those contracts
or hosted installer routes change. The guide is ordinary documentation; it does
not install an agent skill or change an agent's permissions.
