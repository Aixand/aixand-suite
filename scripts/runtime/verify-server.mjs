// Real headless runtime qualification. All state, profiles and commands belong
// to this fixture; no provider account or developer workspace is accessed.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { nodePath, pythonPath, windows } from './platform.mjs'

const execute = promisify(execFile), root = resolve(process.argv[2])
// Darwin's per-user temporary directory can exceed Unix socket path limits.
const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'aixand-headless-proof-')))
const home = join(directory, 'home with spaces'), base = join(directory, 'workspace')
await mkdir(home, { recursive: true })
async function freePort() {
  const server = createServer(); await new Promise(ready => server.listen(0, '127.0.0.1', ready))
  const port = server.address().port; await new Promise(ready => server.close(ready)); return port
}
const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData/Local'),
  ...(process.platform === 'darwin' ? { TMPDIR: '/tmp' } : {}),
  APPDATA: join(home, 'AppData/Roaming'), XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
  XDG_STATE_HOME: join(home, 'state'), AIXAND_LOCAL_HOME: base, AIXAND_LOCAL_PORT: String(await freePort()),
  AIXAND_LOCAL_CARRIER_PORT: String(await freePort()), AIXAND_SKIP_PATH_REGISTRATION: '1',
  AIXAND_SHARED_PRODUCT_PREFIX: join(home, 'products'), PATH: windows ? join(process.env.SystemRoot || 'C:/Windows', 'System32') : '/usr/bin:/bin' }
for (const name of ['AIXAND_SETUP_USER_ENV', 'AIXAND_SUITE_INSTANCE_ID', 'PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'UNDERCURRENT_HOME', 'AGENT_MANAGER_HOME', 'AGENT_MANAGER_CONFIG', 'AIXAND_PRODUCTION_ORIGINS', 'AIXAND_PRODUCTION_TRANSPORT', 'AIXAND_PRODUCTION_TRUST_PROXY']) delete env[name]
const run = async (file, args = []) => (await execute(nodePath(root), [join(root, file), ...args],
  { env, cwd: root, timeout: 30 * 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout
const runtime = async (...args) => JSON.parse(await run('runtime.mjs', args))
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
let cookie
try {
  assert.equal(existsSync(join(root, 'web')), false, 'Server must exclude frontend files')
  assert.equal(manifest.installation?.role || manifest.role, 'server')
  assert.ok((await run('server-cli.mjs', ['--version'])).includes(manifest.version))
  if (!windows) {
    const proof = await execute(pythonPath(join(root, 'python')),
      [join(import.meta.dirname, 'verify-password-terminal.py'), root], { env, timeout: 45_000, maxBuffer: 1024 * 1024 })
    assert.equal(JSON.parse(proof.stdout).passed, true)
  }
  await runtime('setup', 'choose', JSON.stringify({ mode: 'isolated' }))
  const products = await runtime('setup', 'products')
  if (products.available) {
    await runtime('setup', 'install', JSON.stringify({ acceptedLicenses: products.licenses.map(row => row.sha256) }))
    assert.equal((await runtime('setup', 'products')).ready, true)
  }
  assert.equal((await runtime('doctor')).ready, true)
  assert.equal((await runtime('start')).running, true)
  assert.equal((await runtime('start')).running, true)
  const address = 'http://127.0.0.1:' + env.AIXAND_LOCAL_PORT
  assert.equal((await fetch(address + '/api/health')).status, 200)
  assert.equal((await fetch(address + '/')).status, 404)
  assert.equal((await fetch(address + '/recovery.html')).status, 404)
  assert.equal((await fetch(address + '/api/auth/session')).status, 401)
  const password = 'Headless fixture workspace password 482!'
  const setup = await fetch(address + '/api/auth/setup', { method: 'POST', headers: { Origin: address, 'Content-Type': 'application/json' }, body: JSON.stringify({ password, confirmation: password }) })
  assert.equal(setup.status, 201)
  cookie = setup.headers.get('set-cookie').split(';')[0]
  const session = await fetch(address + '/api/auth/session', { headers: { Cookie: cookie } })
  assert.equal(session.status, 200)
  const { csrfToken } = await session.json()
  const badOrigin = await fetch(address + '/api/auth/logout', { method: 'POST', headers: { Origin: 'https://untrusted.example', Cookie: cookie, 'X-CSRF-Token': csrfToken } })
  assert.equal(badOrigin.status, 403)
  await runtime('stop')
  assert.equal((await runtime('status')).running, false)
  assert.equal((await runtime('start')).running, true)
  assert.equal((await fetch(address + '/api/auth/session', { headers: { Cookie: cookie } })).status, 200)
  console.log(JSON.stringify({ verified: true, build: manifest.build, checks: ['frontend absent', 'console version', ...(!windows ? ['hidden terminal password initialization'] : []), 'required product setup', 'runtime dependencies',
    'headless startup', 'idempotent start', 'API health', 'no web routes', 'authentication required', 'password and session', 'origin and CSRF retained', 'restart preserves authentication'], nativeRuntimeTested: true }))
} finally {
  await runtime('stop').catch(() => {})
  await rm(directory, { recursive: true, force: true, maxRetries: 5 })
}
