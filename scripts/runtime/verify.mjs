// Integration check for the installed package. Uses only Node and modules shipped with it.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, delimiter, toNamespacedPath } from 'node:path'
import { windows, binary, nodePath, pythonPath, cliDirectory } from './platform.mjs'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyCarrier } from './verify-carrier.mjs'

const execute = promisify(execFile)
const root = resolve(process.argv[2])
const installedCommands = process.argv.includes('--installed-commands')
const systemTools = process.argv.includes('--system-tools')
const require = createRequire(join(root, 'server/package.json'))
const { WebSocket } = require('ws')
const directory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'aixand-installed-')))
const home = join(directory, systemTools ? 'home with spaces' : 'home')
await mkdir(home)
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
const port = await freePort(), carrierPort = await freePort()
const env = { HOME: home, PATH: installedCommands || systemTools ? '/usr/bin:/bin' : '/unavailable-development-tools',
  AIXAND_LOCAL_HOME: join(directory, 'state'), AIXAND_LOCAL_PORT: String(port), AIXAND_LOCAL_CARRIER_PORT: String(carrierPort) }
if (windows) {
  Object.assign(env, { SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
    USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming'),
    TEMP: directory, TMP: directory, PATHEXT: '.COM;.EXE;.BAT;.CMD', AIXAND_SKIP_PATH_REGISTRATION: '1',
    PATH: join(process.env.SystemRoot || 'C:/Windows', 'System32') })
}
async function runtime(...args) {
  // Tauri canonicalizes Windows resources to extended-length (\\?\) paths.
  const desktopRoot = windows ? toNamespacedPath(root) : root
  const program = installedCommands ? (args[0] === 'exec' ? args[1] : 'aixand-runtime') : nodePath(desktopRoot)
  const argv = installedCommands ? (args[0] === 'exec' ? args.slice(2) : args) : [join(desktopRoot, 'runtime.mjs'), ...args]
  const result = await execute(program, argv, { env, cwd: desktopRoot, windowsHide: true, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 })
  return result.stdout
}
let cookie
let systemSelection
const address = `http://127.0.0.1:${port}`
async function request(path, body) {
  const response = await fetch(address + path, { method: body ? 'POST' : 'GET',
    headers: { Origin: address, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  assert.ok([200, 201].includes(response.status), `${path}: ${response.status} ${response.statusText}`)
  const value = await response.json()
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]
  return value
}
async function socket(path) {
  const socket = new WebSocket(address.replace('http:', 'ws:') + path, { origin: address, headers: { Cookie: cookie } })
  const waiting = new Map()
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const timer = setTimeout(() => readyReject(new Error(`${path} did not become ready`)), 25_000)
  socket.on('error', readyReject)
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString())
    if (value.type === 'ready') { clearTimeout(timer); readyResolve() }
    if (value.type === 'fatal') { clearTimeout(timer); readyReject(new Error(value.message)) }
    const callback = waiting.get(value.id)
    if (callback) { waiting.delete(value.id); callback(value) }
  })
  await ready
  return { request: (op, args = {}) => new Promise((resolve, reject) => {
    const id = randomUUID()
    const deadline = setTimeout(() => { waiting.delete(id); reject(new Error(`${op} timed out`)) }, 30_000)
    waiting.set(id, value => { clearTimeout(deadline); if (value.type === 'error') reject(new Error(value.message)); else resolve(value.result) })
    socket.send(JSON.stringify({ id, op, args }))
  }), close: () => socket.close() }
}

try {
  await execute(pythonPath(join(root, 'python')), ['-B', '-m', 'unittest', 'discover',
    '-s', join(root, 'server/carrier-bridge'), '-p', 'test_stdio.py'],
    { env: { ...env, PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true, timeout: 60_000 })
  const links = JSON.parse(await readFile(join(root, 'symlinks.json'), 'utf8'))
  for (const [name, target] of Object.entries(links)) {
    assert.equal((await lstat(join(root, name))).isSymbolicLink(), true, `Runtime link was materialized: ${name}`)
    assert.equal(await readlink(join(root, name)), target)
  }
  if (systemTools) {
    assert.equal(JSON.parse(await runtime('setup', 'info')).configured, false)
    const checked = JSON.parse(await runtime('setup', 'check', JSON.stringify({ mode: 'system' })))
    assert.equal(checked.ready, false, 'A clean system must not silently use the app bundle')
    const existingCommand = join(cliDirectory(env), binary('uvx'))
    await mkdir(cliDirectory(env), { recursive: true })
    await writeFile(existingCommand, '#!/bin/sh\necho existing-user-command\n', { mode: 0o755 })
    const installed = JSON.parse(await runtime('setup', 'install', JSON.stringify({ mode: 'system' })))
    assert.equal(installed.ready, true, JSON.stringify(installed.checks.filter(item => !item.ready)))
    assert.ok(!installed.prefix.startsWith(root + '/'))
    assert.ok(!installed.prefix.startsWith(env.AIXAND_LOCAL_HOME + '/'))
    assert.ok(installed.retained.includes(existingCommand))
    assert.equal(await readFile(existingCommand, 'utf8'), '#!/bin/sh\necho existing-user-command\n')
    env.PATH = installed.cliDirectory + delimiter + (windows ? join(env.SystemRoot, 'System32') : '/usr/bin:/bin')
    for (const name of ['uc', 'runner', 'carrier', 'agent', 'mcp-manager', 'prompt-manager', 'skill-manager', 'server-manager', 'orchestration-mcp'])
      assert.ok((await execute(name, ['--help'], { env, timeout: 30_000 })).stdout.length)
    assert.ok(JSON.parse((await execute('agent', ['codex', 'profile', 'list', '--json'], { env, timeout: 30_000 })).stdout))
    const venv = join(home, 'existing Python environment')
    await execute(join(root, 'bin', binary('uv')), ['venv', '--system-site-packages', '--python', installed.tools.python, venv], { env: { ...env, UV_PYTHON_DOWNLOADS: 'never' }, timeout: 30_000 })
    systemSelection = { mode: 'system', python: join(venv, windows ? 'Scripts/python.exe' : 'bin/python3'), voicePython: installed.tools.voicePython }
    const saved = JSON.parse(await runtime('setup', 'save', JSON.stringify(systemSelection)))
    assert.equal(saved.configured, true)
    assert.notEqual(saved.tools.pythonHome, venv, 'Embedded Python must use the base interpreter, not the virtual environment home')
    assert.deepEqual(JSON.parse(await readFile(join(env.AIXAND_LOCAL_HOME, 'config/setup.json'), 'utf8')).managerEnvironment, {})
    assert.equal(JSON.parse(await runtime('setup', 'info')).mode, 'system')
    await writeFile(join(directory, 'system-tools.json'), JSON.stringify(installed))
  }
  if (installedCommands) {
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
    for (const name of ['aixand-runtime', ...manifest.commands]) {
      const found = await execute('/bin/bash', ['--noprofile', '--norc', '-c', 'test "$(type -t "$1")" = file && command -v "$1"', 'installed-cli-check', name], { env })
      assert.equal(found.stdout.trim(), `/usr/bin/${name}`)
    }
    const help = await execute('/bin/bash', ['--noprofile', '--norc', '-c', 'uc --help && runner --help && carrier --help && agent --help'], { env })
    assert.ok(help.stdout.length)
    const profiles = await execute('agent', ['codex', 'profile', 'list', '--json'], { env, timeout: 30_000 })
    assert.ok(JSON.parse(profiles.stdout))
    assert.equal(JSON.parse(await runtime('status')).running, false, 'CLI setup must not start desktop services')
    const failure = await execute('uc', ['--aixand-invalid-option'], { env }).then(() => null, error => error)
    assert.ok(Number.isInteger(failure?.code) && failure.code !== 0, 'Installed CLI must preserve failure exit codes')
  }
  const doctor = JSON.parse(await runtime('doctor'))
  assert.equal(doctor.ready, true)
  await mkdir(join(env.AIXAND_LOCAL_HOME, 'config'), { recursive: true })
  await writeFile(join(env.AIXAND_LOCAL_HOME, 'config/runtime.env'), 'AIXAND_PACKAGING_TEST_SECRET=private-installation-canary\n', { mode: 0o600 })
  const first = JSON.parse(await runtime('start'))
  assert.equal(first.running, true)
  if (systemTools) {
    await assert.rejects(runtime('setup', 'save', JSON.stringify({ mode: 'bundled' })), /Stop local services/)
    assert.equal(JSON.parse(await runtime('status')).running, true)
  }
  const initial = JSON.parse(await runtime('exec', 'uc', '--json', 'ls'))
  const receipt = await readFile(join(env.AIXAND_LOCAL_HOME, 'runtime.json'), 'utf8')
  assert.equal(JSON.parse(await runtime('start')).running, true)
  assert.equal(await readFile(join(env.AIXAND_LOCAL_HOME, 'runtime.json'), 'utf8'), receipt)
  const repeated = JSON.parse(await runtime('exec', 'uc', '--json', 'ls'))
  assert.deepEqual(repeated.items.map(item => item.id).sort(), initial.items.map(item => item.id).sort())
  for (const name of ['aixand-local-carrier', 'aixand-local-server', 'aixand-local-runner'])
    assert.ok(!(await runtime('exec', 'uc', '--json', 'inspect', name)).includes('private-installation-canary'))
  assert.match((await (await fetch(address)).text()), /<html/)
  assert.equal((await fetch(address + '/recovery.html')).status, 200)
  const status = await request('/api/auth/status')
  assert.equal(status.state, 'setup_pending')
  const password = 'Isolated installation check 9274!'
  await request('/api/auth/setup', { password, confirmation: password })
  assert.equal((await request('/api/auth/session')).authenticated, true)
  await verifyCarrier(WebSocket, address, cookie)
  const agents = await socket('/api/agents/ws')
  assert.ok(Array.isArray(await agents.request('project-list')))
  const providers = await agents.request('providers')
  assert.equal(providers.schema, 'agent-manager/provider-catalog-1')
  assert.equal(providers.inventoryComplete, true,
    JSON.stringify(providers.providers.filter(provider => provider.configured === null).map(({ provider, error }) => ({ provider, error }))))
  if (windows) assert.equal(providers.providers.find(provider => provider.provider === 'claude').authentication.authMode, 'native')
  assert.equal((await request('/api/auth/onboarding/status')).needed, true, 'A fresh installation must offer agent setup')
  agents.close()
  const terminals = await socket('/api/terminals/ws')
  assert.ok(await terminals.request('list'))
  const terminal = await terminals.request('create', { name: 'installation-check', columns: 80, rows: 24 })
  assert.ok(terminal)
  terminals.close()
  const workflowApi = await socket('/api/workflows/ws')
  assert.ok(await workflowApi.request('catalogs'))
  workflowApi.close()
  const health = JSON.parse(await runtime('exec', 'runner', '--home', join(env.AIXAND_LOCAL_HOME, 'runner'), 'health'))
  assert.ok(health)
  const workflow = { ir_version: '0.1', name: 'installed_verifier',
    inputs: {}, body: { kind: 'sequence', steps: [{ kind: 'operation', id: 'verify', operation: { id: 'verifier.verify', version: '1.0.0' },
      inputs: { document: { kind: 'literal', value: { title: 'Installation', body: 'The installed workflow works.', labels: [] } },
        required_terms: { kind: 'literal', value: ['workflow'] } } }] },
    outputs: { result: { type: { kind: 'json' }, value: { kind: 'ref', source: 'step', step: 'verify', output: 'result' } } } }
  const workflowPath = join(directory, 'workflow.json'), inputsPath = join(directory, 'inputs.json')
  await writeFile(workflowPath, JSON.stringify(workflow)); await writeFile(inputsPath, '{}')
  const submission = JSON.parse(await runtime('exec', 'runner', '--home', join(env.AIXAND_LOCAL_HOME, 'runner'), 'submit', workflowPath, '--inputs', inputsPath, '--key', randomUUID()))
  let result
  for (let attempt = 0; attempt < 60; attempt++) {
    result = JSON.parse(await runtime('exec', 'runner', '--home', join(env.AIXAND_LOCAL_HOME, 'runner'), 'result', submission.job.id))
    if (['completed', 'failed', 'blocked', 'cancelled'].includes(result.state)) break
    await delay(250)
  }
  assert.equal(result.state, 'completed', JSON.stringify(result))
  for (const name of ['agent', 'mcp-manager', 'prompt-manager', 'skill-manager', 'server-manager', 'orchestration-mcp', 'aixand-mcp', 'carrier', 'aixand-connect'])
    assert.ok((await runtime('exec', name, '--help')).length, name)
  const providerManifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  for (const provider of ['codex', 'claude']) {
    assert.equal(providerManifest.commands.includes(provider), false, 'Provider CLI must be installed separately')
    await assert.rejects(lstat(join(root, 'bin', binary(provider))))
  }
  // Exercise the shipped stdio MCP adapter, not just its help output.
  const child = installedCommands
    ? spawn('orchestration-mcp', ['serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(nodePath(root), [join(root, 'runtime.mjs'), 'exec', 'orchestration-mcp', 'serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'installation-check', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map(value => JSON.stringify(value) + '\n').join(''))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP handshake timed out')) }, 20_000)
    child.once('error', reject)
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(stderr)) })
  })
  const replies = stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(replies.find(row => row.id === 1)?.result?.protocolVersion, '2025-06-18')
  assert.ok(Array.isArray(replies.find(row => row.id === 2)?.result?.tools), stdout)
  await runtime('stop')
  assert.equal(JSON.parse(await runtime('status')).running, false)
  assert.ok((await readFile(join(env.AIXAND_LOCAL_HOME, 'auth/auth.db'))).length)
  const foreign = createServer()
  await new Promise(resolve => foreign.listen(port, '127.0.0.1', resolve))
  try {
    await assert.rejects(runtime('start'), /already in use/)
    assert.equal(foreign.listening, true)
  } finally { await new Promise(resolve => foreign.close(resolve)) }
  if (systemTools) {
    env.PROMPT_MANAGER_HOME = join(home, 'existing prompts')
    await mkdir(env.PROMPT_MANAGER_HOME)
    await writeFile(join(env.PROMPT_MANAGER_HOME, 'user-data'), 'preserve-existing-data')
    await runtime('setup', 'save', JSON.stringify({ ...systemSelection, reuseConfig: true }))
    const saved = JSON.parse(await readFile(join(env.AIXAND_LOCAL_HOME, 'config/setup.json'), 'utf8'))
    assert.equal(saved.managerEnvironment.PROMPT_MANAGER_HOME, env.PROMPT_MANAGER_HOME)
    assert.equal(await readFile(join(env.PROMPT_MANAGER_HOME, 'user-data'), 'utf8'), 'preserve-existing-data')
  }
  await runtime('start')
  cookie = undefined
  await request('/api/auth/login', { password })
  assert.equal((await request('/api/auth/session')).authenticated, true)
  console.log(JSON.stringify({ passed: true, checks: ['runtime symlink integrity', ...(systemTools ? ['system tool discovery', 'no bundled fallback', 'independent user-level installation', 'standalone normal CLI commands', 'existing commands preserved', 'external virtual environment', 'explicit manager configuration reuse', 'persisted system selection', 'active mode-switch refusal'] : []), ...(installedCommands ? ['normal installed commands', 'fresh shell without aliases', 'first use before desktop startup', 'CLI failure exit codes'] : []), 'private state', 'startup', 'idempotent start', 'frontend', 'recovery', 'password setup', 'Carrier stdio and exclusive ownership', 'authenticated Carrier synchronization', 'agent bridge', 'complete provider inventory', 'fresh installation onboarding', 'terminal creation', 'workflow catalogs', 'Runner workflow execution', 'CLIs', 'MCP handshake', 'shutdown', 'occupied-port refusal', 'restart with preserved authentication'], voice: doctor.voice, state: directory }))
} finally { await runtime('stop').catch(error => console.error(error.message)) }
