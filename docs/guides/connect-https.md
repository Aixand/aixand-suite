# Connect through HTTPS

Complete [Server setup](configure-server.md) first. You also need a domain, a
certificate trusted by your desktop, and a reverse proxy on the Server host.
The commands below configure Aixand; they do not install the proxy or certificate.

## Configure Server

Replace `https://suite.example.com` with your origin: scheme, hostname, and port,
without a path or trailing slash. This example uses a proxy connecting from
`127.0.0.1`; change `--trust-proxy` to its actual peer IP if different.

Run on the Server host:

```sh
aixand-server startup status
```

If startup is enabled, run `aixand-server startup disable` first. Stop active work
before this maintenance step; stopping Server interrupts workspace services.

```sh
aixand-server stop
aixand-server configure --yes --transport https-proxy --origins https://suite.example.com --trust-proxy 127.0.0.1
aixand-server start
aixand-server doctor
```

Restore startup with `aixand-server startup enable` if previously enabled.
`--origins` replaces the allowed list; multiple exact HTTPS origins are comma-separated.

## Configure the proxy

| Setting | Required value |
| --- | --- |
| Public listener | HTTPS with the trusted certificate |
| Upstream | `http://127.0.0.1:8753` |
| Headers | Preserve Host, Origin, and cookies |
| Forwarded protocol | Set `X-Forwarded-Proto: https` for HTTPS requests |
| WebSockets | Forward upgrades and authenticated traffic |

Keep Server on loopback. Trust only actual proxy peers. Manage certificate renewal
and proxy startup so the address remains usable.

## Connect and verify

Save `https://suite.example.com/` in Client or Suite's Server connection window.
Sign in with the workspace password, then check a conversation or terminal for
live updates. A health response alone does not verify authenticated access.

`https://suite.example.com` and `https://suite.example.com:8443` are different
origins. Native Client sends the selected Server origin; allow that address,
not your desktop IP.

If login fails, check the origin, proxy peer, and forwarded protocol. If login
works but live updates fail, check WebSocket forwarding. Inspect
`aixand-server logs server` on the host.

[Connection errors](remote-access.md#connection-errors) ·
[Authentication reference](../../apps/server/docs/operations/authentication.md)
