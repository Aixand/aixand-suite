// Destructive integration checks operate only inside a generated fixture home.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { nodePath, binary } from './platform.mjs'

const root = resolve(process.argv[2]), execute = promisify(execFile)
const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'aixand-reset-proof-')))
const home = join(directory, 'home'), base = join(home, 'workspace'), prefix = join(home, 'products')
await mkdir(home)
async function port() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming'),
  AIXAND_LOCAL_HOME: base, AIXAND_SHARED_PRODUCT_PREFIX: prefix, AIXAND_SKIP_PATH_REGISTRATION: '1',
  XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
  AIXAND_LOCAL_PORT: String(await port()), AIXAND_LOCAL_CARRIER_PORT: String(await port()),
  PATH: process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin', UV_OFFLINE: '1', PIP_NO_INDEX: '1' }
for (const key of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'UNDERCURRENT_HOME', 'UNDERCURRENT_CONFIG', 'UNDERCURRENT_ENDPOINT', 'AGENT_MANAGER_HOME', 'AGENT_MANAGER_CONFIG']) delete env[key]
const run = async (...args) => JSON.parse((await execute(nodePath(root), [join(root, 'runtime.mjs'), ...args], { env, windowsHide: true, cwd: directory, timeout: 1_200_000, maxBuffer: 4 * 1024 * 1024 })).stdout)
const put = async (name, text = 'fixture') => { const path = join(base, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text) }
const checks = []
try {
  const plan = await run('cleanup', 'plan')
  assert.ok(plan.items.some(item => item.id === 'workspace'))
  assert.equal(existsSync(base), false)
  checks.push('readonly preview before first launch')
  await put('auth/auth.db'); await put('chats/history'); await put('agents/codex/account-proof')
  await put('agents/provider-sdks/claude/sdk-proof'); await put('tools/keep-proof')
  const apply = async selected => { const review = await run('cleanup', 'plan'); const report = await run('cleanup', 'apply', JSON.stringify({ revision: review.revision, selected, confirmed: true })); assert.equal(report.failed, null); return report }
  await apply(['workspace'])
  assert.equal(existsSync(join(base, 'auth/auth.db')), false)
  for (const path of ['agents/codex/account-proof', 'agents/provider-sdks/claude/sdk-proof', 'tools/keep-proof']) assert.equal(existsSync(join(base, path)), true)
  checks.push('workspace password removed; unchecked provider accounts, SDKs and CLI files kept')
  await apply(['provider-accounts'])
  assert.equal(existsSync(join(base, 'agents/codex')), false)
  assert.equal(existsSync(join(base, 'agents/provider-sdks/claude/sdk-proof')), true)
  checks.push('managed provider account removal keeps unchecked SDKs and software')
  await run('start')
  const address = `http://127.0.0.1:${env.AIXAND_LOCAL_PORT}`
  const password = 'Disposable cleanup verification 893!'
  const configured = await fetch(address + '/api/auth/setup', { method: 'POST', headers: { Origin: address, 'Content-Type': 'application/json' }, body: JSON.stringify({ password, confirmation: password }) })
  assert.equal(configured.status, 201)
  assert.equal((await (await fetch(address + '/api/auth/status')).json()).state, 'configured')
  const catalog = JSON.parse(await readFile(join(root, 'products/catalog.json'), 'utf8'))
  const setup = await run('setup', 'install', JSON.stringify({ acceptedLicenses: catalog.assemblies.flatMap(row => row.licenses.map(license => license.sha256)) }))
  assert.equal(setup.ready, true)
  const distributed = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).installation.edition === 'distributed'
  if (distributed) {
    const before = JSON.parse(await readFile(join(prefix, 'installation-receipt.json'), 'utf8'))
    await apply(['product:manager-suite/prompt-manager'])
    const after = JSON.parse(await readFile(join(prefix, 'installation-receipt.json'), 'utf8'))
    assert.equal(Object.keys(after.products).length, Object.keys(before.products).length - 1)
    assert.equal(after.products['manager-suite/prompt-manager'], undefined)
    for (const [id, value] of Object.entries(after.products)) assert.equal(value.payload, before.products[id].payload)
    await execute(join(prefix, 'bin', binary('agent')), ['--version'], { env, windowsHide: true, timeout: 30_000 })
    checks.push('individual manager removal keeps all eight other payloads and working agent CLI')
  }
  // HOME isolation does not isolate an OS keychain. Never invoke real vendor
  // logouts or uninstall a host provider CLI from an integration fixture.
  // Vendor actions are covered separately with fake executables and mocks.
  await apply((await run('cleanup', 'plan')).items.filter(item => item.available && !item.id.startsWith('native:') && !item.id.startsWith('provider:')).map(item => item.id))
  assert.equal(existsSync(join(base, 'agents/provider-sdks')), false)
  assert.equal(existsSync(join(base, 'tools')), false)
  if (distributed) {
    assert.equal(Object.keys(JSON.parse(await readFile(join(prefix, 'installation-receipt.json'), 'utf8')).products).length, 0)
    const ucSettings = await readFile(join(home, '.aixand/undercurrent-cli/settings.toml'), 'utf8')
    assert.ok(!ucSettings.includes('[profiles.aixand-suite]'))
  }
  checks.push('select all removes selected shared products and owned UC profile; independent default settings remain')
  assert.equal((await run('start')).running, true)
  const response = await fetch(`http://127.0.0.1:${env.AIXAND_LOCAL_PORT}/api/auth/status`)
  const session = await response.json()
  assert.equal(session.state, 'setup_pending')
  checks.push('fresh workspace starts and requires a new password')
  console.log(JSON.stringify({ passed: true, edition: distributed ? 'distributed' : 'standalone', checks, realUserDataModified: false }))
} finally {
  await run('stop').catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
