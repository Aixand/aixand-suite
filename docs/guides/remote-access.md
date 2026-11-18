# Connect to Server

For a separate host, [configure Server](configure-server.md), choose a connection,
then [configure Client](configure-client.md). Full Suite can use the same Server
connection. Normal **This computer** use needs no manual networking.

| Method | Guide |
| --- | --- |
| SSH | [Start a tunnel and connect](connect-ssh.md) |
| HTTPS | [Configure origins, proxy trust, and connect](connect-https.md) |

Server listens on loopback. Plain HTTP to a LAN address is unsupported.
Client does not create tunnels or start remote services.

## Avoid starting a tunnel manually

Use [supervised SSH startup](connect-ssh.md#avoid-starting-the-tunnel-manually)
or managed HTTPS. Server startup is separate and runs after user login.

## Connection errors

| Problem | Check |
| --- | --- |
| Connection refused | Server status, tunnel/proxy, selected address and port |
| Origin rejected | Exact scheme, hostname, and port in Server's allowed origins |
| HTTPS required | Proxy peer trust and `X-Forwarded-Proto: https`, or default loopback transport for SSH |
| Sign-in required | Sign in again; the session may have expired |
| Invalid CSRF token | Reload and sign in again if needed; check cookie forwarding |
| No live updates | WebSocket upgrades, Origin, and cookies |

On the Server host, use `aixand-server status`, `aixand-server doctor`, and
`aixand-server logs server`. See the [detailed connection reference](../../apps/server/docs/operations/installation.md#troubleshoot-a-remote-connection).
