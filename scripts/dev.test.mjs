import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as httpServer } from 'node:http'
import { createServer as socketServer } from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const source = dirname(fileURLToPath(import.meta.url))
const names = ['aixand-carrier', 'aixand-server', 'aixand-runner', 'aixand-web']

async function fixture(t, { offline = false, externalCarrier = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'aixand dev '))
  const root = join(temp, 'aixand-suite')
  const stateFile = join(temp, 'state.json')
  const bin = join(temp, 'bin')
  for (const path of ['scripts', 'aixand-server/node_modules', 'aixand-server/dist', 'aixand-web/node_modules', 'aixand-web/dist', 'aixand-ir']) mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(root, 'aixand-server/dist/production-main.js'), '// fixture production entry')
  writeFileSync(join(root, 'aixand-server/dist/production.js'), 'export function loadProductionEnvironment() {}\nexport function productionConfiguration() { if (process.env.TEST_REJECT_PRODUCTION_CONFIG) throw new Error("fixture production config rejected") }\n')
  for (const file of ['index.html', 'recovery.html']) writeFileSync(join(root, 'aixand-web/dist', file), '<html>Aixand</html>')
  mkdirSync(bin)
  mkdirSync(join(temp, 'carrier'))
  copyFileSync(join(source, 'dev.mjs'), join(root, 'scripts/dev.mjs'))
  copyFileSync(join(source, 'launch-service.mjs'), join(root, 'scripts/launch-service.mjs'))
  copyFileSync(join(source, 'stop.mjs'), join(root, 'scripts/stop.mjs'))
  const load = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  const save = state => writeFileSync(stateFile, JSON.stringify(state))
  save({ offline, sessions: {}, actions: [], groups: {}, groupActions: [], nextId: 1, external: externalCarrier ? ['aixand-carrier'] : [] })
  const active = (name) => {
    const state = load()
    return state.external.includes(name) || state.sessions[name]?.lifecycle.state === 'running'
  }
  const servers = []
  async function listen(server, endpoint) {
    servers.push(server)
    await new Promise(resolveReady => server.listen(endpoint, resolveReady))
    return server.address()
  }
  async function http(name, production = false) {
    const address = await listen(httpServer((request, response) => {
      let ready = active(name)
      if (name === 'aixand-server') {
        const state = load()
        const mode = state.sessions[name]?.labels?.['suite.mode'] || 'development'
        ready = production ? ready && mode === 'production' || state.external.includes('aixand-production') : ready && mode !== 'production'
        if (production && state.frontendUnavailable && request.url !== '/api/health') ready = false
      }
      if (name === 'aixand-web' && request.url === '/api/health') ready &&= active('aixand-server')
      response.statusCode = ready ? 200 : 503
      response.end(JSON.stringify({ status: ready ? 'ok' : 'starting', service: name === 'aixand-carrier' ? 'carrier' : 'aixand-server' }))
    }), { host: '127.0.0.1', port: 0 })
    return address.port
  }
  const carrierPort = await http('aixand-carrier')
  const serverPort = await http('aixand-server')
  const productionPort = await http('aixand-server', true)
  const webPort = await http('aixand-web')
  const runnerHome = join(temp, 'runner home')
  mkdirSync(runnerHome)
  await listen(socketServer(socket => socket.on('data', () => socket.end(JSON.stringify({ ok: active('aixand-runner'), data: {
    service: 'runner', capabilities: load().outdatedRunner ? {} : { workflow_graphs: [1, 2], chat_spawn_policy: [1] },
  } }) + '\n'))), join(runnerHome, 'runner.sock'))
  const fakeUc = join(bin, 'uc')
  writeFileSync(fakeUc, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
const stateFile = process.env.TEST_STATE
const state = JSON.parse(readFileSync(stateFile))
const args = process.argv.slice(2)
const output = data => console.log(JSON.stringify(data))
if (args.includes('daemon')) {
  if (state.offline) process.exit(1)
  output({ accepting_connections: true })
} else if (args.includes('group')) {
  const [op, name, member] = args.slice(args.indexOf('group') + 1)
  if (args.includes('--help')) output({})
  else if (op === 'ls') output(Object.values(state.groups).map(group => ({ name: group.name, members: group.members.length })))
  else if (op === 'inspect') {
    if (!state.groups[name]) process.exit(2)
    output(state.groups[name])
  } else {
    if (op === 'create') {
      if (state.groups[name]) process.exit(2)
      state.groups[name] = { name, members: [], deleting: false, pending_name: null }
    } else if (op === 'add') {
      const session = state.sessions[member]
      const id = session?.id || 'existing-' + member
      if (!session || !state.groups[name] || Object.values(state.groups).some(group => group.members.some(saved => saved.session_id === id))) {
        console.error('session already belongs to a group or is unavailable')
        process.exit(2)
      }
      state.groups[name].members.push({ name: member, session_id: id, key: id, restorable: false })
    } else if (op === 'remove') {
      if (!state.groups[name]) process.exit(2)
      state.groups[name].members = state.groups[name].members.filter(saved => saved.session_id !== member)
    } else process.exit(2)
    state.groupActions.push({ op, name, member })
    writeFileSync(stateFile, JSON.stringify(state))
    output({})
  }
} else if (args.includes('ls')) {
  const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : undefined
  const items = Object.values(state.sessions).filter(row => !name || row.name === name).map(row => ({ ...row, id: row.id || 'existing-' + row.name }))
  const offset = args.includes('--cursor') ? Number(args[args.indexOf('--cursor') + 1]) : 0
  const size = state.pageSize || items.length || 1
  output({ items: items.slice(offset, offset + size), next_cursor: offset + size < items.length ? String(offset + size) : null })
} else if (args.includes('inspect')) {
  const name = args[args.indexOf('inspect') + 1]
  const session = state.sessions[name]
  output({ configuration: { working_directory: session.cwd, profile: session.profile, profile_binding: session.profile_binding, health: session.health, labels: session.labels, command: session.command } })
} else if (args.includes('start') || args.includes('restart')) {
  // The real daemon rejects credential-classified entries in --env-file.
  // Reject file loading at the uc boundary; the child must load it instead.
  if (args.slice(0, args.indexOf('--')).includes('--env-file')) {
    console.error('daemon rejected InvalidConfiguration: prepare_launch failed with invalid_data')
    process.exit(2)
  }
  const op = args.includes('start') ? 'start' : 'restart'
  const name = args[args.indexOf(op) + 1]
  const cwd = op === 'start' ? args[args.indexOf('--cwd') + 1] : state.sessions[name].cwd
  const previous = state.sessions[name]
  const profile = op === 'start' ? args[args.indexOf('--profile') + 1] : previous.profile
  const labels = op === 'start' ? Object.fromEntries(args.flatMap((arg, index) => arg === '--label' ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : [])) : previous.labels
  const health = op === 'start' ? { rules: args.flatMap((arg, index) => {
    if (arg !== '--healthy-when') return []
    const rule = args[index + 1]
    if (rule.startsWith('http:')) return [{ kind: 'http_endpoint', endpoint: rule.slice(5) }]
    const [program, ...arguments_] = rule.slice('exit-command:'.length).split(/\\s+/)
    return [{ kind: 'command', command: { program, arguments: arguments_ } }]
  }) } : previous.health
  state.actions.push({ op, name, args })
  state.sessions[name] = { name, cwd, id: op === 'start' ? 'session-' + state.nextId++ : previous.id || 'existing-' + name,
    command: op === 'start' ? { program: args[args.indexOf('--') + 1], arguments: args.slice(args.indexOf('--') + 2) } : previous.command,
    profile, profile_binding: op === 'start' ? 'fixed' : previous.profile_binding, labels, health, lifecycle: { state: 'running' } }
  writeFileSync(stateFile, JSON.stringify(state))
  output({})
} else if (args.includes('stop') || args.includes('clean')) {
  const op = args.includes('stop') ? 'stop' : 'clean'
  const name = args[args.indexOf(op) + 1]
  if (!state.sessions[name]) process.exit(2)
  state.actions.push({ op, name, args })
  if (op === 'stop') state.sessions[name].lifecycle.state = 'stopped'
  else delete state.sessions[name]
  writeFileSync(stateFile, JSON.stringify(state))
  output({})
} else process.exit(2)
`)
  chmodSync(fakeUc, 0o755)
  writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
const path = process.env.TEST_STATE
const state = JSON.parse(readFileSync(path))
const args = process.argv.slice(2)
if (args.includes('show')) console.log(state.systemdCarrier || 0)
else if (args.includes('stop') && state.systemdCarrier) {
  process.kill(state.systemdCarrier, 'SIGTERM')
  state.actions.push({ op: 'systemctl-stop', name: 'carrier.service' })
  state.external = state.external.filter(name => name !== 'aixand-carrier')
  delete state.systemdCarrier
  writeFileSync(path, JSON.stringify(state))
} else process.exit(2)
`)
  chmodSync(join(bin, 'systemctl'), 0o755)
  for (const command of ['carrier', 'runner', 'npm']) {
    writeFileSync(join(bin, command), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, command), 0o755)
  }
  const sdkConfig = join(temp, 'sdk config.json')
  writeFileSync(sdkConfig, '{}')
  const carrierDb = join(temp, 'data with spaces', 'carrier;literal.db')
  writeFileSync(join(root, 'aixand-server/.env'), `CARRIER_API_TOKEN=fixture-private-value\nCARRIER_USER_CREDENTIALS=${join(temp, 'user.json')}\nPORT=${serverPort}\nHOST=127.0.0.1\nCARRIER_URL=http://127.0.0.1:${carrierPort}\nCARRIER_DATABASE=${carrierDb}\nWORKFLOW_RUNNER_HOME=${runnerHome}\nWORKFLOW_SDK_CONFIG=${sdkConfig}\nAIXAND_WEB_PORT=${webPort}\nAIXAND_SERVE_TIMEOUT=1\n`)
  writeFileSync(join(root, 'aixand-server/.env.production'), `AIXAND_PRODUCTION_PORT=${productionPort}\n`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTS?_|AGENT_MANAGER_|UNDERCURRENT_|WORKFLOW_|RUNNER_|SUITE_|CARRIER_|VOX_|AIXAND_|XDG_|PORT$|HOST$)/.test(key)))
  Object.assign(env, { HOME: temp, PATH: `${bin}:${process.env.PATH}`, TEST_STATE: stateFile })
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise(resolveClosed => { server.close(resolveClosed); server.closeAllConnections?.() })))
    rmSync(temp, { recursive: true, force: true })
  })
  const run = async (args = [], extraEnv = {}, command = 'serve') => {
    try {
      const result = await execute(process.execPath, [join(root, 'scripts/dev.mjs'), command, ...args], { env: { ...env, ...extraEnv }, cwd: temp, timeout: 15_000 })
      return { ...result, code: 0 }
    } catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code } }
  }
  const cwd = name => name === 'aixand-runner' ? join(root, 'aixand-ir') : name === 'aixand-carrier' ? join(temp, 'carrier') : join(root, name)
  return { root, temp, env, run, stop: (args = [], extraEnv = {}) => run(args, extraEnv, 'stop'), load, save, cwd, sdkConfig, carrierDb, carrierPort, serverPort, productionPort, webPort, runnerHome }
}

test('offline Undercurrent exits before starting any service', async t => {
  const f = await fixture(t, { offline: true })
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.stderr, /uc daemon start/)
  assert.deepEqual(f.load().actions, [])
})

test('production starts the compiled combined server without Vite and is idempotent', async t => {
  const f = await fixture(t)
  const result = await f.run(['--production'])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(f.load().actions.map(action => action.name), names.slice(0, 3))
  assert.deepEqual(f.load().groups['aixand-suite'].members.map(member => member.name), names.slice(0, 3))
  const backend = f.load().sessions['aixand-server']
  assert.equal(backend.labels['suite.mode'], 'production')
  assert.equal(backend.command.arguments.at(-1), join(f.root, 'aixand-server/dist/production-main.js'))
  assert.ok(backend.command.arguments.includes(join(f.root, 'aixand-server/.env.production')))
  assert.deepEqual(backend.health.rules, [{ kind: 'http_endpoint', endpoint: `http://127.0.0.1:${f.productionPort}/api/health` }])
  const start = f.load().actions.find(action => action.name === 'aixand-server')
  assert.ok(start.args.includes('NODE_ENV=production'))
  assert.equal(JSON.stringify(f.load()).includes('fixture-private-value'), false)
  assert.ok(result.stdout.includes(`http://127.0.0.1:${f.productionPort}`))
  const before = f.load()
  assert.equal((await f.run(['--production'])).code, 0)
  assert.deepEqual(f.load(), before)
})

test('production switches managed development sessions without replacing Runner or Carrier', async t => {
  const f = await fixture(t)
  assert.equal((await f.run()).code, 0)
  const before = f.load()
  const result = await f.run(['--production'])
  assert.equal(result.code, 0, result.stderr)
  const after = f.load()
  assert.deepEqual(after.actions.slice(before.actions.length).map(action => [action.op, action.name]), [
    ['stop', 'aixand-web'], ['clean', 'aixand-web'], ['stop', 'aixand-server'], ['clean', 'aixand-server'], ['start', 'aixand-server'],
  ])
  assert.equal(after.sessions['aixand-runner'].id, before.sessions['aixand-runner'].id)
  assert.equal(after.sessions['aixand-carrier'].id, before.sessions['aixand-carrier'].id)
  assert.equal(after.sessions['aixand-web'], undefined)
  assert.deepEqual(after.groups['aixand-suite'].members.map(member => member.name).sort(), names.slice(0, 3).sort())
})

test('production recreates a stopped development recipe instead of restarting its watcher', async t => {
  const f = await fixture(t)
  const state = f.load()
  state.sessions['aixand-server'] = { name: 'aixand-server', cwd: f.cwd('aixand-server'), lifecycle: { state: 'stopped' } }
  f.save(state)
  const result = await f.run(['--production'])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(f.load().actions.filter(action => action.name === 'aixand-server').map(action => action.op), ['clean', 'start'])
})

test('development does not silently replace active production, but can replace its stopped recipe', async t => {
  const f = await fixture(t)
  assert.equal((await f.run(['--production'])).code, 0)
  const before = f.load()
  const blocked = await f.run()
  assert.equal(blocked.code, 1)
  assert.match(blocked.stderr, /production mode/)
  assert.deepEqual(f.load(), before)
  const stopped = f.load()
  stopped.sessions['aixand-server'].lifecycle.state = 'stopped'
  f.save(stopped)
  const result = await f.run()
  assert.equal(result.code, 0, result.stderr)
  assert.equal(f.load().sessions['aixand-server'].labels['suite.mode'], 'development')
  assert.ok(f.load().sessions['aixand-web'])
})

test('production cutover dry run does not stop sessions or change their recipes', async t => {
  const f = await fixture(t)
  assert.equal((await f.run()).code, 0)
  const before = f.load()
  const result = await f.run(['--dry-run', '--production'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Would stop and clean aixand-server/)
  assert.match(result.stdout, /Would stop and clean aixand-web/)
  assert.match(result.stdout, /production-main\.js/)
  assert.deepEqual(f.load(), before)
})

test('missing production build fails before stopping existing development sessions', async t => {
  const f = await fixture(t)
  assert.equal((await f.run()).code, 0)
  const before = f.load()
  rmSync(join(f.root, 'aixand-web/dist/recovery.html'))
  const result = await f.run(['--production'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Build production first/)
  assert.deepEqual(f.load(), before)
})

test('invalid production configuration is rejected before changing any service', async t => {
  const f = await fixture(t)
  assert.equal((await f.run()).code, 0)
  const before = f.load()
  const result = await f.run(['--production'], { TEST_REJECT_PRODUCTION_CONFIG: '1' })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /configuration check failed before changing any service/)
  assert.deepEqual(f.load(), before)
})

test('production refuses an unmanaged development backend without starting a duplicate', async t => {
  const f = await fixture(t)
  const state = f.load()
  state.external.push('aixand-server')
  f.save(state)
  const result = await f.run(['--production'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /unmanaged development backend/)
  assert.deepEqual(f.load().actions, [])
})

test('production does not stop another checkout occupying the Vite session name', async t => {
  const f = await fixture(t)
  const state = f.load()
  state.sessions['aixand-web'] = { name: 'aixand-web', cwd: f.temp, lifecycle: { state: 'running' } }
  f.save(state)
  const result = await f.run(['--production'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /aixand-web belongs to another working directory/)
  assert.deepEqual(f.load().actions, [])
})

test('production readiness requires its frontend as well as API health', async t => {
  const f = await fixture(t)
  assert.equal((await f.run(['--production'])).code, 0)
  const state = f.load()
  state.frontendUnavailable = true
  f.save(state)
  const result = await f.run(['--production'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /did not become ready/)
  assert.deepEqual(f.load(), state)
})

test('stop supports production sessions and production dotenv settings', async t => {
  const f = await fixture(t)
  assert.equal((await f.run(['--production'])).code, 0)
  const result = await f.stop(['--production'])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(f.load().sessions, {})
})

test('production dotenv overrides base configuration inside the child without leaking into uc', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.root, 'aixand-server/.env.production'), `AIXAND_PRODUCTION_PORT=${f.productionPort}\nCARRIER_API_TOKEN=production-private-value\n`)
  const result = await f.run(['--production'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.stringify(f.load()).includes('production-private-value'), false)
  const script = `if (process.env.CARRIER_API_TOKEN !== 'production-private-value' || process.env.PORT !== '43210') process.exit(1); process.exit(37)`
  await assert.rejects(execute(process.execPath, [join(f.root, 'scripts/launch-service.mjs'), join(f.root, 'aixand-server/.env'), join(f.root, 'aixand-server/.env.production'), '--', process.execPath, '-e', script], {
    env: { ...f.env, PORT: '43210' },
  }), error => error.code === 37)
})

test('starts the four services with shared paths, and rerunning is idempotent', async t => {
  const f = await fixture(t)
  const result = await f.run()
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(f.load().actions.map(action => action.name), names)
  assert.deepEqual(f.load().groups['aixand-suite'].members.map(member => member.name), names)
  for (const session of Object.values(f.load().sessions)) {
    assert.equal(session.profile, 'server')
    assert.equal(session.labels.app, 'aixand-suite')
    assert.equal(session.health.rules.length, 1)
  }
  const health = name => f.load().sessions[name].health.rules[0]
  assert.deepEqual(health('aixand-carrier'), { kind: 'http_endpoint', endpoint: `http://127.0.0.1:${f.carrierPort}/health` })
  assert.deepEqual(health('aixand-server'), { kind: 'http_endpoint', endpoint: `http://127.0.0.1:${f.serverPort}/api/health` })
  assert.deepEqual(health('aixand-web'), { kind: 'http_endpoint', endpoint: `http://127.0.0.1:${f.webPort}/` })
  assert.equal(health('aixand-runner').kind, 'command')
  const runner = f.load().actions.find(action => action.name === 'aixand-runner')
  assert.equal(runner.args[runner.args.indexOf('--sdk-config') + 1], f.sdkConfig)
  assert.equal(runner.args[runner.args.indexOf('--cwd') + 1], f.cwd('aixand-runner'))
  assert.ok(runner.args.includes(`CARRIER_DATABASE=${f.carrierDb}`))
  assert.ok(runner.args.includes('--suite-socket'))
  assert.ok(runner.args.includes(join(f.root, 'scripts/launch-service.mjs')))
  assert.equal(JSON.stringify(f.load().actions).includes('fixture-private-value'), false)
  const rerun = await f.run()
  assert.equal(rerun.code, 0, rerun.stderr)
  assert.doesNotMatch(rerun.stderr, /missing the expected health check/)
  assert.equal(f.load().actions.length, 4)
  assert.equal(f.load().groupActions.length, 5)
})

test('Runner command health check preserves paths with spaces and fails when the command fails', async t => {
  const f = await fixture(t)
  assert.equal((await f.run()).code, 0)
  const start = f.load().actions.find(action => action.name === 'aixand-runner')
  const rule = start.args[start.args.indexOf('--healthy-when') + 1]
  assert.ok(rule.startsWith('exit-command:'))
  // Match the real uc parser: it splits whitespace and does not parse quotes.
  const [program, ...args] = rule.slice('exit-command:'.length).split(/\s+/)
  const runner = join(f.temp, 'bin/runner')
  writeFileSync(runner, '#!/usr/bin/env node\n' +
    `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(['--home', f.runnerHome, 'health']))}) process.exit(23)\n`)
  await execute(program, args, { env: f.env, timeout: 3000 })
  writeFileSync(runner, '#!/bin/sh\nexit 7\n')
  await assert.rejects(execute(program, args, { env: f.env, timeout: 3000 }), error => error.code !== 0)
})

test('existing sessions with old health rules are reported without restarting them', async t => {
  const f = await fixture(t)
  assert.equal((await f.run()).code, 0)
  const state = f.load()
  state.sessions['aixand-server'].health = { rules: [] }
  state.sessions['aixand-web'].health.rules[0].endpoint = 'http://127.0.0.1:1/'
  f.save(state)
  const result = await f.run()
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stderr, /aixand-server:.*missing the expected health check/)
  assert.match(result.stderr, /aixand-web:.*missing the expected health check/)
  assert.match(result.stderr, /uc restart preserves saved health rules/)
  assert.deepEqual(f.load(), state)
})

test('reuses Carrier managed outside uc and honors exported configuration', async t => {
  const f = await fixture(t, { externalCarrier: true })
  const result = await f.run([], { SUITE_WORKFLOW_SOCKET: join(f.temp, 'custom effects.sock') })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(f.load().actions.map(action => action.name), names.slice(1))
  assert.deepEqual(f.load().groups['aixand-suite'].members.map(member => member.name), names.slice(1))
  const runner = f.load().actions.find(action => action.name === 'aixand-runner')
  assert.equal(runner.args[runner.args.indexOf('--suite-socket') + 1], join(f.temp, 'custom effects.sock'))
})

test('dry run leaves sessions unchanged', async t => {
  const f = await fixture(t)
  const result = await f.run(['--dry-run'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Would start aixand-runner/)
  assert.match(result.stdout, /--healthy-when/)
  assert.ok(result.stdout.includes(`http:http://127.0.0.1:${f.webPort}/`))
  assert.match(result.stdout, /--label app=aixand-suite/)
  assert.match(result.stdout, /Would create uc group aixand-suite/)
  for (const name of names) assert.ok(result.stdout.includes(`Would add ${name} to uc group aixand-suite`))
  assert.deepEqual(f.load().actions, [])
  assert.deepEqual(f.load().groupActions, [])
  assert.deepEqual(f.load().groups, {})
})

test('recreated service sessions replace stale group membership and preserve unrelated members', async t => {
  const f = await fixture(t)
  assert.equal((await f.run()).code, 0)
  const state = f.load()
  state.groups['aixand-suite'].members.push({ name: 'other-service', session_id: 'other-session', restorable: false })
  state.sessions = {}
  f.save(state)
  const result = await f.run()
  assert.equal(result.code, 0, result.stderr)
  const members = f.load().groups['aixand-suite'].members
  assert.deepEqual(members.map(member => member.name).sort(), [...names, 'other-service'].sort())
  for (const name of names) assert.equal(members.find(member => member.name === name).session_id, f.load().sessions[name].id)
})

test('grouping does not move a service out of another group', async t => {
  const f = await fixture(t)
  assert.equal((await f.run()).code, 0)
  const state = f.load()
  const member = state.groups['aixand-suite'].members.shift()
  state.groups.other = { name: 'other', members: [member] }
  f.save(state)
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.stderr, /uc group add failed/)
  assert.deepEqual(f.load().groups.other.members, [member])
})

test('missing Runner prevents partial startup', async t => {
  const f = await fixture(t)
  const result = await f.run([], { AIXAND_RUNNER_BIN: join(f.temp, 'missing-runner') })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /cargo build --locked --features sdk/)
  assert.deepEqual(f.load().actions, [])
})

test('restarts a stopped session using its saved recipe', async t => {
  const f = await fixture(t)
  const state = f.load()
  state.sessions['aixand-server'] = { name: 'aixand-server', cwd: f.cwd('aixand-server'), lifecycle: { state: 'stopped' } }
  f.save(state)
  const result = await f.run()
  assert.equal(result.code, 0, result.stderr)
  assert.equal(f.load().actions.find(action => action.name === 'aixand-server').op, 'restart')
})

test('a conflicting uc session is left untouched', async t => {
  const f = await fixture(t)
  const state = f.load()
  state.external = ['aixand-carrier']
  state.sessions['aixand-server'] = { name: 'aixand-server', cwd: f.temp, lifecycle: { state: 'failed' } }
  f.save(state)
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.stderr, /another working directory/)
  assert.deepEqual(f.load().actions, [])
})

test('an unhealthy running session times out without restarting it', async t => {
  const f = await fixture(t, { externalCarrier: true })
  const state = f.load()
  state.sessions['aixand-server'] = { name: 'aixand-server', cwd: f.cwd('aixand-server'), lifecycle: { state: 'starting' } }
  f.save(state)
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.stderr, /uc logs aixand-server/)
  assert.deepEqual(f.load().actions, [])
})

test('an outdated external Runner is reported without starting a duplicate', async t => {
  const f = await fixture(t)
  const state = f.load()
  state.external.push('aixand-runner')
  state.outdatedRunner = true
  f.save(state)
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.stderr, /existing Runner is missing current Suite workflow capabilities/)
  assert.deepEqual(f.load().actions, [])
})

test('service loader reads private dotenv at runtime and preserves exported overrides and exit status', async t => {
  const f = await fixture(t)
  const script = `if (process.env.CARRIER_API_TOKEN !== 'fixture-private-value' || process.env.PORT !== '43210') process.exit(1); process.exit(37)`
  await assert.rejects(execute(process.execPath, [join(f.root, 'scripts/launch-service.mjs'), join(f.root, 'aixand-server/.env'), '--', process.execPath, '-e', script], {
    env: { ...f.env, PORT: '43210' },
  }), error => error.code === 37)
})

test('exported credential overrides are rejected before reaching uc launch state', async t => {
  const f = await fixture(t)
  const result = await f.run([], { CARRIER_API_TOKEN: 'exported-private-value' })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Put it in aixand-server\/.env/)
  assert.equal(result.stderr.includes('exported-private-value'), false)
  assert.deepEqual(f.load().actions, [])
})

test('stop handles paginated Suite services and agent sessions, cleans them, and preserves unrelated sessions and data', async t => {
  const f = await fixture(t)
  assert.equal((await f.run()).code, 0)
  const state = f.load()
  state.actions = []
  state.pageSize = 1
  state.sessions['suite-agent'] = { name: 'suite-agent', cwd: f.temp, lifecycle: { state: 'running' }, labels: { app: 'aixand-suite' } }
  state.sessions['suite-finished'] = { name: 'suite-finished', cwd: f.temp, lifecycle: { state: 'exited' }, labels: { app: 'aixand-suite' } }
  state.sessions['my-terminal'] = { name: 'my-terminal', cwd: f.temp, lifecycle: { state: 'running' } }
  state.sessions['other-suite'] = { name: 'other-suite', cwd: f.temp, lifecycle: { state: 'running' }, labels: { app: 'aixand-suite', 'suite.root': '/another/checkout' } }
  f.save(state)
  const result = await f.stop()
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(Object.keys(f.load().sessions).sort(), ['my-terminal', 'other-suite'])
  assert.deepEqual(f.load().actions.filter(action => action.op === 'stop').map(action => action.name), ['aixand-web', 'aixand-runner', 'aixand-server', 'suite-agent', 'aixand-carrier'])
  assert.equal(f.load().actions.filter(action => action.op === 'clean').length, 6)
  assert.ok(readFileSync(join(f.root, 'aixand-server/.env'), 'utf8').includes('fixture-private-value'))
  assert.match(result.stdout, /Undercurrent is still running/)
  const actionCount = f.load().actions.length
  assert.equal((await f.stop()).code, 0)
  assert.equal(f.load().actions.length, actionCount)
})

test('stop dry run leaves all processes and session records alone', async t => {
  const f = await fixture(t)
  await f.run()
  const before = f.load()
  const result = await f.stop(['--dry-run'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /Would stop and clean aixand-server/)
  assert.deepEqual(f.load(), before)
})

test('stop refuses a conflicting service name before stopping anything', async t => {
  const f = await fixture(t)
  const state = f.load()
  state.sessions['aixand-server'] = { name: 'aixand-server', cwd: f.temp, lifecycle: { state: 'running' } }
  f.save(state)
  const result = await f.stop()
  assert.equal(result.code, 1)
  assert.match(result.stderr, /another working directory/)
  assert.deepEqual(f.load().actions, [])
})

test('stop shuts down the configured systemd Carrier while preserving a Carrier with another database', async t => {
  const f = await fixture(t, { externalCarrier: true })
  const carrierScript = join(f.temp, 'bin/carrier')
  writeFileSync(carrierScript, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n')
  const carrier = spawn(process.execPath, [carrierScript, 'serve', '--db', f.carrierDb, '--port', String(f.carrierPort)], { cwd: f.temp, stdio: 'ignore' })
  const other = spawn(process.execPath, [carrierScript, 'serve', '--db', join(f.temp, 'another.db'), '--port', String(f.carrierPort)], { cwd: f.temp, stdio: 'ignore' })
  t.after(() => { if (carrier.exitCode === null && carrier.signalCode === null) carrier.kill('SIGKILL'); if (other.exitCode === null && other.signalCode === null) other.kill('SIGKILL') })
  await new Promise(resolveReady => setTimeout(resolveReady, 100))
  const state = f.load()
  state.systemdCarrier = carrier.pid
  f.save(state)
  const result = await f.stop()
  assert.equal(result.code, 0, result.stderr)
  assert.ok(f.load().actions.some(action => action.op === 'systemctl-stop'))
  assert.ok(carrier.signalCode)
  assert.equal(other.signalCode, null)
})

test('stop removes detached Suite supervisors and preserves unrelated Python processes', async t => {
  const f = await fixture(t)
  const args = ['-c', 'import time; time.sleep(120)', '-m', 'agent_manager.supervisor', 'codex']
  const worker = spawn('python3', args, { cwd: f.cwd('aixand-server'), stdio: 'ignore' })
  const other = spawn('python3', args, { cwd: f.temp, stdio: 'ignore' })
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); if (other.exitCode === null && other.signalCode === null) other.kill('SIGKILL') })
  await new Promise(resolveReady => setTimeout(resolveReady, 100))
  const result = await f.stop()
  assert.equal(result.code, 0, result.stderr)
  assert.ok(worker.signalCode)
  assert.equal(other.signalCode, null)
})
