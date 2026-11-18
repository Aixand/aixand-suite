# Aixand Desktop

The Tauri shell owns the trusted connection window, native transport and
maintenance controls. [Web](../web/README.md) owns the workspace interface;
[Server](../server/README.md) coordinates backend operations.

## Choose an application

| Application | Role |
| --- | --- |
| Suite | Interface, local backend and runtimes; choose This computer or Server |
| Client | Remote-only interface and shell; no local backend or runtime kit |

Use [installation guidance](../../README.md#installation) for platform and release
caveats. Remote connections require an existing SSH tunnel or HTTPS deployment;
the shell starts no remote services and creates no tunnels.

## Develop the shell

Follow [native development](docs/development/README.md) for prerequisites and exact
shell build/export commands. Prepare the documented inputs; an open Tauri window
does not establish backend readiness. Stop development with Ctrl+C when finished.

## Build complete installers

Use [packaging and qualification](docs/development/packaging.md) for exact native
platform commands, fresh output directories and Desktop/Client role selection.
Signing, notarization and publication are separate release operations.

## Verify native behavior

Use [verification](docs/development/verification.md) for focused transport and
browser checks. Confirm the selected workspace host, reconnect and authentication;
Client must not start a local backend. Qualify the exact installer on its target OS.
Preserve operation IDs and inspect uncertain maintenance outcomes before retrying.

## Documentation

| Task | Guide |
| --- | --- |
| Develop, package or verify | [Development](docs/development/README.md) · [Packaging](docs/development/packaging.md) · [Verification](docs/development/verification.md) |
| Understand remote-only transport | [Client contract](../web/docs/client.md) |
| Choose payloads | [Installation roles](../web/docs/installation-editions.md) |
| Maintain updates | [Updates](../web/docs/updates.md) |

## Component architecture

Read the [component map](docs/README.md) for ownership, lifecycles and integration.

[Suite](../../README.md) · [Support](../../SUPPORT.md) · [License](../../LICENSE)
