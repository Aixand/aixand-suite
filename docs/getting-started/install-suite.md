# Install Aixand Suite

Suite includes the interface, local backend, and workspace tools. Choose it to
work on this computer, with optional Server connections.

## Before you start

| Platform | Published full Suite requirements |
| --- | --- |
| Windows | x86_64, build 26200 or newer |
| macOS | Apple Silicon, macOS 26.5.1 or newer |
| Linux | x86_64, glibc 2.35 or newer; Debian package installation |

Windows alpha.3 installers are unsigned; macOS downloads are not notarized.
The OS may warn or block installation.

## Windows

Run in native x64 PowerShell:

```powershell
Invoke-WebRequest -UseBasicParsing 'https://installer.aixand.org/aixand-suite/install.ps1' -OutFile install-aixand-suite.ps1
.\install-aixand-suite.ps1 -Mode Install
```

Complete the installer dialogs, then open **Aixand Suite** from your applications.
You can also download the matching installer from the
[release download table](https://github.com/Aixand/aixand-suite/releases/tag/suite/v0.1.0-alpha.3).

## Linux and macOS

Run in a terminal:

```sh
curl -fsSL https://installer.aixand.org/aixand-suite | sh -s -- --install
```

- **Linux:** complete the Debian package installation; `sudo` and `apt-get` are required.
- **macOS:** copy the application from the opened disk image into Applications.

Open **Aixand Suite**. Omitting `--install` downloads and verifies the package
without starting installation.

## Next: configure Suite

Confirm the connection window opens, then [configure your local workspace](../guides/configure-suite.md).
To connect to another host instead, follow [Client configuration](../guides/configure-client.md).
