# Install Aixand Server

Server hosts projects, agents, and running work. Connect to it with
[Client](install-client.md) or full Suite. Server has no desktop or browser interface.

## Before you start

| Platform | Published Server requirements |
| --- | --- |
| Windows | x86_64, build 26200 or newer |
| macOS | Apple Silicon, macOS 26.5.1 or newer |
| Linux | x86_64, glibc 2.35 or newer; Fedora is also supported |

Use a terminal on the host you want to run the workspace. Windows alpha.3
installers are unsigned; macOS downloads are not notarized.

## Windows

Run in native x64 PowerShell:

```powershell
Invoke-WebRequest -UseBasicParsing 'https://installer.aixand.org/aixand-suite/server/install.ps1' -OutFile install-aixand-server.ps1
.\install-aixand-server.ps1 -Mode Install
```

Complete the terminal installer. Open a new terminal afterward to pick up the
`aixand-server` command on `PATH`.

## Linux and macOS

Run in an interactive terminal:

```sh
curl -fsSL https://installer.aixand.org/aixand-suite/server | sh -s -- --install
```

Complete the terminal installer. Unlike the desktop application, macOS Server
setup does not use a disk-image copy step.

The command is exposed in `~/.local/bin`; add that directory to `PATH` if needed.
Omitting `--install` downloads and verifies the package without starting setup.

## Next: configure Server

Run `aixand-server --help` to verify the installed command, then
[configure the workspace and remote access](../guides/configure-server.md).
