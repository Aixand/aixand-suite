# Develop Suite

Run from the Suite root. Use Node 24.15+, Rust, and the Python/uv prerequisites in
[dependencies](dependencies.md). Desktop development also needs native Tauri tools.

```sh
./dev.sh prepare
./dev.sh serve --dry-run
```

`prepare` creates the private Python environment and Connect companion. Use
`--local-sources` for sibling checkouts. The dry run needs the configured
Undercurrent daemon; it does not start services.

Start [Server](../../apps/server/README.md#develop-locally), then
[Web](../../apps/web/README.md#develop-locally). Complete local setup and check one
conversation. Stop foreground development processes with Ctrl+C.

| Task | Guide |
| --- | --- |
| Prepare dependencies | [Dependencies](dependencies.md) |
| Change shared behavior | [Integrations](integrations.md) |
| Change provider onboarding | [Onboarding](onboarding.md) |
| Change resources/sign-in handover | [Agent integration](agent-integration.md) |
| Change chat reconciliation | [Conversation integration](conversation-integration.md) |
| Run focused checks | [Testing](testing.md) |
| Build/publish releases | [Releases](releases.md) |
| Update documentation | [Documentation](documentation.md) |
| Import docs into the website | [Publication](publication.md) |

For end-user installation, use [getting started](../getting-started/installation.md).
