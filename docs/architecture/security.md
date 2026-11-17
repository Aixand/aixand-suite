# Security boundaries

A workspace has one owner. Its password grants the backend OS user's authority,
including agent execution and terminal input. Suite does not provide multi-user
isolation.

## Connections

Local Suite manages its connection. Separate Server deployments use loopback
through SSH or a configured HTTPS proxy.

Server checks transport, exact origin, session, and CSRF separately. Proxy HTTPS
headers count only from trusted peers. Native Client validates certificates and
uses the selected Server origin.

[Remote setup](../guides/remote-access.md) ·
[Authentication checks](../../apps/server/docs/authentication.md)

## Credentials and execution

Enter passwords/provider credentials privately, not in chat or command arguments.
Recover access through host-side tools; do not delete authentication records.

The native connection window owns maintenance controls. Workspace content cannot
gain those privileges. Child reporting contexts do not grant parent permissions.

Sockets, credentials, and executable bindings are host configuration. Portable
workflows cannot select arbitrary runtime secrets or executable modules.

## Optional integrations

Connect relies on its configured NetBird encrypted network and the receiving
machine's execution policy. See [Connect trust](../../services/connect/README.md#trust-and-storage).

Vox needs microphone permission and separate speech setup. Local speech processing
does not mean its agent model runs locally.

[Report a vulnerability](../../SECURITY.md)
