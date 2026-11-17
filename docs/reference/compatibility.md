# Compatibility

Installation downloads target **0.1.0-alpha.3**. Usage guides and screenshots
describe this checkout. Source features and fixture checks do not establish
support in an installed release.

## Platforms

Downloads: Windows x86_64, macOS ARM64, Linux x86_64.

Published full Suite, Server, Runner, and MCP payload minimums:

| Platform | Minimum |
| --- | --- |
| Windows | Build 26200 |
| macOS | 26.5.1 |
| Linux | glibc 2.35 |

Linux Suite/Client use Debian packages; Server also supports Fedora. Client needs
native WebView/TLS dependencies. Windows installers are unsigned; macOS downloads
are not notarized. See [installation](../../README.md#installation).

## Feature scope

| Feature | Limit |
| --- | --- |
| Core onboarding | Codex/OpenCode; sign-in alone does not prove model access |
| Chats/terminals | Separate lifecycles; provider capabilities gate controls |
| Prompts/MCP | Supported capture/delivery adapters required; configuration is not live readiness |
| Native skills | Managed-chat delivery still needs qualification |
| Advanced workflows | Compatible Runner, effect host, and advertised capabilities required |
| Connect | Separate network/pairing setup; see its managed-helper and Windows execution limits |
| Vox | Source included; voice runtimes/packages excluded from alpha.3 downloads |
| Updates | Alpha.3 supports signed checks; alpha.1/alpha.2 need installer upgrade first |

Components have independent versions. IR crates remain `0.1.0-alpha.1`; document
specifications 0.1/0.2 are separate. Installed updates require a compatible plan,
not merely matching version labels.

[Component versions](components.md) · [Dependency pins](../../scripts/runtime/dependencies.lock.json) ·
[Component guides](../README.md#find-a-component)
