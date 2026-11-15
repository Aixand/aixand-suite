# Aixand Client

Aixand has three installer roles:

| Role | Installed components | Workspace choices |
| --- | --- | --- |
| Desktop | Frontend, local backend and product runtimes | This computer or Server |
| Client | Frontend and native desktop shell | Server only |
| Server | Backend and product runtimes | Hosts a workspace |

Client bundles its complete interface and can connect to a frontend-free Server.
It opens no localhost gateway or backend listener, starts no agent/runtime
processes, and carries no Node, Python or first-party product installation kit.
The OS WebView and native TLS dependencies are still required by the desktop
shell; the Windows installer can install WebView2.

The connection window retains saved servers, optional names, automatic opening,
connection health and reconnect. HTTPS is required for network addresses; HTTP
loopback addresses remain supported for an existing SSH tunnel. Client does not
create SSH tunnels or start services at those addresses. Configure the Server to
allow its root HTTPS origin, as in the existing Server proxy setup instructions.

Bundled assets load through Tauri. Restricted native commands send HTTP and
WebSocket traffic to the selected Server. Native code holds session cookies and
persists their original expiry times in the Client's per-user configuration
folder. On POSIX the session files have mode 0600. Passwords are not saved.
The server's normal password, transport, Origin and CSRF checks still apply.
Certificates use native trust validation; requests cannot follow redirects to
another host. Workspace content has no launcher, local runtime, cleanup or
process-execution permissions.

Each saved connection and backend address has separate session storage and a
separate browser data directory on Windows/Linux. macOS uses an ephemeral
workspace WebView to isolate browser data without requiring macOS 14 data-store
APIs; native sign-in sessions and saved connections still persist, but browser
preferences, drafts and caches do not survive closing that workspace on macOS.
Changing a connection closes the previous workspace and cancels its native
traffic; requests carrying its old connection generation are rejected.

Client installs independently as `org.aixand.suite.client`, with a separate app
name, binary and configuration directory. It can coexist with Desktop. To
update it, use **Client updates** in the connection window or install a newer
Client installer. Saved connections and sessions are retained. Daily checks and
optional automatic downloads never install or restart without consent. Client
uses its native updater; workspace component updates belong to the Server. The connection
window's **Client settings → Clear Client data** clears local saved connections,
sessions and browser data without changing the server. Use the OS uninstaller to
remove the application. Uninstall preserves per-user data unless cleared first.

## Building

Use the existing native packaging entry points:

```sh
python3 scripts/package-linux.py --package client --output /fresh/client-build
python3 scripts/package-macos.py --package client --output /fresh/client-build
```

```powershell
.\build-windows.ps1 -Package client -OutputDirectory C:\fresh\client-build
```

`--package all` (the default) builds Desktop, Server and Client. `both` retains
its earlier Desktop-and-Server meaning. Individual `desktop` and `server` choices
remain available. Client-only builds skip backend compilation, product builds,
and runtime assembly. Build tools and build-time Node do not ship in Client.
`--runtime-only` applies to runtime-bearing packages; Client has no runtime archive.

Client artifacts and checksums are in `output/installers/client`; the combined
`installers.json` includes its role. Native signing and public distribution need
the same release configuration as other installers. Native Windows/macOS build
and installation qualification must run on those platforms.

Enabled Client feeds require `AIXAND_CLIENT_UPDATE_CONFIG` containing public
trust settings and a positive safe `AIXAND_CLIENT_SEQUENCE`. Optional
`AIXAND_CLIENT_VERSION` must match the selected application version. The Linux
wrapper forwards these inputs into the build container. Packaging reads the
native build's emitted identity into `client.json.nativeUpdater`; release
preparation rejects mismatched version, sequence, trust or installer checksums.
The checked-in feed configuration remains disabled.

## Verification

```sh
npm --prefix apps/web run test:client
npm --prefix apps/web run test:desktop
cargo test --manifest-path apps/desktop/src-tauri/transport/Cargo.toml
python3 -m unittest discover -s scripts/runtime -p test_client_package.py
```

On Linux, `scripts/runtime/verify-client.py` drives the packaged application
through WebKitWebDriver under Xvfb. Its companion
`apps/web/scripts/client-auth-test-server.mjs` uses the actual Server authentication
module with a disposable database and an authenticated echo socket. It checks
login, native cookie persistence, authenticated API/WebSocket traffic, reconnect,
connection isolation, stale-request rejection, permission boundaries, local
reset, and app-owned TCP listeners. It does not qualify every agent feature or
substitute for native Windows/macOS installation tests.
