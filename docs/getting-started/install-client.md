# Install Aixand Client

Client connects to an existing Server. It includes the interface without a local
backend or provider runtime kit.

## Before you start

You need a configured [Server](install-server.md), its address, and the workspace
password. Downloads cover Windows x86_64, macOS Apple Silicon, and Linux x86_64.
Client requires the OS WebView and native TLS dependencies; Windows setup can
install WebView2.

Windows alpha.3 installers are unsigned; macOS downloads are not notarized.
The OS may warn or block installation.

## Windows

Run in native x64 PowerShell:

```powershell
Invoke-WebRequest -UseBasicParsing 'https://installer.aixand.org/aixand-suite/client/install.ps1' -OutFile install-aixand-client.ps1
.\install-aixand-client.ps1 -Mode Install
```

Complete the installer dialogs, then open **Aixand Client** from your applications.
You can also download the matching installer from the
[release download table](https://github.com/Aixand/aixand-suite/releases/tag/suite/v0.1.0-alpha.3).

## Linux and macOS

Run in a terminal:

```sh
curl -fsSL https://installer.aixand.org/aixand-suite/client | sh -s -- --install
```

- **Linux:** complete the Debian package installation; `sudo` and `apt-get` are required.
- **macOS:** copy the application from the opened disk image into Applications.

Open **Aixand Client**. Omitting `--install` downloads and verifies the package
without starting installation.

## Next: configure Client

Confirm the connection window opens, then [save your Server connection](../guides/configure-client.md).
