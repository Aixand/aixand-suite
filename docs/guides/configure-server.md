# Configure Server

Run these commands on the [installed Server host](../getting-started/install-server.md).
Open a new terminal if `aixand-server` is not yet on `PATH`.

## Set up the workspace

```sh
aixand-server setup
```

Review the workspace path, tools, and licenses. Choose **Isolated** for private
workspace tools/settings or **Shared** to reuse compatible user tools/settings.
Create the password privately in the terminal. Existing workspaces keep their
saved mode.

Start and check the services:

```sh
aixand-server start
aixand-server status
aixand-server doctor
```

If startup fails, inspect `aixand-server logs server`.

## Choose remote access

| Method | Use it when |
| --- | --- |
| [SSH tunnel](connect-ssh.md) | You have SSH access and want a loopback connection from your desktop |
| [HTTPS proxy](connect-https.md) | You have a domain, trusted TLS certificate, and reverse proxy |

The default listener is `127.0.0.1:8753`. Keep it on loopback. Direct HTTP to a LAN
address is unsupported. Server hosts the backend; Client supplies its interface.

## Optional startup after login

```sh
aixand-server startup enable
aixand-server startup status
```

This starts Server after the owning user logs in, not before login. Linux needs
a working systemd user session. Undo with `aixand-server startup disable`.
A client-side SSH tunnel has its own startup configuration.

Next: configure your chosen connection, then [connect Client](configure-client.md).
