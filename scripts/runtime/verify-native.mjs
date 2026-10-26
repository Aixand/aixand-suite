// Drive the installed Linux executable through the platform's WebKit WebDriver.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)
const systemTools = process.argv.includes('--system-tools')
const home = await mkdtemp(join(tmpdir(), 'aixand-gui-'))
const localHome = join(home, 'local')
await mkdir(localHome)
async function port() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}
const localPort = await port(), carrierPort = await port()
const env = { ...process.env, HOME: home, AIXAND_LOCAL_HOME: localHome,
  AIXAND_LOCAL_PORT: String(localPort), AIXAND_LOCAL_CARRIER_PORT: String(carrierPort),
  XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'),
  NO_AT_BRIDGE: '1', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1' }
Object.assign(env, { GDK_BACKEND: 'x11', LIBGL_ALWAYS_SOFTWARE: '1', WEBKIT_DISABLE_DMABUF_RENDERER: '1' })
const driver = spawn(process.argv[2], [], { env, stdio: ['ignore', 'inherit', 'inherit'] })
let session
async function call(method, path, body) {
  const response = await fetch('http://127.0.0.1:4444' + path, { method, signal: AbortSignal.timeout(30_000),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    .catch(error => { throw new Error(`${method} ${path}: ${error.message}`) })
  const result = await response.json()
  assert.ok(response.ok, JSON.stringify(result))
  return result.value
}
async function command(method, path, body) { return call(method, `/session/${session}${path}`, body) }
async function element(selector) {
  const value = await command('POST', '/element', { using: 'css selector', value: selector })
  return value['element-6066-11e4-a52e-4f735466cecf']
}
async function text(selector) { return command('GET', `/element/${await element(selector)}/text`) }
try {
  if (systemTools) {
    const installed = await execute('/usr/bin/aixand-runtime', ['setup', 'install', JSON.stringify({ mode: 'system' })], { env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 })
    assert.equal(JSON.parse(installed.stdout).ready, true)
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await call('GET', '/status'); break } catch { await delay(100) }
  }
  const opened = await call('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: '/usr/bin/aixand-desktop' } } } })
  session = opened.sessionId
  console.error('Native check: desktop opened')
  const main = await command('GET', '/window')
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await command('POST', '/execute/sync', { script: 'return !document.querySelector("#local-workspace").disabled', args: [] })) break
    await delay(100)
  }
  assert.equal(await command('POST', '/execute/sync', { script: 'return !document.querySelector("#local-workspace").disabled', args: [] }), true)
  await command('POST', `/element/${await element('#local-tab')}/click`, {})
  assert.equal(await command('POST', '/execute/sync', { script: 'return document.querySelector("#local-setup").open', args: [] }), false)
  if (systemTools) {
    await command('POST', `/element/${await element('#local-setup > summary')}/click`, {})
    await command('POST', '/execute/sync', { script: 'const select = document.querySelector("#runtime-mode"); select.value = "system"; select.dispatchEvent(new Event("change", { bubbles: true }));', args: [] })
    await command('POST', `/element/${await element('#check-system-tools')}/click`, {})
    for (let attempt = 0; attempt < 300; attempt++) {
      if ((await text('#setup-message')).startsWith('Tools are ready.')) break
      await delay(200)
    }
    assert.match(await text('#setup-message'), /^Tools are ready\./)
  }
  await command('POST', `/element/${await element('#local-workspace')}/click`, {})
  let title
  for (let attempt = 0; attempt < 300; attempt++) {
    await command('POST', '/window', { handle: main })
    title = await text('#status-title')
    if (['Connected', 'Cannot open workspace', 'Local tools need attention'].includes(title)) break
    await delay(300)
  }
  assert.equal(title, 'Connected', await text('#status-message'))
  const setup = JSON.parse((await execute('/usr/bin/aixand-runtime', ['setup', 'info'], { env, timeout: 30_000 })).stdout)
  if (setup.installation) {
    assert.equal(setup.configured, false, 'Edition setup must wait for onboarding in the workspace')
    assert.equal(setup.installation.ready, false)
    assert.equal(setup.mode, setup.installation.edition === 'distributed' ? 'system' : 'bundled')
  } else {
    assert.equal(setup.configured, true)
    assert.equal(setup.mode, systemTools ? 'system' : 'bundled')
  }
  console.error('Native check: workspace connected')
  const handles = await command('GET', '/window/handles')
  assert.equal(handles.length, 2)
  await command('POST', '/window', { handle: handles.find(handle => handle !== main) })
  assert.equal(await command('GET', '/url'), `http://127.0.0.1:${localPort}/`)
  const blocked = await command('POST', '/execute/async', { script: `
    const done = arguments[arguments.length - 1];
    if (!window.__TAURI__?.core?.invoke) return done(true);
    Promise.all(['connection_settings', 'local_runtime_setup'].map(command =>
      window.__TAURI__.core.invoke(command, { action: 'info', options: {} }).then(() => false, () => true)
    )).then(results => done(results.every(Boolean)));
  `, args: [] })
  assert.equal(blocked, true, 'Workspace must not have launcher native permissions')
  console.error('Native check: native permissions blocked')
  await command('POST', '/window', { handle: main })
  // WebKit's capture stalls on the long diagnostics page in the system run.
  // The bundled run supplies a screenshot; both runs verify the native UI.
  if (process.argv[3] && !systemTools) await writeFile(process.argv[3], Buffer.from(await command('GET', '/screenshot'), 'base64'))
  await call('DELETE', `/session/${session}`)
  session = undefined
  assert.equal((await fetch(`http://127.0.0.1:${localPort}/api/health`)).status, 200)
  console.log(JSON.stringify({ passed: true, mode: setup.mode, edition: setup.installation?.edition,
    checks: ['installed native launcher', 'advanced tools collapsed on startup',
      setup.installation ? 'edition ownership selected before web onboarding' : 'tool selection applied on open',
      'local start via native command', 'separate workspace window', 'correct workspace address',
      'workspace native permissions blocked', 'services outlive connection window'] }))
} finally {
  if (session) await call('DELETE', `/session/${session}`).catch(() => {})
  driver.kill('SIGTERM')
  await execute('/usr/bin/aixand-runtime', ['stop'], { env, timeout: 90_000 }).catch(error => console.error(error.message))
}
