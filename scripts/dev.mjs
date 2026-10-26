import { constants, existsSync, accessSync, readFileSync } from 'node:fs'
import { dirname, delimiter, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { isDeepStrictEqual, parseEnv, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = join(root, 'aixand-server')
const irDir = join(root, 'aixand-ir')
const envFile = join(serverDir, '.env')
const productionEnvFile = join(serverDir, '.env.production')
const suiteGroup = 'aixand-suite'
const usage = `Usage: ./dev.sh serve [--production] [--dry-run]
       ./dev.sh stop [--production] [--dry-run]

Requires an already running Undercurrent daemon. Starts missing Suite services
in detached uc sessions: aixand-carrier, aixand-server, aixand-runner, aixand-web.
New sessions use the fixed server profile, which also sets their role to server.
Managed services join the aixand-suite group and launch with app=aixand-suite.
New sessions register continuous uc health checks; web checks its root page (/).
Healthy services already running outside uc are reused. Running sessions are
never restarted in the same mode; stopped sessions reuse their saved configuration.
Existing sessions must be recreated to change their saved health checks.

--production starts the compiled backend and built frontend together on port 8753
without Vite. Build first with: node scripts/production.mjs build
It gracefully replaces this checkout's managed development backend and removes
its managed Vite session, reusing Carrier and Runner. Unmanaged backends must be
stopped separately. To switch back, stop aixand-server before ./dev.sh serve.
Production reads .env.production over .env. Use stop --production when its runtime
paths differ from development. Healthy production sessions are not rebuilt or restarted.

Services load aixand-server/.env after launch; credentials stay out of uc state.
Exported non-secret configuration takes precedence; put credentials in .env.
Uses the sibling Runner checkout (target/debug/runner, then target/release/runner)
or runner on PATH. Override executables with AIXAND_RUNNER_BIN / AIXAND_CARRIER_BIN.
Runner uses WORKFLOW_SDK_CONFIG and WORKFLOW_CWD (defaults: the prepared real-agent
example and aixand-ir), WORKFLOW_RUNNER_HOME / RUNNER_HOME, and SUITE_WORKFLOW_SOCKET.
AIXAND_WEB_PORT defaults to 5173; AIXAND_SERVE_TIMEOUT defaults to 60 seconds.

--dry-run checks prerequisites and prints planned commands without starting them.
Agent/provider processes, MCP connections and Vox are managed by Suite on demand.
This command does not install dependencies, configure logins, or repair agent state.

stop shuts down Suite services, labelled agent sessions, and local Suite workers,
including the configured local Carrier (also when managed by carrier.service).
It removes their uc session records/logs, preserves application data, and leaves
Undercurrent and unrelated sessions running. Both commands support --dry-run.
`

function fail(message) { throw new Error(message) }
function fileEnv(path) { return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {} }
function absolute(value, base = serverDir) {
  if (value === '~' || value.startsWith('~/')) value = homedir() + value.slice(1)
  return isAbsolute(value) ? value : resolve(base, value)
}
function executable(value) {
  const candidates = value.includes('/') ? [resolve(value)] : (process.env.PATH ?? '').split(delimiter).map(dir => resolve(dir, value))
  return candidates.find(path => {
    try { accessSync(path, constants.X_OK); return true } catch { return false }
  })
}
function port(value, name) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 65535) fail(`${name} must be a port between 1 and 65535.`)
  return number
}
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'` }
function httpHealth(endpoint) {
  return { argument: `http:${endpoint}`, configuration: { kind: 'http_endpoint', endpoint } }
}
function commandHealth(program, args) {
  // uc splits command rules on whitespace without interpreting shell quotes.
  // Encode the argv so configured executable/home paths remain literal, even
  // when they contain spaces. This probe inherits no service dotenv secrets.
  if (/\s/.test(process.execPath)) fail('Undercurrent command health checks require a Node executable path without whitespace.')
  const payload = Buffer.from(JSON.stringify([program, args])).toString('base64')
  const probe = `require('node:child_process').execFileSync(...JSON.parse(Buffer.from('${payload}','base64').toString()),{timeout:1500,stdio:'ignore'})`
  const command = { program: process.execPath, arguments: ['--eval', probe] }
  return { argument: `exit-command:${command.program} ${command.arguments.join(' ')}`, configuration: { kind: 'command', command } }
}
function credentialLike(key, value) {
  // Match Undercurrent's raw-environment boundary. Credential values belong in
  // the service's runtime .env, rather than the persisted uc launch recipe.
  const name = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
  return ['accesstoken', 'apikey', 'authorization', 'clientsecret', 'credential', 'password', 'passwd', 'privatekey', 'secret', 'sessioncookie', 'token'].some(marker => name.includes(marker))
    || /^(bearer |basic |sk-|ghp_|AKIA)/i.test(value.trim()) || /-----BEGIN (RSA )?PRIVATE KEY-----/.test(value)
}
async function uc(args, timeoutSeconds = 5) {
  try {
    return (await execute('uc', ['--timeout', `${timeoutSeconds}s`, ...args], { timeout: (timeoutSeconds + 5) * 1000, maxBuffer: 1024 * 1024 })).stdout
  } catch (error) {
    fail(`uc ${args.slice(0, 2).join(' ')} failed. ${error.stderr?.trim() || 'The command could not complete; check uc daemon status.'}`)
  }
}
async function session(name) {
  const result = JSON.parse(await uc(['--json', 'ls', '--name', name, '--page-size', '1']))
  return result.items.find(row => row.name === name)
}
async function groupServices(services, dryRun) {
  const selected = []
  for (const service of services) {
    const current = dryRun ? service.current : await session(service.name)
    if (current || dryRun && !service.healthy) selected.push({ name: service.name, id: current?.id })
  }
  if (!selected.length) return

  const groups = JSON.parse(await uc(['--json', 'group', 'ls']))
  const existing = groups.find(group => group.name === suiteGroup)
  const group = existing
    ? JSON.parse(await uc(['--json', 'group', 'inspect', suiteGroup]))
    : { members: [] }
  if (group.deleting || group.pending_name)
    fail(`The uc group ${suiteGroup} has a pending operation. Inspect it with: uc group inspect ${suiteGroup}`)
  for (const service of selected) {
    if (group.members.some(member => member.name === service.name && member.session_id !== service.id && member.restorable))
      fail(`The uc group ${suiteGroup} has a saved shell named ${service.name}. Resolve that membership before grouping Suite services.`)
  }
  if (!existing) {
    console.log(`${dryRun ? 'Would create' : 'Creating'} uc group ${suiteGroup}.`)
    if (!dryRun) await uc(['group', 'create', suiteGroup, '--cwd', root])
  }
  for (const service of selected) {
    const stale = group.members.filter(member => member.name === service.name && member.session_id !== service.id)
    for (const member of stale) {
      console.log(`${dryRun ? 'Would remove' : 'Removing'} stale ${service.name} membership from ${suiteGroup}.`)
      if (!dryRun) await uc(['group', 'remove', suiteGroup, member.session_id])
    }
    if (group.members.some(member => member.session_id === service.id)) continue
    console.log(`${dryRun ? 'Would add' : 'Adding'} ${service.name} to uc group ${suiteGroup}.`)
    if (!dryRun) await uc(['group', 'add', suiteGroup, service.name])
  }
  if (!dryRun) console.log(`Open the service group with: uc group attach ${suiteGroup}`)
}
async function httpReady(url, service) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'error' })
    if (!response.ok) { await response.body?.cancel(); return false }
    if (!service) { await response.body?.cancel(); return true }
    const body = await response.json()
    return body.status === 'ok' && body.service === service
  } catch { return false }
}
function runnerReady(socketPath) {
  return new Promise(resolveReady => {
    const socket = connect(socketPath)
    let data = ''
    const finish = value => { socket.destroy(); resolveReady(value) }
    socket.setTimeout(1500, () => finish(false))
    socket.on('error', () => finish(false))
    socket.on('connect', () => socket.write('{"op":"health"}\n'))
    socket.on('data', chunk => {
      data += chunk
      if (data.length > 1024 * 1024) return finish(false)
      if (!data.includes('\n')) return
      try {
        const reply = JSON.parse(data.slice(0, data.indexOf('\n')))
        const health = reply.data
        if (reply.ok === true && health?.service === 'runner'
          && (!health.capabilities?.workflow_graphs?.includes(2)
            || !health.capabilities?.chat_spawn_policy?.includes(1))) {
          finish('outdated')
        } else finish(reply.ok === true && health?.service === 'runner')
      } catch { finish(false) }
    })
    socket.on('end', () => finish(false))
  })
}

async function removeManagedSession(service, dryRun) {
  if (dryRun) {
    console.log(`Would stop and clean ${service.name} before changing its launch configuration.`)
    return
  }
  let current = await session(service.name)
  if (!current) return
  const id = current.id
  if (['running', 'starting'].includes(current.lifecycle.state)) {
    console.log(`Stopping ${service.name} for the mode change…`)
    await uc(['stop', service.name, '--graceful'], 40)
  }
  const deadline = Date.now() + 40_000
  while (current && !['stopped', 'exited', 'failed'].includes(current.lifecycle.state)) {
    if (Date.now() >= deadline) fail(`${service.name} did not stop; its launch configuration was left intact.`)
    await delay(200)
    current = await session(service.name)
  }
  if (current) await uc(['clean', service.name, '--yes'])
  const groups = JSON.parse(await uc(['--json', 'group', 'ls']))
  if (groups.some(group => group.name === suiteGroup)) {
    const group = JSON.parse(await uc(['--json', 'group', 'inspect', suiteGroup]))
    if (group.members.some(member => member.session_id === id && !member.restorable))
      await uc(['group', 'remove', suiteGroup, id])
  }
}

function serverMode(detail, productionUrl) {
  const config = detail.configuration
  const args = config.command?.arguments ?? []
  if (args.includes(join(serverDir, 'dist/production-main.js')) ||
    args.includes('start:prod') || config.labels?.['suite.mode'] === 'production') return 'production'
  if (config.health?.rules?.some(rule => rule.endpoint === `${productionUrl}/api/health`)) return 'production'
  return 'development'
}

async function serve(dryRun, production) {
  if (!executable('uc')) fail('Undercurrent CLI (uc) is missing from PATH. Install it and run: uc daemon start')
  try {
    const status = JSON.parse(await uc(['--json', 'daemon', 'status']))
    if (!status.accepting_connections) throw new Error('not accepting connections')
  } catch {
    fail('Undercurrent is offline or unreachable. Start it with: uc daemon start\nThen rerun: ./dev.sh serve')
  }
  console.log('Undercurrent is online.')
  // Fail before launching anything when the installed CLI cannot create groups headlessly.
  await uc(['group', 'create', '--help'])

  const development = { ...fileEnv(envFile), ...process.env }
  const deployment = { ...fileEnv(envFile), ...fileEnv(productionEnvFile), ...process.env }
  const config = production ? deployment : development
  const stateDir = absolute(config.XDG_STATE_HOME || join(homedir(), '.local/state'))
  const runnerHome = absolute(config.WORKFLOW_RUNNER_HOME || config.RUNNER_HOME || join(stateDir, 'runner'))
  const suiteSocket = absolute(config.SUITE_WORKFLOW_SOCKET || join(absolute(config.AGENTS_STATE_DIR || join(stateDir, 'aixand/chats')), 'native-workflows.sock'))
  const sdkConfig = absolute(config.WORKFLOW_SDK_CONFIG || join(irDir, 'examples/real-agent/runtime.example.json'))
  const workflowCwd = absolute(config.WORKFLOW_CWD || irDir)
  const pythonBin = absolute(config.WORKFLOW_PYTHON_BIN || join(irDir, '.venv/bin'))
  const developmentPort = production ? Number(development.PORT || '3000') : port(development.PORT || '3000', 'PORT')
  const developmentHost = ['0.0.0.0', '::'].includes(development.HOST) ? '127.0.0.1' : (development.HOST || '127.0.0.1')
  const developmentUrl = Number.isInteger(developmentPort) && developmentPort > 0 && developmentPort <= 65535
    ? `http://${developmentHost.includes(':') ? `[${developmentHost}]` : developmentHost}:${developmentPort}` : undefined
  const productionPort = production ? port(deployment.AIXAND_PRODUCTION_PORT || '8753', 'AIXAND_PRODUCTION_PORT') : Number(deployment.AIXAND_PRODUCTION_PORT || '8753')
  const productionHost = deployment.AIXAND_PRODUCTION_HOST || '127.0.0.1'
  if (production && !['127.0.0.1', '::1'].includes(productionHost)) fail('AIXAND_PRODUCTION_HOST must be a loopback address.')
  const productionUrl = Number.isInteger(productionPort) && productionPort > 0 && productionPort <= 65535
    ? `http://${productionHost.includes(':') ? `[${productionHost}]` : productionHost}:${productionPort}` : undefined
  const serverPort = production ? productionPort : developmentPort
  const serverHost = production ? productionHost : developmentHost
  const serverUrl = `http://${serverHost.includes(':') ? `[${serverHost}]` : serverHost}:${serverPort}`
  const webPort = production ? undefined : port(config.AIXAND_WEB_PORT || '5173', 'AIXAND_WEB_PORT')
  const webUrl = production ? serverUrl : `http://127.0.0.1:${webPort}`
  const carrierUrl = new URL(config.CARRIER_URL || 'http://127.0.0.1:8765')
  const carrierDb = absolute(config.CARRIER_DATABASE || join(homedir(), '.aixand/carrier/carrier.db'))
  const runnerBin = config.AIXAND_RUNNER_BIN
    ? executable(config.AIXAND_RUNNER_BIN)
    : [join(root, '../runner/target/debug/runner'), join(root, '../runner/target/release/runner'), 'runner'].map(executable).find(Boolean)
  const carrierBin = executable(config.AIXAND_CARRIER_BIN || 'carrier')
  const npmBin = executable('npm')
  const timeout = Number(config.AIXAND_SERVE_TIMEOUT || 60) * 1000
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 600_000) fail('AIXAND_SERVE_TIMEOUT must be between 1 and 600 seconds.')

  // Undercurrent launches from its daemon environment. Persist only non-secret
  // overrides; launch-service loads the application's .env inside the child.
  const overrides = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(AGENTS?_|AGENT_MANAGER_|UNDERCURRENT_|WORKFLOW_|RUNNER_|SUITE_|CARRIER_|VOX_|AIXAND_|PROMPT_|PROMPTS_|SKILL_|SKILLS_|MCP_|MCPS_|SERVER_MANAGER_|SERVERS_|RESOURCE_|XDG_|TERMINAL_|HF_)/.test(key)))
  for (const [key, value] of Object.entries(overrides)) {
    if (credentialLike(key, value)) fail(`Exported ${key} cannot be persisted as a uc launch variable. Put it in aixand-server/.env so the service can load it after launch.`)
  }
  const shared = { ...overrides, PATH: process.env.PATH ?? '', HOME: homedir(),
    WORKFLOW_RUNNER_HOME: runnerHome, SUITE_WORKFLOW_SOCKET: suiteSocket,
    CARRIER_URL: carrierUrl.href.replace(/\/$/, ''), CARRIER_DATABASE: carrierDb }

  const productionEntry = join(serverDir, 'dist/production-main.js')
  const productionWeb = absolute(config.AIXAND_PRODUCTION_WEB_DIST || join(root, 'aixand-web/dist'))
  const services = [
    { name: 'aixand-carrier', cwd: resolve(root, '../carrier'), command: [carrierBin, 'serve', '--host', carrierUrl.hostname.replace(/^\[|\]$/g, ''), '--port', String(port(carrierUrl.port || 80, 'CARRIER_URL port')), '--db', carrierDb],
      health: httpHealth(new URL('/health', carrierUrl).href),
      ready: () => httpReady(new URL('/health', carrierUrl), 'carrier'),
      preflight() {
        if (!carrierBin) fail('Carrier is unavailable. Install carrier or set AIXAND_CARRIER_BIN.')
        if (carrierUrl.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(carrierUrl.hostname))
          fail('Configured Carrier is unavailable. Start it on its configured host; this launcher only starts loopback HTTP Carrier services.')
      } },
    { name: 'aixand-server', cwd: serverDir,
      command: production ? [process.execPath, productionEntry] : [npmBin, 'run', 'start:dev'],
      env: {
        ...shared, ...(production ? { NODE_ENV: 'production' } : { HOST: config.HOST || '127.0.0.1', PORT: String(serverPort) }),
        WORKFLOW_SDK_CONFIG: sdkConfig, WORKFLOW_CWD: workflowCwd, WORKFLOW_PYTHON_BIN: pythonBin },
      health: httpHealth(`${serverUrl}/api/health`),
      ready: async () => await httpReady(`${serverUrl}/api/health`, 'aixand-server') &&
        (!production || await httpReady(`${serverUrl}/`) && await httpReady(`${serverUrl}/recovery.html`)),
      preflight() {
        if ((!production && !npmBin) || !existsSync(join(serverDir, 'node_modules'))) fail('Prepare aixand-server first: cd aixand-server && npm ci')
        if (production && (!existsSync(productionEntry) || !existsSync(join(serverDir, 'dist/production.js')) || !existsSync(join(productionWeb, 'index.html')) || !existsSync(join(productionWeb, 'recovery.html'))))
          fail('Build production first: node scripts/production.mjs build')
      } },
    { name: 'aixand-runner', cwd: workflowCwd, command: [runnerBin, '--home', runnerHome, 'serve', '--sdk-config', sdkConfig, '--suite-socket', suiteSocket],
      env: { ...shared, PATH: `${pythonBin}${delimiter}${process.env.PATH ?? ''}` },
      health: commandHealth(runnerBin, ['--home', runnerHome, 'health']),
      ready: async () => {
        const result = await runnerReady(join(runnerHome, 'runner.sock'))
        if (result === 'outdated') fail('An existing Runner is missing current Suite workflow capabilities. Rebuild with --features sdk and restart that Runner before rerunning ./dev.sh serve.')
        return result
      },
      preflight() {
        if (!runnerBin) fail('Build Runner first: cd ../runner && cargo build --locked --features sdk (or set AIXAND_RUNNER_BIN).')
        if (!existsSync(sdkConfig)) fail(`Runner SDK configuration is missing: ${sdkConfig}. Set WORKFLOW_SDK_CONFIG in aixand-server/.env.`)
        if (!existsSync(workflowCwd)) fail(`WORKFLOW_CWD does not exist: ${workflowCwd}`)
      } },
    ...(!production ? [{ name: 'aixand-web', cwd: join(root, 'aixand-web'), command: [npmBin, 'run', 'dev', '--', '--port', String(webPort), '--strictPort'],
      env: { ...overrides, PATH: process.env.PATH ?? '', HOME: homedir(), AIXAND_SERVER_URL: serverUrl }, envFile: false,
      health: httpHealth(`${webUrl}/`),
      ready: async () => await httpReady(webUrl) && await httpReady(`${webUrl}/api/health`, 'aixand-server'),
      preflight() { if (!npmBin || !existsSync(join(root, 'aixand-web/node_modules'))) fail('Prepare aixand-web first: cd aixand-web && npm ci') } }] : []),
  ]

  // Check all prerequisites before creating any sessions.
  for (const service of services) {
    service.current = await session(service.name)
    if (service.current) {
      const detail = JSON.parse(await uc(['--json', 'inspect', service.name]))
      if (resolve(detail.configuration.working_directory) !== service.cwd)
        fail(`The uc name ${service.name} belongs to another working directory. Inspect it with: uc inspect ${service.name}`)
      if (service.name === 'aixand-server') {
        const currentMode = serverMode(detail, productionUrl)
        if (!production && currentMode === 'production' && ['running', 'starting', 'stopping'].includes(service.current.lifecycle.state))
          fail('aixand-server is in production mode. Stop it with uc stop aixand-server --graceful before switching to ./dev.sh serve.')
        service.replaceRecipe = currentMode !== (production ? 'production' : 'development') ||
          production && !detail.configuration.health?.rules?.some(rule => isDeepStrictEqual(rule, service.health.configuration))
      }
      if (detail.configuration.profile !== 'server' || detail.configuration.profile_binding !== 'fixed')
        console.warn(`${service.name}: saved uc configuration does not use a fixed server profile. Recreate this session to apply --profile server; reusing or restarting it preserves its saved configuration.`)
      if (!service.replaceRecipe && !detail.configuration.health?.rules?.some(rule => isDeepStrictEqual(rule, service.health.configuration)))
        console.warn(`${service.name}: saved uc configuration is missing the expected health check. Recreate this session to apply --healthy-when; uc restart preserves saved health rules.`)
    }
    service.healthy = await service.ready()
    if ((!service.healthy && !service.current) || service.replaceRecipe) service.preflight()
  }
  const backend = services.find(service => service.name === 'aixand-server')
  if (production && developmentUrl && productionUrl !== developmentUrl && await httpReady(`${developmentUrl}/api/health`, 'aixand-server')) {
    if (!backend.replaceRecipe || !['running', 'starting'].includes(backend.current?.lifecycle.state))
      fail(`An unmanaged development backend is running at ${developmentUrl}. Stop it before starting production against the same workspace.`)
    if (backend.healthy) fail('Both development and production backend addresses are active. Stop the duplicate backend before continuing.')
  }
  if (!production && productionUrl && productionUrl !== developmentUrl && await httpReady(`${productionUrl}/api/health`, 'aixand-server'))
    fail('A production backend is already running. Stop it before starting development against the same workspace.')
  let retiredWeb
  if (production) {
    backend.preflight()
    try {
      await execute(process.execPath, ['--input-type=module', '-e',
        'const p = await import(process.argv[1]); p.loadProductionEnvironment(); p.productionConfiguration();',
        pathToFileURL(join(serverDir, 'dist/production.js')).href], { cwd: serverDir, timeout: 10_000 })
    } catch (error) {
      fail(`Production configuration check failed before changing any service. ${error.stderr?.trim() || error.message}`)
    }
    const current = await session('aixand-web')
    if (current) {
      const detail = JSON.parse(await uc(['--json', 'inspect', 'aixand-web']))
      if (resolve(detail.configuration.working_directory) !== join(root, 'aixand-web'))
        fail('The uc name aixand-web belongs to another working directory; it was left untouched.')
      retiredWeb = { name: 'aixand-web', current }
    }
  }
  // Only after every service and mode conflict has been checked may a cutover stop anything.
  if (retiredWeb) await removeManagedSession(retiredWeb, dryRun)
  if (backend.replaceRecipe) {
    await removeManagedSession(backend, dryRun)
    backend.current = undefined
    backend.healthy = false
  }
  for (const service of services) {
    if (service.healthy || await service.ready()) {
      console.log(`${service.name}: ready (${service.current ? 'existing uc session' : 'existing service'}).`)
      continue
    }
    const state = service.current?.lifecycle.state
    if (state === 'stopping') fail(`${service.name} is stopping. Wait for it to finish, then rerun ./dev.sh serve.`)
    if (state !== 'running' && state !== 'starting') {
      if (service.current) {
        console.log(`${dryRun ? 'Would restart' : 'Restarting'} stopped session ${service.name}.`)
        if (!dryRun) await uc(['restart', service.name])
      } else {
        const args = ['start', service.name, '--profile', 'server', '--cwd', service.cwd, '--stop-timeout', '20s', '--healthy-when', service.health.argument, '--label', 'app=aixand-suite', '--label', `suite.root=${root}`]
        if (service.name === 'aixand-server') args.push('--label', `suite.mode=${production ? 'production' : 'development'}`)
        for (const [key, value] of Object.entries(service.env ?? shared)) args.push('--env', `${key}=${value}`)
        const files = service.envFile === false ? ['-'] : production ? [envFile, productionEnvFile] : [envFile]
        const command = [process.execPath, join(root, 'scripts/launch-service.mjs'), ...files, '--', ...service.command]
        args.push('--', ...command)
        if (dryRun) console.log(`Would start ${service.name}: uc start ${service.name} --profile server --healthy-when ${quote(service.health.argument)} --label app=aixand-suite --label ${quote(`suite.root=${root}`)}${service.name === 'aixand-server' ? ` --label suite.mode=${production ? 'production' : 'development'}` : ''} --cwd ${quote(service.cwd)} -- ${command.map(quote).join(' ')} (configured environment forwarded)`)
        else { console.log(`Starting ${service.name}…`); await uc(args) }
      }
    } else console.log(`${service.name}: waiting for the existing session…`)
    if (dryRun) continue
    const deadline = Date.now() + timeout
    while (!await service.ready()) {
      const current = await session(service.name)
      if (!current || !['running', 'starting'].includes(current.lifecycle.state))
        fail(`${service.name} exited before becoming ready. Inspect: uc logs ${service.name}`)
      if (Date.now() >= deadline)
        fail(`${service.name} did not become ready within ${timeout / 1000}s. Inspect: uc logs ${service.name}\nExisting services were left running.`)
      await delay(500)
    }
    console.log(`${service.name}: ready.`)
  }
  await groupServices(services, dryRun)
  console.log(dryRun ? 'Dry run complete; no services were started.' : `Suite infrastructure is ready: ${webUrl}\nAgent chats and Vox launch their provider processes on demand. Use uc ls / uc logs <name> to inspect services.`)
}

try {
  const args = process.argv.slice(2)
  const flags = args.slice(1)
  const validFlags = flags.every(value => ['--production', '--dry-run'].includes(value)) && new Set(flags).size === flags.length
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) console.log(usage)
  else if (args[0] === 'serve' && validFlags) await serve(flags.includes('--dry-run'), flags.includes('--production'))
  else if (args[0] === 'stop' && validFlags) {
    const { stopSuite } = await import('./stop.mjs')
    await stopSuite({ root, config: { ...fileEnv(envFile), ...(flags.includes('--production') ? fileEnv(productionEnvFile) : {}), ...process.env }, uc, dryRun: flags.includes('--dry-run') })
  }
  else fail(usage)
} catch (error) {
  console.error(`dev.sh: ${error.message}`)
  process.exitCode = 1
}
