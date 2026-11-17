# Connect through SSH

You need a [configured Server](configure-server.md), an SSH client on your desktop,
and an SSH account on the Server host. These commands work in PowerShell and
Linux/macOS terminals. They assume Server's default loopback transport and port 8753.

## Start the tunnel

On your desktop, replace `user@server-host` with your SSH destination:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8753:127.0.0.1:8753 user@server-host
```

Verify the host identity on first connection and complete SSH authentication.
Keep this terminal open. No origin changes are needed for this default tunnel.

In Client or Suite's Server connection window, enter:

```text
http://127.0.0.1:8753/
```

Sign in with the Suite workspace password. SSH authentication and workspace
sign-in are separate.

## Check and close

Open the intended workspace and check a conversation or terminal. If the tunnel
fails, check SSH access, Server status, and whether local port 8753 is occupied.

Close the workspace connection and press Ctrl+C in the SSH terminal to close the
tunnel. This disconnects Client without stopping Server or its running work.

## Avoid starting the tunnel manually

Use a per-user supervised tunnel that starts at login and restarts after failure,
or switch to [HTTPS](connect-https.md). Client itself does not create tunnels.

Ask your agent to follow the [persistent-access instructions](../../agent-installation-instruction.md#offer-persistent-access-for-a-remote-workspace).
It should propose the OS-specific startup entry, verify noninteractive SSH access,
get approval, and test reconnection. Server startup is a separate setting.

## If local port 8753 is occupied

Use local port 18753 while keeping Server on 8753. First, on the Server host,
check `aixand-server startup status`. If enabled, run
`aixand-server startup disable` before changing settings. Stopping Server
interrupts workspace services.

```sh
aixand-server stop
aixand-server configure --yes --transport loopback --origins "http://127.0.0.1:8753,http://localhost:8753,http://127.0.0.1:18753"
aixand-server start
```

Restore it with `aixand-server startup enable` if previously enabled.
`--origins` replaces the list;
include any other loopback origins you need to retain.

On your desktop:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18753:127.0.0.1:8753 user@server-host
```

Connect Client to `http://127.0.0.1:18753/`.
