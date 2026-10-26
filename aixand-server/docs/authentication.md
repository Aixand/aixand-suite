# Suite password authentication

One password grants access to the entire single-owner Suite, including shell
input, agent execution, workflows, chats, and Carrier. Anyone with that password
has the same authority.

## First startup

Manager Suite, Runner, and Carrier are installed as part of the full Suite.
Password onboarding does not ask the user to install those components or edit
credentials in an environment file.

For local development, use Node.js 24.15+ and run from `aixand-server`:

```sh
npm ci
cp -n .env.example .env
npm run start:dev
```

Start `aixand-web` with `npm run dev -- --port 5186` and open
`http://127.0.0.1:5186` on the Suite host. First startup creates the private
authentication database automatically. The browser asks for a password and its
confirmation. Creating the password also creates the initial session in the same
transaction and starts agent onboarding over **Agents → Providers**. Subsequent visits show password
sign-in; an existing session resumes without another prompt. The browser stores
only an HttpOnly session cookie; credentials never enter localStorage or URLs.
There is no access-key setting, setup secret, initialization command, or web reset.

Agent onboarding selects Codex, OpenCode, Claude Code, or Antigravity; checks the
Suite host's OS, CPU architecture, WSL environment, and installation tools; then
guides installation, account connection, and the first profile. Installed,
compatible CLIs are initially selected. Refreshing detection preserves manual
selections. Agent Manager supplies installation recipes and manual instructions;
managed installation currently supports Codex and OpenCode on compatible Linux
and macOS hosts. Claude Code and Antigravity use their official manual installers.
These checks describe the Suite host, even when the browser is on another OS.

New password setup creates a pending workflow record in `workspace_onboarding`
in the same database transaction as the password and initial session. Progress
contains selection, names, and operation identifiers, never passwords or provider
credentials. Authenticated `GET /api/auth/onboarding` reads it; CSRF-protected
`POST /api/auth/onboarding` saves it with an expected revision. Stale saves return
409. Existing configured installations without this record are not forced into
onboarding. **Set up later** saves progress and exposes **Resume agent setup**;
reloads and later sign-ins resume unfinished setup. Opening a login's terminal
also preserves the setup so it can be resumed after interactive sign-in.

The account-menu **Onboarding** preview simulates the entire journey in memory,
including OS choices and failed operations. It never probes the host, installs
software, authenticates an account, or saves profiles or onboarding progress.

Initial password creation is local only. The backend requires a loopback socket
peer, loopback Host and browser Origin, an allowed Origin, and no forwarding
headers. It refuses setup from a configured trusted proxy, including a loopback
proxy. Vite checks the original browser connection before proxying setup, so a
remote client cannot claim localhost through headers. Complete local setup before
configuring the production reverse proxy. For a remote host, use an SSH tunnel to
its loopback frontend and open that tunnel on localhost; forwarding headers are
not needed. Normal HTTPS sign-in works through the production proxy afterward.

A private `auth.db.initialized` marker is written before database creation and
retained across restarts. Preserve it alongside the database and its backups.
If an initialized database disappears, startup refuses to recreate it. Empty,
corrupt, invalid, or unsupported existing databases also deny access and require
host-side repair. Never remove authentication files to reset a password.

Existing schema-one databases upgrade transactionally on startup. Configured
password hashes, credential versions, and sessions are preserved. An installation
that never finished password setup opens the new local password-only setup.

## Configuration and network deployment

| Setting | Purpose |
| --- | --- |
| `AIXAND_AUTH_DATABASE` | Absolute authentication database path; defaults to `~/.aixand/suite/auth/auth.db` |
| `AIXAND_AUTH_DEV_HTTP=1` | Explicit HTTP exception for loopback peers, loopback hosts, and loopback browser origins only |
| `AIXAND_AUTH_LOOPBACK_HTTP=1` | Same strict local/SSH exception; takes precedence over the legacy development flag |
| `AIXAND_AUTH_COOKIE_NAMESPACE` | Optional instance cookie namespace; production derives one from its authentication database path |
| `AIXAND_TRUST_PROXY` | Comma-separated exact reverse proxy peer IP addresses; default is empty |
| `CORS_ORIGINS` | Exact browser Origin allowlist, including scheme and port |

The [production entry point](production.md) serves the built frontend and APIs on
port 8753. It selects origins and transport through `AIXAND_PRODUCTION_*` settings
and does not inherit development listener settings. Production cookie names carry
an instance namespace; development retains its existing cookie names.

For network access, serve the compiled frontend and `/api` from the same HTTPS
origin through a reverse proxy. Forward WebSocket upgrades and preserve the
browser's `Origin` and cookie headers. Set `X-Forwarded-Proto` to `https`, and
configure `AIXAND_TRUST_PROXY` with only the proxy's actual peer addresses. Keep
the backend and daemon sockets on loopback/private interfaces. Set `CORS_ORIGINS`
to the frontend's exact HTTPS origin. Disable `AIXAND_AUTH_DEV_HTTP`.

Vite now binds loopback by default and is a development server. Binding it to
`0.0.0.0` exposes its API proxy and other development routes. Password login does
not turn Vite into a production hosting boundary. Raw forwarded headers from
untrusted peers cannot mark a request secure or choose the client IP.

HTTPS uses `__Host-aixand-session` with `Secure`, `HttpOnly`, `SameSite=Strict`, and
`Path=/`. Loopback development uses a separate `aixand-dev-session` cookie.
Sessions expire after 12 hours or one hour without authenticated requests/commands;
heartbeat pings and authentication status checks do not extend them. Background
workspace requests do count as activity. A maximum of 32 sessions is retained;
the oldest is revoked when a new login exceeds that cap.

All five WebSocket gateways validate the session and exact Origin before starting
bridges. Commands and outgoing data are checked against the current session.
Idle sockets are checked every second. Logout closes the current session's sockets;
recovery revokes every session. Existing execution lifecycles remain in effect:
durable jobs and terminal shells may continue after a browser disconnects.

Passwords contain 15–128 Unicode characters, including spaces, without trimming.
The server rejects entries in the bundled common-password list. Argon2id uses
64 MiB of memory, three passes, parallelism one, and a random salt. At most two
password hash operations run simultaneously. Per-IP limits allow five failed
attempts per minute with increasing cooldowns capped at 15 minutes; a global
limit permits 30 setup/login attempts per minute. Counters persist in SQLite and
expire. Authentication logs exclude passwords, cookies, CSRF
tokens, and request bodies.

## Recover through a host helper

Recovery requires terminal or SSH access as the host owner. Anyone who can execute
shell commands as the Suite OS user can also modify its authentication database.
The recovery link is instructions only; there is no web reset endpoint.

1. Stop `aixand-server` using its service manager or Ctrl-C.
2. Locate the configured authentication database. Preserve its exact path and
   back it up together with its `.initialized` marker; do not delete it or replace it with an empty file.
3. Run `npm run auth:recover` from `aixand-server`. Enter the new password twice
   through the hidden terminal prompt. Do not pass it as an argument or paste it
   into chat.
4. Restart the backend and sign in. The helper replaces the Argon2id hash,
   increments `credential_version`, and deletes all sessions and throttling
   counters in one transaction. Existing browser cookies cease to authorize access.

Use a dedicated private parent directory (`0700`); initialization refuses shared
existing directories without changing their permissions. The authentication database
is private (`0600`). Keep backups private too. Restore a valid backup if the credential record
or schema has been damaged; recovery refuses invalid records and missing databases.

## Manual SQL recovery

Stop the backend first. In the following commands, set `aixand_auth_db` to the
actual configured path if it differs from the default:

```sh
aixand_auth_db="$HOME/.aixand/suite/auth/auth.db"
umask 077
cp -pn -- "$aixand_auth_db" "$aixand_auth_db.before-recovery"
cp -pn -- "$aixand_auth_db.initialized" "$aixand_auth_db.initialized.before-recovery"
npm run auth:hash-password
sqlite3 "$aixand_auth_db"
```

The helper prompts for and confirms the password privately, then prints an encoded
Argon2id hash. Within the SQLite prompt, bind that complete hash, including all
`$` characters. Replace the example value below with the helper's actual output:

```sql
.parameter init
.parameter set @new_hash '$argon2id$v=19$m=65536,t=3,p=1$REPLACE_WITH_SALT$REPLACE_WITH_HASH'
BEGIN IMMEDIATE;
UPDATE workspace_auth
SET password_hash = @new_hash,
    credential_version = credential_version + 1
WHERE id = 1 AND state = 'configured';
SELECT changes();
```

`SELECT changes()` must return exactly `1`. If it does not, run `ROLLBACK;`, exit,
and repair or restore the database on the host. If it returns `1`, finish with:

```sql
DELETE FROM auth_sessions;
DELETE FROM auth_attempts;
COMMIT;
.quit
```

Restart the backend. Verify that the new password works, the previous password
fails, and previous browser cookies are rejected. Never clear the password, delete
the credential record, change its state to `setup_pending`, or insert a session
as a recovery shortcut. Those operations either leave access locked or undermine
the owner-verification boundary.

## Prompt for an AI agent

Use an agent that already has local or SSH access, independently of the locked
Suite chat:

> Recover the password for this Aixand Suite installation using terminal or SSH
> access to its host. Read aixand-server/docs/authentication.md and locate
> AIXAND_AUTH_DATABASE without exposing credentials. Stop the backend and back up
> its authentication database. Run npm run auth:recover from aixand-server and let
> me enter the password privately in the hidden terminal prompt. If you cannot
> provide private interactive input, prepare the manual steps for me. Never ask me
> to paste the password into chat or pass it as a command-line argument. Verify
> that the password hash was replaced, the credential version increased, and all
> sessions were revoked. Restart the backend and verify old sessions are rejected.
> Preserve workspace data. Do not delete authentication records, reopen setup, or
> enable an authentication bypass.

## Storage and verification

The authentication database is independent of chat and Carrier data. Schema
version two contains `workspace_auth`, `auth_sessions`, and `auth_attempts`.
Session tokens are stored as SHA-256 digests; passwords are
stored as encoded Argon2id hashes. Session creation checks the credential version
again after password verification so concurrent recovery cannot revive access.

```sh
npm run lint
npm test
npm run test:e2e
npm run build
```

From `aixand-web`, run `npm run test:auth` for real browser onboarding, login,
refresh, logout, remote setup rejection, recovery instructions, cross-tab revocation, and accessibility.
These checks use disposable databases and do not initialize a live installation.

The bundled `src/auth/common-passwords.txt` comes from
[SecLists 10k-most-common](https://github.com/danielmiessler/SecLists/blob/master/Passwords/Common-Credentials/10k-most-common.txt),
retrieved on 2026-10-12. Its MIT license is retained as `SecLists-LICENSE.txt`.
Refresh this file from the upstream list during dependency/security maintenance;
password checks make no external requests.
