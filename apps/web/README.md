# Aixand Web

Web is the React, TypeScript and Vite workspace interface. Work runs on the
selected host. The [native shell](../desktop/README.md) owns windows and native
transport; [Server](../server/README.md) coordinates workspace operations.

## When to use this component

Develop chats, projects, terminals, workflows and resource selection here.
For installed use, choose [Suite or Client](../../README.md#installation).
Vite serves the development interface.

## Develop locally

Follow [local setup](docs/development.md#develop-locally) for the exact bootstrap,
Server origin and proxy settings, first-conversation check and shutdown steps.

## Verify a change

Use [development checks](docs/development.md#verify-a-change) and check keyboard
focus, both themes and the changed interaction. Suite preparation builds Connect
separately; Web dev/build do not regenerate its companion download.

### Browser and integration tests

See [test selection and prerequisites](docs/development/verification.md#browser-and-integration-tests)
for browser, Client, Desktop and live test paths. Inspect the selected configuration
before running it; fixture results do not establish model or installer readiness.

## Documentation

| Task | Guide |
| --- | --- |
| Find ownership and UI contracts | [Component map](docs/README.md) · [Development](docs/development.md) |
| Use chat controls | [Chat commands](docs/chat-commands.md) |
| Develop native applications | [Desktop](../desktop/README.md) · [Desktop development](docs/desktop.md) |
| Connect remotely | [Client](docs/client.md) · [Installation roles](docs/installation-editions.md) |
| Maintain updates | [Updates](docs/updates.md) · [Versions](docs/release-versions.md) |
| Respect backend security | [Agent integration](../../docs/development/agent-integration.md) · [Authentication](../server/docs/operations/authentication.md) |

[Suite](../../README.md) · [Support](../../SUPPORT.md) · [License](../../LICENSE)
