# Production web service and connected desktop client

Production runs the compiled NestJS server on **127.0.0.1:8753**. The same listener
serves the built React interface, `/recovery.html`, downloads, `/api/*`, and the
existing WebSocket gateways. Browser clients, desktop clients, and authenticated
API callers use that one address. Vite is only needed for development.

## Build

From `aixand-suite`, with the existing development dependencies prepared:

```sh
node scripts/production.mjs build
```

This runs the frontend build (including the Connect download) and the NestJS
build. It does not start services or install Runner, Carrier, managers, provider
CLIs, Python environments, or MCP servers. Keep those existing runtime components
prepared as for the current Suite installation.

## Configure

Production reads `apps/server/.env`, then `.env.production`. Explicit process
environment variables override both files. `.env` continues to supply the existing
Suite runtime paths, credentials, and authentication database. Production listener
and transport settings have their own names, so a development `PORT=3001`,
`HOST=0.0.0.0`, or development origin list cannot select the production listener.

Copy `.env.production.example` to `.env.production` if you need overrides. The
defaults already select port 8753, loopback, and local/SSH access.

| Setting | Default / purpose |
| --- | --- |
| `AIXAND_PRODUCTION_PORT` | `8753`; integer from 1 to 65535 |
| `AIXAND_PRODUCTION_HOST` | `127.0.0.1`; `::1` is also supported |
| `AIXAND_PRODUCTION_ORIGINS` | `http://127.0.0.1:8753,http://localhost:8753`; exact frontend origins |
| `AIXAND_PRODUCTION_WEB_DIST` | Sibling `apps/web/dist`; must contain both HTML entry points |
| `AIXAND_PRODUCTION_TRANSPORT` | `loopback` for local/SSH, or `https-proxy` |
| `AIXAND_PRODUCTION_TRUST_PROXY` | Exact proxy peer addresses; required in HTTPS proxy mode |

When using a different local SSH forwarding port, add that exact browser origin
to `AIXAND_PRODUCTION_ORIGINS`. This setting replaces the development origin list.

## Start and switch an existing installation

After building, start the full production Suite through the existing launcher
from `aixand-suite`:

```sh
./dev.sh serve --production
```

This requires the existing Undercurrent daemon. It starts or reuses Carrier,
Runner, and the compiled production backend in detached managed sessions. There
is no separate Vite service in production. Readiness checks include the built
frontend, recovery page, and backend health on the combined production address.

When switching from this checkout's managed development setup, it checks builds,
configuration, ownership, and runtime prerequisites first. It then gracefully
stops the old managed backend and Vite session and replaces the backend's saved
development command with the production command. Carrier and Runner are reused.
This briefly disconnects existing development clients. Managed session records
and their old logs are cleaned during replacement; workspace data is preserved.
An unmanaged backend or a service name owned by another checkout is left alone
and reported rather than starting another backend against the same state.

Preview the operations without changing services:

```sh
./dev.sh serve --production --dry-run
```

Repeated production starts leave healthy services running and do not rebuild
assets. To refresh compiled code, run the build command explicitly. To return to
development, gracefully stop the managed backend, then run `./dev.sh serve`;
the launcher recreates its stopped production recipe as a development recipe.
Plain `./dev.sh serve` refuses to replace an active production backend.

Stop the production Suite with:

```sh
./dev.sh stop --production
```

Like the existing stop command, this also stops labelled Suite agent sessions
and workers. It preserves application data and leaves Undercurrent running.

`node scripts/production.mjs serve` from the Suite root, or `npm run start:prod`
from `apps/server`, remains available as a foreground backend-only command.
Stop any existing backend first when using these low-level commands. They do
not start or supervise Runner and Carrier.

Use one backend for an existing set of Suite state directories. Do not start a
second development or production backend against those same active databases,
workers, and sockets. A parallel test deployment needs its own complete runtime
configuration and disposable state. The automated production tests use fixtures.

The transition preserves the existing authentication database and workspace data.
Production uses a cookie namespace derived from its authentication database path,
so it does not overwrite development cookies on the same hostname. Sign in again
after switching. Cookies are not isolated by port. Browser-local preferences are
origin-specific and may start with defaults at the new address.

Check on the Linux host:

```sh
curl http://127.0.0.1:8753/api/health
```

Open `http://127.0.0.1:8753/` to sign in. `/api/health` reports NestJS liveness;
it does not certify readiness of every agent, provider, or Suite runtime.

## Windows over SSH

Run this on the client computer, in **Windows PowerShell** for the native Windows
app, or **inside WSL** for the Linux app running through WSLg:

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8753:127.0.0.1:8753 mbeepboop@10.10.0.7
```

Keep the tunnel open. Open `http://127.0.0.1:8753/` in your Windows browser, or save
that address in the Aixand desktop connection window. Windows uses the Linux
installation's projects, backend configuration, tools, and running work.

See `apps/web/docs/desktop.md` for exporting and building the desktop installer.
The old desktop preview that opens port 5173 needs to be rebuilt from the updated
source ZIP to get the bundled connection window and production default.

## HTTPS network deployment

Serve the combined application through an HTTPS reverse proxy. For example:

```dotenv
AIXAND_PRODUCTION_TRANSPORT=https-proxy
AIXAND_PRODUCTION_ORIGINS=https://aixand.example.com
AIXAND_PRODUCTION_TRUST_PROXY=127.0.0.1
```

Configure the actual domain and proxy peer. Forward HTTP and WebSocket requests
to the loopback service on port 8753, preserving Host, Origin, cookies, and
WebSocket upgrades. The trusted proxy must set `X-Forwarded-Proto: https`.
Production disables both loopback HTTP exceptions in this mode. Initial password
creation remains local-only; complete it through the local/SSH deployment first.

The connection window accepts HTTPS network addresses and loopback HTTP
addresses. It neither establishes an SSH tunnel nor starts a remote Suite. SSH
automation and fully packaged local runtimes are separate future milestones.
