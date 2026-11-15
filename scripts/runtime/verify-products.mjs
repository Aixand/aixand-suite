// Exercise real onboarding, product receipts, normal commands, and Suite removal.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, realpath, writeFile, rename } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyCarrier } from './verify-carrier.mjs'
import { windows, nodePath, binary } from './platform.mjs'
import { sharedProductPrefix } from './products.mjs'

const execute = promisify(execFile), root = resolve(process.argv[2])
// An ordinary user cannot rename an OS-owned package. Its caller removes that
// package with the OS package manager and checks the surviving commands next.
const installedPackage = process.argv.includes('--installed-package')
const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'suite-edition-')))
const home = join(directory, 'home 世界'), base = join(directory, 'state')
await mkdir(home)
// Windows cannot rename a directory while this verifier uses it as its cwd.
// Keep the harness outside the payload when checking independent commands.
process.chdir(directory)
async function port() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}
const localPort = await port(), carrierPort = await port()
const env = { ...process.env, HOME: home, USERPROFILE: home, AIXAND_LOCAL_HOME: base,
  ...(process.platform === 'darwin' ? { TMPDIR: '/tmp' } : {}),
  AIXAND_LOCAL_PORT: String(localPort), AIXAND_LOCAL_CARRIER_PORT: String(carrierPort),
  AIXAND_SKIP_PATH_REGISTRATION: '1', LOCALAPPDATA: join(home, 'AppData/Local'),
  APPDATA: join(home, 'AppData/Roaming'), PATH: windows ? join(process.env.SystemRoot || 'C:/Windows', 'System32') : '/usr/bin:/bin',
  PIP_NO_INDEX: '1', UV_OFFLINE: '1' }
delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV
for (const name of ['AIXAND_SHARED_PRODUCT_PREFIX', 'UNDERCURRENT_HOME', 'UNDERCURRENT_CONFIG', 'UNDERCURRENT_ENDPOINT', 'UC_SESSION',
  'RUNNER_HOME', 'AGENT_MANAGER_HOME', 'AGENT_MANAGER_CONFIG',
  'MCP_MANAGER_HOME', 'PROMPT_MANAGER_HOME', 'SKILL_MANAGER_HOME', 'SERVER_MANAGER_HOME', 'CARRIER_DATABASE'])
  delete env[name]
Object.assign(env, { XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data') })
const address = 'http://127.0.0.1:' + localPort
let cookie = '', csrf = ''
async function runtime(...args) {
  return JSON.parse((await execute(nodePath(root), [join(root, 'runtime.mjs'), ...args],
    { env, cwd: root, windowsHide: true, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 })).stdout)
}
async function request(path, body, expected = 200, authenticated = true) {
  const response = await fetch(address + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: address, ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(authenticated && csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const value = await response.json()
  assert.equal(response.status, expected, JSON.stringify(value))
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]
  return value
}
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
const catalog = JSON.parse(await readFile(join(root, 'products/catalog.json'), 'utf8'))
const commandVersions = new Map()
for (const assembly of catalog.assemblies) {
  for (const product of Object.values(assembly.products)) {
    for (const command of product.commands) {
      assert.ok(!commandVersions.has(command), 'Product command ownership must be unique: ' + command)
      commandVersions.set(command, product.version)
    }
  }
}
const distributed = manifest.installation.edition === 'distributed'
let hidden = false
let existingUndercurrent
const sharedPrefix = sharedProductPrefix(env)
const sharedReceiptPath = join(sharedPrefix, 'installation-receipt.json')
const settingsPath = join(home, '.aixand/undercurrent-cli/settings.toml')
const normalCli = async (...args) => JSON.parse((await execute(join(sharedPrefix, 'bin', binary('uc')),
  ['--json', ...args], { env, windowsHide: true, timeout: 30_000 })).stdout)
let sharedReceipt, settings, independentSession, previousProfile
try {
  {
    // Begin with an independently installed product. Distributed must reuse it;
    // Standalone must preserve its software, configuration, and running work.
    const row = catalog.assemblies.find(row => row.id === 'undercurrent')
    const prefix = sharedPrefix
    await execute(join(root, windows ? 'python/python.exe' : 'python/bin/python3'),
      ['-I', '-B', join(root, 'products/consumer/consumer.py'), 'install', '--artifact', join(root, 'products', row.artifact),
        '--prefix', prefix, '--scope', 'shared', '--owner', 'user',
        ...row.licenses.flatMap(license => ['--accept-license', license.sha256])],
      { env, windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
    sharedReceipt = await readFile(sharedReceiptPath, 'utf8')
    existingUndercurrent = JSON.parse(sharedReceipt).products.undercurrent.payload
    previousProfile = (await normalCli('settings', 'show')).active_profile
    if (!distributed) {
      await normalCli('settings', 'set', 'profile', 'default')
      settings = await readFile(settingsPath, 'utf8')
      await normalCli('start', 'independent-terminal-proof', '--profile', 'server', '--',
        join(root, windows ? 'python/python.exe' : 'python/bin/python3'),
        '-I', '-B', '-c', 'import time; time.sleep(600)')
      independentSession = (await normalCli('ls')).items.find(item => item.name === 'independent-terminal-proof').id
    }
  }
  const chosenPlan = await runtime('setup', 'choose', JSON.stringify({ mode: distributed ? 'shared' : 'isolated' }))
  const initial = await runtime('setup', 'products')
  assert.equal(initial.ready, false)
  if (distributed) assert.equal(initial.assemblies.find(row => row.id === 'undercurrent').installed, true)
  assert.equal((await runtime('start')).running, true)
  await request('auth/installation/status', undefined, 401, false)
  const password = 'Edition installation check 893!'
  await request('auth/setup', { password, confirmation: password }, 201)
  const session = await request('auth/session'); csrf = session.csrfToken
  const pending = await request('auth/installation/status')
  assert.equal(pending.edition, manifest.installation.edition)
  assert.equal(pending.ready, false)
  const token = csrf
  csrf = 'invalid'
  await request('auth/installation/install', { acceptedLicenses: [] }, 403)
  csrf = token
  await request('auth/installation/install', { artifact: '/arbitrary-source', acceptedLicenses: [] }, 400)
  if (pending.licenses.length) await request('auth/installation/install', { acceptedLicenses: [] }, 400)
  // Existing commands remain owned by their original installation.
  if (distributed && !windows) {
    await mkdir(join(home, '.local/bin'), { recursive: true })
    await writeFile(join(home, '.local/bin/agent'), '#!/bin/sh\nprintf existing-command\n', { mode: 0o755 })
  }
  const accepted = { acceptedLicenses: pending.licenses.map(row => row.sha256) }
  await request('auth/installation/install', accepted, 201)
  await request('auth/installation/install', accepted, 201) // Double clicks reuse the live operation.
  let installed
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    installed = await request('auth/installation/status')
    if (installed.job?.status === 'error' || installed.launchError)
      throw new Error(installed.job?.message || installed.launchError)
    if (installed.ready && installed.job?.status === 'complete' && !installed.starting) break
    await delay(1000)
  }
  assert.equal(installed.ready, true)
  assert.equal(installed.job?.status, 'complete')
  assert.equal((await runtime('status')).running, true, 'Onboarding must retain the live workspace')
  await verifyCarrier(createRequire(join(root, 'server/package.json'))('ws').WebSocket, address, cookie)
  const receipt = JSON.parse(await readFile(join(installed.prefix, 'installation-receipt.json'), 'utf8'))
  if (distributed) {
    assert.equal(installed.prefix, sharedProductPrefix(env))
    assert.equal(receipt.products.undercurrent.payload, existingUndercurrent)
  }
  assert.equal(receipt.scope, distributed ? 'shared' : 'private')
  assert.equal(receipt.owner, distributed ? 'user' : 'aixand-suite')
  assert.equal(Object.keys(receipt.products).length, 9)
  if (distributed) {
    const uc = join(installed.prefix, 'bin', binary('uc'))
    const cli = async (...args) => JSON.parse((await execute(uc, ['--json', ...args],
      { env, windowsHide: true, timeout: 30_000 })).stdout)
    const suiteProfile = chosenPlan.undercurrent.profile || 'aixand-suite'
    assert.equal(installed.ucConnection.profile, suiteProfile)
    assert.equal((await cli('settings', 'show')).active_profile, previousProfile, 'Setup must preserve the existing CLI selection')
    await cli('settings', 'set', 'profile', suiteProfile)
    const { WebSocket } = createRequire(join(root, 'server/package.json'))('ws')
    const socket = new WebSocket(address.replace('http:', 'ws:') + '/api/terminals/ws',
      { origin: address, headers: { Cookie: cookie } })
    try {
      const id = randomUUID()
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('App terminal proof timed out')), 30_000)
        const fail = error => { clearTimeout(timer); reject(error) }
        socket.on('error', fail)
        socket.on('close', () => fail(new Error('App terminal proof disconnected')))
        socket.on('message', raw => {
          const message = JSON.parse(String(raw))
          if (message.type === 'ready') socket.send(JSON.stringify({ id, op: 'create',
            args: { name: 'installer-terminal-proof', columns: 80, rows: 24 } }))
          else if (message.type === 'fatal' || message.type === 'error') fail(new Error(message.message))
          else if (message.id === id) { clearTimeout(timer); resolve(message.result) }
        })
      })
      const terminalId = result.session.id
      assert.ok((await cli('ls')).items.some(item => item.id === terminalId), 'Normal uc ls must show the actual app terminal')
      const alternate = 'qualification-independent'
      await cli('settings', 'profiles', 'register', alternate, '--home', join(directory, 'independent-uc'),
        '--owner', 'qualification', '--auto-start', 'never')
      await cli('--connection', alternate, 'daemon', 'start')
      await cli('settings', 'set', 'profile', alternate)
      assert.ok(!(await cli('ls')).items.some(item => item.id === terminalId), 'A separate instance must remain independent')
      assert.ok((await cli('--connection', suiteProfile, 'ls')).items.some(item => item.id === terminalId))
      assert.equal((await cli('settings', 'show')).active_profile, alternate, 'One-off connections must preserve selection')
      await cli('settings', 'set', 'profile', suiteProfile)
      await cli('--connection', alternate, 'daemon', 'stop')
    } finally { socket.close() }
  } else {
    assert.equal(installed.ucConnection, null)
    assert.equal(await readFile(settingsPath, 'utf8'), settings)
    assert.equal(await readFile(sharedReceiptPath, 'utf8'), sharedReceipt)
    assert.notEqual(installed.prefix, sharedPrefix)
    const privateSessions = (await runtime('exec', 'uc', '--json', 'ls')).items
    assert.ok(!privateSessions.some(item => item.id === independentSession), 'Private Suite must not adopt independent sessions')
    assert.ok((await normalCli('ls')).items.some(item => item.id === independentSession), 'Independent work must survive Suite setup')
  }
  for (const command of ['uc', 'runner', 'carrier', 'agent', 'prompt-manager', 'skill-manager', 'mcp-manager', 'conversation-manager', 'orchestration-mcp']) {
    await execute(join(installed.prefix, 'bin', binary(command)), ['--help'],
      { env, cwd: directory, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
    const { stdout } = await execute(join(installed.prefix, 'bin', binary(command)), ['--version'],
      { env, cwd: directory, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
    const versions = stdout.trim().split(/\s+/).map(value => value
      .replace(/a(\d+)$/, '-alpha.$1').replace(/b0$/, '-beta')
      .replace(/b(\d+)$/, '-beta.$1').replace(/rc(\d+)$/, '-rc.$1'))
    const expectedVersion = commandVersions.get(command)
    assert.ok(expectedVersion && versions.includes(expectedVersion),
      `${command} must report its owning product version ${expectedVersion}: ${stdout.trim()}`)
  }
  const runner = join(installed.prefix, 'bin', binary('runner'))
  const examples = join(installed.prefix, receipt.products.runner.payload, 'share/runner/examples')
  const submitted = JSON.parse((await execute(runner, ['--home', join(base, 'runner'), 'submit',
    join(examples, 'verify.json'), '--inputs', join(examples, 'inputs.json'), '--key', 'edition-check'],
    { env, windowsHide: true, timeout: 30_000 })).stdout)
  const jobId = submitted.job.id
  if (distributed && !windows) {
    assert.ok(installed.job.retained.includes(join(home, '.local/bin/agent')))
    assert.equal((await execute(join(home, '.local/bin/agent'), [], { env })).stdout, 'existing-command')
  }
  // A later launch selects product services while retaining authentication/state.
  await runtime('stop')
  assert.equal((await runtime('start')).running, true)
  await request('auth/session')
  const preserved = JSON.parse((await execute(runner, ['--home', join(base, 'runner'), 'inspect', jobId],
    { env, windowsHide: true, timeout: 30_000 })).stdout)
  assert.equal(preserved.id, jobId)
  assert.equal(preserved.state, 'completed')
  assert.equal((await runtime('setup', 'products')).ready, true)
  await runtime('stop')
  await writeFile(join(base, 'retained-user-data.txt'), 'preserve')
  if (distributed) {
    await runtime('uninstall-products')
    if (!installedPackage) { await rename(root, root + '.offline'); hidden = true }
    for (const command of ['uc', 'runner', 'carrier', 'agent', 'prompt-manager', 'skill-manager', 'mcp-manager', 'conversation-manager', 'orchestration-mcp'])
      await execute(join(installed.prefix, 'bin', binary(command)), ['--help'],
        { env, cwd: directory, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 })
    if (hidden) { await rename(root + '.offline', root); hidden = false }
  } else {
    await runtime('uninstall-products')
    assert.equal((await runtime('setup', 'products')).ready, false)
    assert.equal(await readFile(join(base, 'retained-user-data.txt'), 'utf8'), 'preserve')
    assert.equal(await readFile(sharedReceiptPath, 'utf8'), sharedReceipt)
    assert.equal(await readFile(settingsPath, 'utf8'), settings)
    assert.equal((await normalCli('settings', 'show')).active_profile, 'default')
    assert.ok((await normalCli('ls')).items.some(item => item.id === independentSession), 'Independent work must survive private product removal')
  }
  console.log(JSON.stringify({ verified: true, edition: manifest.installation.edition, build: manifest.build,
    checks: ['authenticated onboarding', 'license acceptance', 'install all', 'double click reuse',
      'nine independent product receipts', 'normal native and Python CLIs', 'CLI release versions', 'live workspace retained',
      'authenticated Carrier synchronization with Suite SDK',
      'restart with installed tools', 'Runner job retained', 'authentication retained', 'software ownership', 'user data retained',
      ...(distributed ? ['normal product installation reused', 'CLI conflicts preserved', 'existing CLI selection preserved', 'explicit Suite CLI profile selection',
        'actual app terminal visible through plain uc ls', 'separate UC instance isolated', 'one-off connection preserves selection',
        installedPackage ? 'commands survive product unregistration' : 'commands run with Suite payload unavailable'] : ['private software cleanup', 'global UC settings untouched',
        'independent product receipt untouched', 'independent sessions remain separate', 'independent work survives private removal'])],
    state: directory, nativeDesktopInstallationTested: false }))
} finally {
  if (hidden) await rename(root + '.offline', root)
  await runtime('stop').catch(() => {})
  if (!distributed) {
    await normalCli('stop', 'independent-terminal-proof').catch(() => {})
    await normalCli('daemon', 'stop').catch(() => {})
  }
}
