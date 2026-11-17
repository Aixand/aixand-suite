# Configure Client

You need [Client installed](../getting-started/install-client.md), a
[configured Server](configure-server.md), and its workspace password. Full Suite's
**Server** connection uses the same steps.

## Connect

1. Make sure Server is running.
2. Prepare the connection and use its address:

   | Connection | Address |
   | --- | --- |
   | [SSH tunnel](connect-ssh.md) | `http://127.0.0.1:8753/` with the tunnel running |
   | [HTTPS proxy](connect-https.md) | Your configured HTTPS address, such as `https://suite.example.com/` |

3. Open the connection window and save the Server address; add a name if useful.
4. Open the connection and enter the workspace password privately.
5. Confirm the intended host's workspace and projects appear.

Client does not start Server, create tunnels, or install provider software locally.
Project paths and execution belong to Server.

## Check the connection

Follow [onboarding](../getting-started/first-workspace.md), then complete a
conversation or open a terminal to check live updates. Reopen the saved connection
to check reconnection.

For repeat access, configure [automatic tunnel startup](connect-ssh.md#avoid-starting-the-tunnel-manually)
or use HTTPS. If access is rejected, check [connection errors](remote-access.md#connection-errors).
