# Client session fixture and native recipe

Scope: production Rust `apps/desktop/src-tauri/transport` against production
Server `AuthModule` and `configureApp`. `/api/terminals/ws` is a fixture echo
endpoint using the production `AuthService.authorizeSocket`; it is not a
terminal process, chat fixture, full Server application, or native GUI test.
No Tauri/IPC implementation is mocked or exercised by the Rust probe.

Files:

- `scripts/qualification/client-session.mjs`: Linux contained build/run driver.
- `scripts/qualification/client-session.rs`: production transport lifecycle probe.
- `scripts/qualification/client-session-server.mjs`: reusable Server auth fixture.
- Existing `apps/web/scripts/isolated-test-server.mjs`: isolated source compilation
  and synthetic auth DB initialization, password `isolated Suite password 9274!`.

Linux driver requires `env -i`, bwrap read-only `/`, writable isolated source,
private `/tmp`, network/PID/IPC/UTS namespaces, proc/dev mounts, fresh HOME/XDG
and explicit manager/provider roots. `AIXAND_SESSION_CONTAINED=1` is only a
caller assertion, not a containment mechanism. Set `AIXAND_SESSION_EVIDENCE` to
a fresh directory inside isolated source. Use offline Cargo with a fresh writable
CARGO_HOME whose registry points to an existing read-only cache, fresh target,
explicit existing RUSTUP_HOME/toolchain, and existing Node/Cargo/compiler PATH.
No downloads, installation, or cleanup commands are needed. Escalate namespace
denial through the approved channel without removing containment.

The driver builds a temporary Cargo project depending on the unchanged transport
crate and copies its Cargo.lock before offline resolution. It compiles Server
source to a private output directory; it does not use shared `apps/server/dist`.
The fixture listens on one ephemeral loopback port and sets CORS_ORIGINS to that
exact origin. It uses the same private auth DB through a clean Server restart.
The separate login and logout probe processes verify disk-backed Client sessions.
Logs and SHA256 evidence are retained; temporary DB/cookies stay in private /tmp.

## Mac handoff: prepare the same auth fixture

Root must arrange the approved native sandbox, fresh private HOME/XDG/manager
roots and owned loopback port. Do not reuse a real profile or alter OS settings.
Run this initialization inside that containment from the isolated source root:

```js
// node --input-type=module; WORK must be a new, private writable directory.
import { buildTestServer } from './apps/web/scripts/isolated-test-server.mjs'
import { resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
const work = process.env.WORK
if (!work || !process.env.HOME || !process.env.PORT) throw Error('Explicit fixture roots/port required')
const server = resolve('apps/server')
const main = buildTestServer(server, work)
process.env.CORS_ORIGINS = `http://127.0.0.1:${process.env.PORT}`
const child = spawn(process.execPath, [
  resolve('scripts/qualification/client-session-server.mjs'),
  server, dirname(main), process.env.PORT,
], { cwd: work, env: process.env, stdio: 'inherit' })
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal))
child.once('exit', code => { process.exitCode = code ?? 1 })
```

Keep the initialization process and fixture in the owned sandbox. `READY` means
the fixture is listening, not that acceptance passed. Restart the child with the
same compiled output and AIXAND_AUTH_DATABASE, without rebuilding/reseeding DB.

In the actual bundled native Client: add the fixture URL, connect, observe login,
reject an incorrect fixture password, enter the synthetic password, and verify
signed-in state. Quit/relaunch the same private Client home and verify session
restoration. Restart the fixture preserving its DB and verify reconnection.
Sign out and verify login returns after relaunch. Native UI evidence must capture
the actual WebView and native IPC; browser screenshots are not substitutes.

The fixture intentionally cannot supply chat/delegation/approval/question UI.
For those gates, retain the full offline provider/Carrier initialization from
`apps/web/scripts/test-chats-live.mjs`, `tests/fixture.py`,
`tests/app_server_provider.py` and `tests/chat_carrier.py` under Server's
`agent-bridge`. That broad harness injects a browser cookie and uses browser
transport, so its earlier passes do not prove native Client transport acceptance.
Do not rerun it or relabel it as native evidence merely for this session fixture.

Capture native app/build hashes, frontend asset hashes, selected URL/port,
source hashes, exact environment/command, rendered UI screenshots/traces, Server
request evidence and final fixture/probe output. Cookie/password files must remain
private; hash evidence and logs must not include real credentials. The Rust probe
checks HTTP401 before login, WS1008 before login, bad-password401, login201,
session200, hidden cookie response headers, wrong-CSRF403, native WS echo,
disk reload, Unix0600, preserved login after Server restart, logout201,
active WS1008, post-logout401, and revoked disk-cookie replay rejected HTTP/WS.
