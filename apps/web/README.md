# Suite Web

Suite Web is the React, TypeScript and Vite workspace frontend. It presents chats,
native terminals, projects and manager-owned resources through Suite Server.
The desktop shell is a separate component in [apps/desktop](../desktop/package.json).
This development beta focuses on local Codex and OpenCode operation.

## Develop locally

With Node 24 and npm installed, run from `apps/web`:

```sh
npm ci
npm run dev
```

The build also requires Python 3.11+ to bundle the Connect companion. Vite prints
the development URL. Start and configure [Suite Server](../server/README.md),
then complete Suite password setup in the browser. A loaded page alone does not
verify a provider login or successful chat.

## Find the owning contract

- [UI development and interaction contracts](docs/development.md)
- [Chat commands](docs/chat-commands.md)
- [Desktop](docs/desktop.md), [Client](docs/client.md), and [installation roles](docs/installation-editions.md)
- [Updates](docs/updates.md) and [component versions](docs/release-versions.md)
- [Agent integration](../../docs/agent-integration.md)
- [Server authentication and recovery](../server/docs/authentication.md)

Run `npm run build` to type-check and build assets. `npm test` runs Playwright;
review [package.json](package.json) and the selected configuration for fixtures and
service prerequisites. Live checks can use provider resources and need an isolated
workspace. Do not treat browser fixtures as live provider qualification.
