import { withActivationAccess } from './activation.mjs'
import { execFile } from 'node:child_process'
import { promisify, parseEnv } from 'node:util'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve, isAbsolute, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { bundledTools } from './setup.mjs'
import { productLocation, productStatus, productCommands, installedProductTools, installProducts, removePrivateProducts, validateInstalledProducts, sharedProductPrefix } from './products.mjs'
import { cleanupPlan, applyCleanup, stopCleanupProcesses, repairCleanupPermissions, restoreCleanupProvider } from './cleanup.mjs'
import { discoverInstallation, readInstallationPlan, saveInstallationPlan, standardManagers, userEnvironment, ownsSession } from './installation-plan.mjs'
import { packageModel } from './package-model.mjs'
import { resolveComponentSelection } from './component-updates.mjs'

import { windows, binary, pythonPath, nodePath, pythonSite, toolStore, cliDirectory, inside, localConnection, replaceProcess } from './platform.mjs'

const execute = promisify(execFile)
export const runtimeRoot = dirname(fileURLToPath(import.meta.url))
const serviceNames = ['aixand-local-carrier', 'aixand-local-runner', 'aixand-local-server']
const usage = 'Usage: aixand-runtime start|status|stop|doctor|prepare-voice|uninstall-products|cleanup plan|apply|stop-processes|repair-permissions [JSON]|exec COMMAND [ARGS...]|setup info|discover|choose|products|check|install [JSON]'

export function configuration(root = runtimeRoot, input = process.env) {
  const model = packageModel(root)
  const manifestPath = join(root, 'manifest.json')
  const voice = existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, 'utf8')).features?.voice === true
  if (windows) {
    const normalized = Object.fromEntries(Object.entries(input).map(([key, value]) => [key.toUpperCase(), value]))
    normalized.SystemRoot = normalized.SYSTEMROOT
    normalized.npm_config_prefix = normalized.NPM_CONFIG_PREFIX
    input = normalized
  }
  const home = resolve(input.HOME || input.USERPROFILE || homedir())
  const base = input.AIXAND_LOCAL_HOME || (windows ? join(input.LOCALAPPDATA || join(home, 'AppData/Local'), 'Aixand/local') : join(input.XDG_DATA_HOME || join(home, '.local/share'), 'aixand/local'))
  if (!isAbsolute(base)) throw new Error('AIXAND_LOCAL_HOME must be an absolute path.')
  const plan = readInstallationPlan(base)
  const port = Number(input.AIXAND_LOCAL_PORT || 8753)
  const carrierPort = Number(input.AIXAND_LOCAL_CARRIER_PORT || 8765)
  for (const value of [port, carrierPort])
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error('Local ports must be integers between 1024 and 65535.')
  if (port === carrierPort) throw new Error('Suite and Carrier need different local ports.')
  const env = Object.fromEntries(Object.entries(input).filter(([key]) =>
    ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC', 'PATHEXT'].includes(key)))
  if (env.NODE_EXTRA_CA_CERTS && !isAbsolute(env.NODE_EXTRA_CA_CERTS)) throw new Error('NODE_EXTRA_CA_CERTS must name an absolute certificate file.')
  // Finder launches need not export a username. Providers such as Claude use
  // it to select their macOS Keychain account even when HOME is correct.
  if (process.platform === 'darwin' && (!env.USER || !env.LOGNAME)) {
    const username = userInfo().username
    env.USER ||= username
    env.LOGNAME ||= username
  }
  Object.assign(env, {
    HOME: home, NODE_ENV: 'production', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', AIXAND_PACKAGED_RUNTIME: '1', AIXAND_VOICE_ENABLED: voice ? '1' : '0', AIXAND_PROVIDER_BUNDLE_ROOT: root,
    PATH: [join(base, 'tools/node/bin'), join(base, 'tools/bin'), join(root, 'bin'), join(root, 'node/bin'), join(root, 'python/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
    npm_config_prefix: join(base, 'tools/node'), npm_config_cache: join(base, 'cache/npm'),
    UV_TOOL_DIR: join(base, 'tools/uv'), UV_TOOL_BIN_DIR: join(base, 'tools/bin'), UV_CACHE_DIR: join(base, 'cache/uv'),
    UV_PYTHON_INSTALL_DIR: join(base, 'tools/python'),
    AIXAND_LOCAL_HOME: base, AIXAND_LOCAL_PORT: String(port), AIXAND_LOCAL_CARRIER_PORT: String(carrierPort),
    XDG_CONFIG_HOME: join(base, 'config'), XDG_DATA_HOME: join(base, 'data'),
    XDG_STATE_HOME: join(base, 'state'), XDG_CACHE_HOME: join(base, 'cache'),
    UNDERCURRENT_HOME: join(base, 'uc'), UNDERCURRENT_PYTHON_BRIDGE: join(root, 'bin', binary('uc-python-bridge')),
    AGENT_MANAGER_HOME: join(base, 'agents'), AGENT_MANAGER_CONFIG: join(base, 'config/providers.toml'),
    PROMPT_MANAGER_HOME: join(base, 'prompts'), SKILL_MANAGER_HOME: join(base, 'skills'),
    MCP_MANAGER_HOME: join(base, 'mcps'), SERVER_MANAGER_HOME: join(base, 'servers'),
    CONVERSATION_MANAGER_HOME: join(base, 'conversations'), CONVERSATION_MANAGER_CONFIG: join(base, 'config/conversation.toml'),
    ORCHESTRATION_HOME: join(base, 'state/orchestration'),
    AGENTS_STATE_DIR: join(base, 'chats'), AGENTS_SCRATCH_DIR: join(base, 'scratch'),
    AGENTS_CWD: home, TERMINAL_CWD: home, TERMINAL_SHELL: windows ? join(input.SystemRoot || input.SYSTEMROOT || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : '/bin/bash',
    AGENTS_PYTHON: pythonPath(join(root, 'python')), CARRIER_PYTHON: pythonPath(join(root, 'python')),
    VOX_PYTHON: pythonPath(join(root, 'voice/python')),
    TERMINAL_BRIDGE_PATH: join(root, 'bin', binary('aixand-terminal-bridge')),
    WORKFLOW_BRIDGE_PATH: join(root, 'bin', binary('aixand-workflow-bridge')),
    WORKFLOW_RUNNER_HOME: join(base, 'runner'), RUNNER_HOME: join(base, 'runner'),
    WORKFLOW_PYTHON_BIN: join(root, 'python/bin'), WORKFLOW_CWD: home,
    WORKFLOW_SDK_CONFIG: join(base, 'config/workflow-runtime.json'),
    SUITE_WORKFLOW_SOCKET: join(base, 'workflows.sock'),
    CARRIER_URL: `http://127.0.0.1:${carrierPort}`, CARRIER_DATABASE: join(base, 'carrier/carrier.db'),
    CARRIER_STATE_DIR: join(base, 'carrier'),
    AIXAND_AUTH_DATABASE: join(base, 'auth/auth.db'),
    AIXAND_PRODUCTION_HOST: '127.0.0.1', AIXAND_PRODUCTION_PORT: String(port),
    AIXAND_PRODUCTION_TRANSPORT: 'loopback', AIXAND_PRODUCTION_TRUST_PROXY: '',
    AIXAND_PRODUCTION_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
    AIXAND_PRODUCTION_WEB_DIST: join(root, 'web'),
    AIXAND_PRODUCTION_MODE: model.headless ? 'headless' : 'web',
    VOX_STATE_DIR: join(base, 'vox'), VOX_WAKE_MODEL_DIR: join(base, 'cache/vox/wake'), HF_HOME: join(base, 'cache/huggingface'),
  })
  if (windows) {
    // Native provider installers use this standard Windows platform marker.
    env.OS = 'Windows_NT'
    env.USERPROFILE = home; env.HOME = home
    env.PATH = [join(base, 'tools/node'), join(base, 'tools/bin'), join(root, 'bin'), join(root, 'node'), join(root, 'python'), join(root, 'git/cmd'), join(input.SystemRoot || 'C:/Windows', 'System32'), input.SystemRoot || 'C:/Windows'].join(delimiter)
    env.WORKFLOW_PYTHON_BIN = join(root, 'python')
    env.npm_config_prefix = join(base, 'tools/node')
    env.TEMP = join(base, 'cache/tmp')
    env.TMP = env.TEMP
  }
  if (existsSync(join(base, 'config/setup.json'))) throw new Error('Unsupported saved tool selection. Use a current installation plan; no data has been changed.')
  let selection = { configured: false, mode: 'bundled', reuseConfig: false }
  const productInput = { ...input, HOME: home, AIXAND_SHARED_PRODUCT_PREFIX: sharedProductPrefix({ ...input, HOME: home }) }
  const products = productLocation(root, productInput, base)
  // Provider CLI software survives workspace reset and desktop-only removal.
  // SDKs and managed account homes remain private to this workspace.
  if (products?.scope === 'shared') {
    const providerStore = join(products.prefix, '..', 'providers')
    const npmPrefix = join(providerStore, 'packages/npm')
    Object.assign(env, {
      AIXAND_PROVIDER_STORE: providerStore,
      AIXAND_PROVIDER_NODE_SOURCE: join(root, 'node'),
      AIXAND_PROVIDER_LAUNCHER_SOURCE: join(root, 'bin', binary('aixand-command')),
      AIXAND_PROVIDER_COMMAND_POLICY_FILE: join(base, 'config/product-installation.json'),
      AIXAND_PROVIDER_USER_PATH: userEnvironment(input).PATH || input.PATH || '',
      AIXAND_PROVIDER_USER_SHELL: input.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
      AIXAND_PROVIDER_USER_CONFIG_HOME: input.XDG_CONFIG_HOME || join(home, '.config'),
      npm_config_prefix: npmPrefix,
      PATH: [windows ? npmPrefix : join(npmPrefix, 'bin'),
        windows ? join(providerStore, 'node') : join(providerStore, 'node/bin'), env.PATH].join(delimiter),
    })
  }
  const managedTools = products && installedProductTools(root, productInput, base)
  if (products) selection = { ...selection, mode: products.mode, reuseConfig: products.mode === 'system' && selection.reuseConfig,
    configured: Boolean(managedTools), bootstrapping: !managedTools }
  const tools = managedTools || bundledTools(root)
  if (managedTools) env.PATH = [tools.binDirectory, env.PATH].join(delimiter)
  if (products) {
    // Manager and Suite SDK API copies belong to the application environment.
    // Ordinary product commands use the independent per-product environments.
    env.UNDERCURRENT_PYTHON_BRIDGE = tools.bridge
    env.AIXAND_PRODUCT_RUNTIME = root
    env.AIXAND_SHARED_PRODUCT_PREFIX = productInput.AIXAND_SHARED_PRODUCT_PREFIX
    if (input.AIXAND_SKIP_PATH_REGISTRATION === '1') env.AIXAND_SKIP_PATH_REGISTRATION = '1'
    if (selection.reuseConfig) {
      for (const key of ['AGENT_MANAGER_HOME', 'AGENT_MANAGER_CONFIG', 'PROMPT_MANAGER_HOME', 'SKILL_MANAGER_HOME', 'MCP_MANAGER_HOME', 'SERVER_MANAGER_HOME'])
        delete env[key]
      Object.assign(env, selection.managerEnvironment || {})
    }
  }
  if (plan) {
    Object.assign(env, plan.managers, plan.userDirectories || {})
    if (plan.mode === 'shared') {
      const defaults = standardManagers(userEnvironment(input))
      for (const key of ['CONVERSATION_MANAGER_HOME', 'CONVERSATION_MANAGER_CONFIG', 'ORCHESTRATION_HOME']) env[key] = plan.managers[key] || defaults[key]
      if (plan.managerRoot) env.AIXAND_MANAGER_ROOT = plan.managerRoot
      env.PATH = [...new Set([...env.PATH.split(delimiter), ...(plan.userPath || '').split(delimiter).filter(isAbsolute)])].join(delimiter)
      env.AIXAND_PROVIDER_USER_PATH = plan.userPath || ''
    }
    if (plan.undercurrent.program) {
      tools.uc = plan.undercurrent.program
      if (tools.commands) tools.commands.uc = tools.uc
    }
    env.UNDERCURRENT_HOME = plan.undercurrent.home
    env.AIXAND_SUITE_INSTANCE_ID = plan.instanceId
    env.AGENT_MANAGER_LABELS = JSON.stringify({ 'suite.instance': plan.instanceId })
  }
  if (plan?.mode === 'shared') {
    const defaults = standardManagers({ ...userEnvironment(input), AGENT_MANAGER_CONFIG: undefined })
    // An absent default preferences file means bundled provider defaults. An
    // explicitly selected custom path remains required by Agent Manager.
    if (!userEnvironment(input).AGENT_MANAGER_CONFIG && env.AGENT_MANAGER_CONFIG === defaults.AGENT_MANAGER_CONFIG && !existsSync(env.AGENT_MANAGER_CONFIG))
      delete env.AGENT_MANAGER_CONFIG
  }
  env.AIXAND_SETUP_USER_ENV = JSON.stringify(userEnvironment(input))
  if (process.platform === 'darwin') env.DYLD_LIBRARY_PATH = join(root, 'python/lib')
  env.WORKFLOW_PYTHON_HOME = tools.pythonHome
  const identity = createHash('sha256').update(JSON.stringify({ mode: selection.mode, tools,
    reuseConfig: selection.reuseConfig, managerEnvironment: selection.managerEnvironment || {}, plan })).digest('hex')
  if (model.headless) {
    // Only deployment settings have an explicit packaged-server override. Other
    // ambient development paths and provider secrets remain excluded above.
    for (const key of ['AIXAND_PRODUCTION_ORIGINS', 'AIXAND_PRODUCTION_TRANSPORT', 'AIXAND_PRODUCTION_TRUST_PROXY'])
      if (input[key]) env[key] = input[key]
  }
  const components = resolveComponentSelection(root, base, { verifyPayloads: true })
  const selectedServer = components.paths.server
  if (selectedServer) Object.assign(env, {
    AGENTS_PYTHON: pythonPath(join(selectedServer, 'python')),
    CARRIER_PYTHON: pythonPath(join(selectedServer, 'python')),
    TERMINAL_BRIDGE_PATH: join(selectedServer, 'bin', binary('aixand-terminal-bridge')),
    WORKFLOW_BRIDGE_PATH: join(selectedServer, 'bin', binary('aixand-workflow-bridge')),
    WORKFLOW_PYTHON_BIN: dirname(pythonPath(join(selectedServer, 'python'))),
  })
  if (components.paths.vox) env.VOX_PYTHON = pythonPath(join(components.paths.vox, 'python'))
  if (components.paths.web) env.AIXAND_PRODUCTION_WEB_DIST = components.paths.web
  env.AIXAND_CONNECT_COMPANION = components.paths.connect
    ? join(components.paths.connect, 'companion.pyz') : join(root, 'connect/companion.pyz')
  const componentIdentity = Object.fromEntries(Object.entries(components.components).map(([id, value]) => [id, value.release]))
  return { root, base, plan, serviceNames: plan ? serviceNames.map(name => name.replace('aixand-local-', 'aixand-' + plan.instanceId + '-')) : serviceNames, port, carrierPort, env, selection, tools,
    identity: Object.keys(componentIdentity).length ? createHash('sha256').update(JSON.stringify({ identity, components: componentIdentity })).digest('hex') : identity,
    components, products, model, input: { ...productInput, ...(input.AIXAND_ACTIVATION_OPERATION ? { AIXAND_ACTIVATION_OPERATION: input.AIXAND_ACTIVATION_OPERATION, AIXAND_ACTIVATION_OWNER: input.AIXAND_ACTIVATION_OWNER } : {}) },
    address: `http://127.0.0.1:${port}/`, server: selectedServer ? join(selectedServer, 'server') : join(root, 'server') }
}

export function deploymentArguments(config) {
  return ['AIXAND_PRODUCTION_ORIGINS', 'AIXAND_PRODUCTION_TRANSPORT', 'AIXAND_PRODUCTION_TRUST_PROXY']
    .flatMap(key => ['--env', `${key}=${config.env[key]}`])
}

async function run(config, program, args, timeout = 15_000) {
  return (await execute(program, args, { cwd: config.server, env: config.env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout
}
async function uc(config, args, timeout) {
  try { return await run(config, config.tools.uc, ['--timeout', args[0] === 'stop' ? '60s' : '30s', ...args], timeout || (args[0] === 'stop' ? 70_000 : 40_000)) }
  catch (error) { throw new Error(`Local runtime: uc ${args.slice(0, 2).join(' ')} failed. ${error.stderr?.trim() || error.message}`) }
}
async function daemonOnline(config) {
  try { return JSON.parse(await uc(config, ['--json', 'daemon', 'status'])).accepting_connections === true }
  catch { return false }
}
async function session(config, name) {
  const result = JSON.parse(await uc(config, ['--json', 'ls', '--name', name, '--projection', 'with-labels', '--page-size', '1']))
  const item = result.items.find(item => item.name === name)
  if (item && !ownsSession(config, item)) throw new Error('A service with this name belongs to another workspace.')
  return item
}
async function allSessions(config) {
  const items = []
  let cursor
  do {
    const page = JSON.parse(await uc(config, ['--json', 'ls', '--projection', 'with-labels', '--page-size', '100', ...(cursor ? ['--cursor', cursor] : [])]))
    items.push(...page.items)
    cursor = page.next_cursor
  } while (cursor)
  return items.filter(item => ownsSession(config, item))
}
export async function retainRuntimeReceipt(config, next) {
  const path = join(config.base, 'runtime.json')
  let text
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    // A shared daemon can run before this workspace starts for the first time.
    const active = (await allSessions(config)).some(item => ['running', 'starting', 'stopping'].includes(item.lifecycle.state))
    if (active) throw new Error('Workspace services are active without runtime ownership data. Stop them before changing tools.')
    return
  }
  const receipt = JSON.parse(text)
  if (receipt.root !== config.root || receipt.identity !== config.identity) {
    const active = (await allSessions(config)).some(item => ['running', 'starting', 'stopping'].includes(item.lifecycle.state))
    if (active) throw new Error('Another runtime owns these services. Stop it before changing tools.')
    // A stopped workspace can retain a receipt from its previous home plan.
    // Startup writes the new receipt after it checks the selected ports.
    return
  }
  await writeFile(path, JSON.stringify({ ...receipt, identity: next.identity }) + '\n', { mode: 0o600 })
}

async function healthy(url, identity) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'error' })
    if (!response.ok) return false
    if (!identity) return true
    const body = await response.json()
    return body.status === 'ok' && body.service === identity
  } catch { return false }
}
async function vacant(port) {
  await new Promise((resolvePort, reject) => {
    const socket = createServer()
    socket.once('error', () => reject(new Error(`Port ${port} is already in use. Stop the SSH tunnel or other server, or set AIXAND_LOCAL_PORT / AIXAND_LOCAL_CARRIER_PORT to unused ports. Nothing was stopped.`)))
    socket.listen(port, '127.0.0.1', () => socket.close(resolvePort))
  })
}
async function runnerReady(config) {
  return new Promise(resolveReady => {
    let socket
    try { socket = localConnection(join(config.env.RUNNER_HOME, 'runner.sock')) } catch { resolveReady(false); return }
    let body = ''
    const finish = value => { socket.destroy(); resolveReady(value) }
    socket.setTimeout(1500, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('connect', () => socket.write('{"op":"health"}\n'))
    socket.on('data', chunk => {
      body += chunk
      if (body.length > 1024 * 1024) return finish(false)
      if (body.includes('\n')) {
        try { const reply = JSON.parse(body.split('\n')[0]); finish(reply.ok && reply.data?.service === 'runner') }
        catch { finish(false) }
      }
    })
    socket.once('end', () => finish(false))
  })
}
function services(config) {
  return [
    { name: config.serviceNames[0], probe: () => healthy(`${config.env.CARRIER_URL}/health`, 'carrier'), health: `${config.env.CARRIER_URL}/health` },
    { name: config.serviceNames[1], probe: () => runnerReady(config) },
    { name: config.serviceNames[2], probe: async () => await healthy(`${config.address}api/health`, 'aixand-server') && (config.model.headless || await healthy(config.address) && await healthy(`${config.address}recovery.html`)), health: `${config.address}api/health` },
  ]
}

export async function status(config) {
  const online = await daemonOnline(config)
  const items = []
  for (const service of services(config)) {
    const current = online ? await session(config, service.name) : undefined
    items.push({ name: service.name, state: current?.lifecycle.state || 'stopped', ready: Boolean(current && await service.probe()) })
  }
  return { available: true, running: items.every(item => item.ready), address: config.address, dataDirectory: config.base, services: items }
}

export async function updateBlockers(config) {
  const sessions = await daemonOnline(config) ? (await allSessions(config)).filter(item => !config.serviceNames.includes(item.name) && ['running', 'starting', 'stopping'].includes(item.lifecycle.state)) : []
  if (await runnerReady(config)) {
    let after = 0
    while (true) {
      const page = JSON.parse(await run(config, config.tools.runner, ['--home', config.env.RUNNER_HOME, 'list', '--after', String(after), '--limit', '100']))
      if (!Array.isArray(page.jobs)) throw new Error('Could not review the workspace workflow jobs.')
      for (const job of page.jobs) if (['queued', 'running'].includes(job.state)) sessions.push({ id: job.id, name: 'Workflow ' + job.id, lifecycle: { state: job.state } })
      if (page.jobs.length < 100) break
      const next = page.jobs.at(-1).sequence
      if (!Number.isSafeInteger(next) || next <= after) throw new Error('Could not page through workspace workflow jobs.')
      after = next
    }
  }
  return sessions
}

export async function prepareUpdate(config) {
  return locked(config, async () => {
    if ((await updateBlockers(config)).length) throw new Error('New workspace work started. Review the update again.')
    // Close the workspace's API before the final review so it cannot accept
    // new chats/terminal launches while its runtime is being replaced.
    if (await daemonOnline(config)) {
      const api = await session(config, config.serviceNames[2])
      if (api && ['running', 'starting'].includes(api.lifecycle.state)) await uc(config, ['stop', api.name, windows ? '--force' : '--graceful'])
    }
    if ((await updateBlockers(config)).length) throw new Error('Workspace work started during update preparation. The installation was retained.')
    return { prepared: true }
  })
}

async function initialize(config, refreshPaths = true) {
  for (const path of ['', 'config', 'data', 'state', 'cache', 'carrier', ...(windows ? ['cache/tmp'] : ['runner', 'auth']), 'chats', 'scratch'])
    await mkdir(join(config.base, path), { recursive: true, mode: 0o700 })
  if (!config.selection.reuseConfig && (!config.plan || config.plan.mode === 'isolated')) {
    const providers = join(config.base, 'config/providers.toml')
    try { await writeFile(providers, await readFile(join(config.root, 'providers.toml')), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  if (config.env.AGENT_MANAGER_CONFIG && !existsSync(config.env.AGENT_MANAGER_CONFIG))
    throw new Error('Agent Manager configuration does not exist: ' + config.env.AGENT_MANAGER_CONFIG + '. Select an existing custom file or use the default provider configuration.')
  if (config.env.CONVERSATION_MANAGER_CONFIG) {
    const path = config.env.CONVERSATION_MANAGER_CONFIG
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try { await writeFile(path, '# Conversation Manager defaults.\n', { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  // Regenerate installation paths after relocation or upgrade, outside immutable software.
  try {
    await writeFile(config.env.WORKFLOW_SDK_CONFIG, JSON.stringify({
      python_interpreter: { executable: config.tools.pythonExecutable || config.tools.python, home: config.tools.pythonHome,
        prefix: config.tools.pythonPrefix || config.tools.pythonHome,
        base_executable: config.tools.pythonBaseExecutable || config.tools.python },
      python_paths: config.tools.pythonPaths,
      connection: { bridge: config.env.UNDERCURRENT_PYTHON_BRIDGE, state_dir: join(config.base, 'workflow-runs'), stable_for: 2, timeout: 300 },
    }, null, 2) + '\n', { mode: 0o600, flag: refreshPaths ? 'w' : 'wx' })
  } catch (error) { if (refreshPaths || error.code !== 'EEXIST') throw error }
}

async function locked(config, callback) {
  return withActivationAccess(config.base, config.input?.AIXAND_ACTIVATION_OPERATION, () => lifecycleLocked(config, callback), config.input?.AIXAND_ACTIVATION_OWNER)
}

async function lifecycleLocked(config, callback) {
  await mkdir(config.base, { recursive: true, mode: 0o700 })
  const lock = join(config.base, 'lifecycle.lock')
  const deadline = Date.now() + 120_000
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      let pid
      try { pid = Number(await readFile(join(lock, 'pid'), 'utf8')) } catch {}
      if (pid) {
        try { process.kill(pid, 0) }
        catch (error) { if (error.code === 'ESRCH') { await rm(lock, { recursive: true }); continue } }
      } else if (Date.now() - (await stat(lock)).mtimeMs > 120_000) {
        await rm(lock, { recursive: true }); continue
      }
      if (Date.now() >= deadline) throw new Error('Local services are being started or stopped by another process. Try again shortly.')
      await delay(200)
    }
  }
  await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
  try { return await callback() } finally { await rm(lock, { recursive: true, force: true }) }
}

export async function start(config) {
  if (config.products && !config.plan && !existsSync(join(config.base, 'runtime.json')) && !existsSync(join(config.base, 'config/product-installation.json')))
    throw new Error('Choose Standard installation or Separate Suite installation in setup before starting.')
  return locked(config, async () => {
    if (config.products && !config.selection.bootstrapping)
      await validateInstalledProducts(config.root, config.input, config.base)
    if (configuration(config.root, config.input).identity !== config.identity)
      throw new Error('Local setup changed while startup was waiting. Open the workspace again.')
    if (config.selection.mode === 'system' && !config.products) {
      const check = await inspectSystem(config.root, config.input, { ...config.selection,
        python: config.tools.python, voicePython: config.tools.voicePython, binDirectory: config.tools.binDirectory })
      if (!check.ready) throw new Error('System tools are no longer compatible. Open Local setup and check the tools again. ' + check.checks.filter(item => !item.ready).map(item => item.message).join(' '))
      if (check.tools.uc !== config.tools.uc || check.tools.runner !== config.tools.runner)
        throw new Error('The selected system executables changed. Save Local setup again before starting.')
    }
    const manifest = JSON.parse(await readFile(join(config.root, 'manifest.json')))
    const receiptPath = join(config.base, 'runtime.json')
    const previous = existsSync(receiptPath) ? JSON.parse(await readFile(receiptPath)) : undefined
    const online = await daemonOnline(config)
    const active = online ? (await Promise.all(config.serviceNames.map(name => session(config, name)))).filter(item => item && ['running', 'starting', 'stopping'].includes(item.lifecycle.state)) : []
    const otherWork = online && (await allSessions(config)).some(item => ['running', 'starting', 'stopping'].includes(item.lifecycle.state))
    if ((active.length || otherWork) && (!previous || previous.build !== manifest.build || previous.root !== config.root || previous.port !== config.port || previous.carrierPort !== config.carrierPort || (previous.identity && previous.identity !== config.identity)))
      throw new Error('A different local runtime is still active. Run its aixand-runtime stop before changing versions, installation paths, or ports. User data was left intact.')
    if (!active.some(item => item.name === config.serviceNames[2])) await vacant(config.port)
    if (!active.some(item => item.name === config.serviceNames[0])) await vacant(config.carrierPort)
    await initialize(config)
    if (!online) {
      if (config.plan && !config.plan.undercurrent.owned) {
        // A shared daemon must retain the user's environment for unrelated work.
        await execute(config.tools.uc, ['--timeout', '30s', 'daemon', 'start'], {
          env: { ...userEnvironment(config.input), UNDERCURRENT_HOME: config.env.UNDERCURRENT_HOME },
          cwd: config.env.HOME, timeout: 40000, windowsHide: true,
        })
      } else await uc(config, ['daemon', 'start'])
    }
    await writeFile(receiptPath, JSON.stringify({ schema: 1, build: manifest.build, root: config.root, port: config.port, carrierPort: config.carrierPort, identity: config.identity }) + '\n', { mode: 0o600 })
    for (const service of services(config)) {
      let current = await session(config, service.name)
      if (current && !['running', 'starting'].includes(current.lifecycle.state)) {
        if (current.lifecycle.state === 'stopping') throw new Error(`${service.name} is stopping. Try again shortly.`)
        await uc(config, ['clean', service.name, '--yes'])
        current = undefined
      }
      if (!current) {
        const args = ['start', service.name, '--profile', 'server', '--cwd', config.server,
          '--stop-timeout', '30s', '--label', 'app=aixand-local',
          ...(config.plan ? ['--label', 'suite.instance=' + config.plan.instanceId] : []),
          '--env', `AIXAND_SETUP_USER_ENV=${config.env.AIXAND_SETUP_USER_ENV}`,
          '--env', `AIXAND_SHARED_PRODUCT_PREFIX=${config.input.AIXAND_SHARED_PRODUCT_PREFIX}`,
          '--env', `AIXAND_LOCAL_HOME=${config.base}`, '--env', `AIXAND_LOCAL_PORT=${config.port}`,
          '--env', `AIXAND_LOCAL_CARRIER_PORT=${config.carrierPort}`]
        args.push(...deploymentArguments(config))
        if (service.health) args.push('--healthy-when', `http:${service.health}`)
        args.push('--', nodePath(config.root), join(config.root, 'runtime.mjs'), 'service', service.name)
        await uc(config, args)
      }
      const deadline = Date.now() + 90_000
      while (!await service.probe()) {
        const current = await session(config, service.name)
        if (!current || !['running', 'starting'].includes(current.lifecycle.state) || Date.now() >= deadline)
          throw new Error(`${service.name} did not become ready. Inspect it with: aixand-runtime exec uc logs ${service.name}`)
        await delay(300)
      }
    }
    return status(config)
  })
}

export async function uninstallProducts(config) {
  // A shared daemon can remain online after this workspace stops. If there is
  // no application-private product store, removal is a no-op and must not
  // require stopping an independently owned daemon.
  if (existsSync(join(config.base, 'software/products')) && await daemonOnline(config))
    throw new Error('Stop local services before removing private products.')
  return removePrivateProducts(config.root, config.input, config.base)
}

export async function stop(config) {
  return locked(config, async () => {
    const workers = ownedProcesses(config)
    if (!await daemonOnline(config)) {
      await stopProcesses(workers)
      return { stopped: true, dataDirectory: config.base }
    }
    // Shared connections stop only sessions bearing this instance's ownership label.
    const items = await allSessions(config)
    const rank = name => name === config.serviceNames[1] ? 0 : name === config.serviceNames[2] ? 1 : name === config.serviceNames[0] ? 3 : 2
    const ordered = [...items].sort((a, b) => rank(a.name) - rank(b.name))
    for (const item of ordered)
      if (['running', 'starting'].includes(item.lifecycle.state))
        await uc(config, ['stop', item.name, windows ? '--force' : '--graceful'])
    if (!config.plan || config.plan.undercurrent.owned) await uc(config, ['daemon', 'stop'])
    await stopProcesses(workers)
    return { stopped: true, dataDirectory: config.base }
  })
}

function processIdentity(pid) {
  try {
    const content = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = content.slice(content.lastIndexOf(')') + 2).split(/\s+/)
    return fields[0] === 'Z' ? undefined : fields[19]
  } catch { return undefined }
}
function ownedProcesses(config) {
  // A shared daemon can pass its launch environment to unrelated session hosts.
  // Environment inheritance is not proof of ownership; use UC session labels.
  if (config.plan && !config.plan.undercurrent.owned) return []
  if (process.platform !== 'linux') return [] // UC owns Windows jobs and macOS process groups.
  return readdirSync('/proc').filter(name => /^\d+$/.test(name) && Number(name) !== process.pid).flatMap(name => {
    try {
      const env = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0')
      const birth = processIdentity(name)
      return birth && env.includes(`UNDERCURRENT_HOME=${config.env.UNDERCURRENT_HOME}`) && (!config.plan || env.includes(`AIXAND_LOCAL_HOME=${config.base}`)) ? [{ pid: Number(name), birth }] : []
    } catch { return [] }
  })
}
async function stopProcesses(processes) {
  const live = () => processes.filter(item => processIdentity(item.pid) === item.birth)
  const signal = (item, kind) => { if (processIdentity(item.pid) === item.birth) try { process.kill(item.pid, kind) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  for (const item of live()) signal(item, 'SIGTERM')
  const deadline = Date.now() + 10_000
  while (live().length && Date.now() < deadline) await delay(100)
  for (const item of live()) signal(item, 'SIGKILL')
}

async function privateEnvironment(config) {
  const path = join(config.base, 'config/runtime.env')
  const pinnedDeployment = Object.fromEntries(Object.entries(config.env).filter(([key]) => key.startsWith('AIXAND_PRODUCTION_')))
  // Credentials are read by the child after launch, never stored in uc recipes.
  return { ...config.env, ...(existsSync(path) ? parseEnv(await readFile(path, 'utf8')) : {}), ...pinnedDeployment,
    ...Object.fromEntries(Object.entries(config.env).filter(([key]) => key.startsWith('AIXAND_PROVIDER_') || (config.plan && (key.endsWith('_MANAGER_HOME') || key === 'AGENT_MANAGER_CONFIG' || key.startsWith('XDG_'))) || ['HOME', 'PATH', 'TERMINAL_BRIDGE_PATH', 'WORKFLOW_BRIDGE_PATH', 'WORKFLOW_PYTHON_BIN', 'AIXAND_CONNECT_COMPANION', 'npm_config_prefix', 'AIXAND_SETUP_USER_ENV', 'AIXAND_SUITE_INSTANCE_ID', 'AGENT_MANAGER_LABELS', 'CONVERSATION_MANAGER_CONFIG', 'AGENT_MANAGER_HOMES_ROOT', 'AIXAND_MANAGER_ROOT', 'ORCHESTRATION_HOME', 'UNDERCURRENT_HOME', 'AIXAND_LOCAL_HOME', 'AIXAND_AUTH_DATABASE', 'CARRIER_DATABASE', 'CARRIER_URL', 'SUITE_WORKFLOW_SOCKET', 'AGENTS_PYTHON', 'CARRIER_PYTHON', 'VOX_PYTHON', 'UNDERCURRENT_PYTHON_BRIDGE', 'WORKFLOW_PYTHON_HOME', 'AIXAND_PRODUCT_RUNTIME', 'AIXAND_SHARED_PRODUCT_PREFIX', 'AIXAND_PACKAGED_RUNTIME', 'AIXAND_VOICE_ENABLED', 'DYLD_LIBRARY_PATH'].includes(key))) }
}
async function service(config, name) {
  const env = await privateEnvironment(config)
  const commands = {
    // The standalone service uses its product environment; the Suite bridge
    // needs the application SDK environment selected by CARRIER_PYTHON.
    [config.serviceNames[0]]: [config.tools.carrierPython || env.CARRIER_PYTHON, ['-m', 'carrier.cli', 'serve', '--host', '127.0.0.1', '--port', String(config.carrierPort), '--db', env.CARRIER_DATABASE]],
    [config.serviceNames[1]]: [config.tools.workflowRunner || config.tools.runner, ['--home', env.RUNNER_HOME, 'serve', '--sdk-config', env.WORKFLOW_SDK_CONFIG, '--suite-socket', env.SUITE_WORKFLOW_SOCKET]],
    [config.serviceNames[2]]: [nodePath(config.root), [join(config.server, 'dist/production-main.js')]],
  }
  if (!commands[name]) throw new Error('Unknown bundled service.')
  const [program, args] = commands[name]
  if (name === config.serviceNames[1]) env.PYTHONHOME = config.tools.pythonHome
  process.chdir(config.server)
  replaceProcess(program, args, env)
}

export async function doctor(config) {
  if (windows) await mkdir(config.env.TEMP, { recursive: true, mode: 0o700 })
  await initialize(config, false)
  const modules = ['agent_manager', 'mcp_manager', 'prompt_manager', 'skill_manager', 'conversation_manager', 'orchestration_mcp', 'undercurrent', 'carrier', 'aixand', 'runner_client', 'aixand_connect']
  await run(config, config.tools.python, ['-B', '-c', `import importlib; [importlib.import_module(name) for name in ${JSON.stringify(modules)}]`])
  await execute(config.env.AGENTS_PYTHON, ['-B', '-c',
    'from main import Adapter; a = Adapter(); a.require_provider("codex"); a.require_provider("opencode"); print("Provider initialization OK")'],
    { cwd: join(config.server, 'agent-bridge'), env: await privateEnvironment(config), timeout: 30_000 })
  const manifest = JSON.parse(await readFile(join(config.root, 'manifest.json')))
  if (manifest.features.voice)
    await run(config, config.env.VOX_PYTHON, ['-I', '-B', '-c', 'import aixand_vox.speech, sherpa_onnx'], 60_000)
  return { ready: true, build: manifest.build, mode: config.selection.mode, modules, providersReady: true, origins: config.env.AIXAND_PRODUCTION_ORIGINS.split(','), transport: config.env.AIXAND_PRODUCTION_TRANSPORT, voice: manifest.features.voice, address: config.address, dataDirectory: config.base }
}

async function setup(config, action = 'info', json = '{}') {
  if (action === 'discover') return discoverInstallation(config.root, config.input, config.base)
  if (action === 'choose') {
    const request = JSON.parse(json)
    return locked(config, async () => {
      if (!config.plan && (existsSync(join(config.base, 'runtime.json')) || existsSync(join(config.base, 'config/product-installation.json'))))
        throw new Error('This workspace already has an installation. Restore its explicit installation plan before setup.')
      return saveInstallationPlan(config.root, config.input, config.base, request.mode, request.settings)
    })
  }
  if (action === 'products') return productStatus(config.root, config.input, config.base)
  if (action === 'commands') return productCommands(config.root, config.input, config.base)
  if (action === 'info') return { configured: config.selection.configured, mode: config.selection.mode,
    setupMode: config.plan?.mode, selectionRequired: Boolean(config.products && !config.plan),
    workspaceId: createHash('sha256').update(config.env.AIXAND_AUTH_DATABASE).digest('hex'),
    reuseConfig: config.selection.reuseConfig, options: config.selection.options || {},
    dataDirectory: config.base, tools: config.tools, installation: config.products
      ? { edition: config.products.catalog.edition, ready: !config.selection.bootstrapping, onboardInWorkspace: true } : null }
  if (config.products) {
    if (action === 'install') return installProducts(config.root, config.input, config.base, JSON.parse(json), async () => {
      // Installing tools must not terminate the server handling onboarding, or
      // work already running in its private namespace. Retain compatible live
      // processes; new launches use the installed product commands.
      await locked(config, async () => {
        const next = configuration(config.root, config.input)
        for (const name of ['uc', 'runner']) {
          const expected = (await run(config, join(config.root, 'bin', binary(name)), ['--version'])).trim()
          if ((await run(next, next.tools[name], ['--version'])).trim() !== expected)
            throw new Error('Installed ' + name + ' is incompatible with this Suite release.')
        }
        if (await daemonOnline(config)) {
          if (!await daemonOnline(next)) throw new Error('The installed tools cannot reach this workspace.')
          await retainRuntimeReceipt(config, next)
        }
      })
    })
    if (action === 'check') return productStatus(config.root, config.input, config.base)
    if (action === 'save') throw new Error('This installer selects its tool ownership. Finish product setup in the workspace.')
    throw new Error(usage)
  }
  throw new Error('Product installation requires a current Desktop or Server package and an explicit installation plan.')
}

export async function main(args = process.argv.slice(2)) {
  const config = configuration()
  const [command, ...rest] = args
  let result
  if (command === 'start' && rest.length === 0) result = await start(config)
  else if (command === 'prepare-update' && rest.length === 0) result = await prepareUpdate(config)
  else if (command === 'updates' && rest.length <= 2) {
    const { updateAction } = await import('./updates.mjs')
    result = await updateAction({ ...config, updateDirectory: process.env.AIXAND_UPDATE_STATE_DIR }, rest[0] || 'status', JSON.parse(rest[1] || '{}'))
  }
  else if (command === 'component-updates' && rest.length <= 2) {
    const { componentAction } = await import('./component-launcher.mjs')
    result = await componentAction(config, rest[0] || 'status', JSON.parse(rest[1] || '{}'))
  }
  else if (command === 'stop' && rest.length === 0) result = await stop(config)
  else if (command === 'uninstall-products' && rest.length === 0) {
    result = await uninstallProducts(config)
  }
  else if (command === 'status' && rest.length === 0) result = await status(config)
  else if (command === 'doctor' && rest.length === 0) result = await doctor(config)
  else if (command === 'setup' && rest.length <= 2) result = await setup(config, ...rest)
  else if (command === 'cleanup' && rest[0] === 'plan' && rest.length === 1) result = await cleanupPlan(config)
  else if (command === 'cleanup' && rest[0] === 'restore-provider' && rest.length === 2) result = await restoreCleanupProvider(config, JSON.parse(rest[1]), {
    install: async (config, provider) => {
      await initialize(config, false)
      await execute(config.tools.python, ['-B', join(config.root, 'python-entry.py'), 'agent', 'install', provider, '--installer', '--yes'],
        { env: await privateEnvironment(config), windowsHide: true, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 })
    },
  })
  else if (command === 'cleanup' && ['apply', 'stop-processes', 'repair-permissions'].includes(rest[0]) && rest.length === 2) result = await ({ apply: applyCleanup, 'stop-processes': stopCleanupProcesses, 'repair-permissions': repairCleanupPermissions }[rest[0]])(config, JSON.parse(rest[1]), {
    stop: config => stop(config), locked: (config, callback) => locked(config, async () => {
      if (await daemonOnline(config) && (!config.plan || config.plan.undercurrent.owned || (await allSessions(config)).some(item => ['running', 'starting', 'stopping'].includes(item.lifecycle.state)))) throw new Error('Local services restarted. Stop them and review the checklist again.')
      return callback()
    }),
  })
  else if (command === 'service' && rest.length === 1) return service(config, rest[0])
  else if (command === 'prepare-voice' && rest.length === 0) {
    const manifest = JSON.parse(await readFile(join(config.root, 'manifest.json')))
    if (!manifest.features.voice) throw new Error('This runtime was built without the optional voice dependencies.')
    const env = await privateEnvironment(config)
    return replaceProcess(env.VOX_PYTHON, ['-m', 'aixand_vox.prepare'], env)
  } else if (command === 'exec' && rest.length) {
    const [name, ...argv] = rest
    const managedCommand = config.products && config.tools.commands?.[name]
    const program = managedCommand || join(config.root, 'bin', binary(name))
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) || !program || !existsSync(program)) throw new Error('This command is not installed in the selected toolset.')
    // CLI entry points work before the desktop has ever started. Existing
    // configuration is retained and no services are launched by initialization.
    await initialize(config, false)
    const env = await privateEnvironment(config)
    if (managedCommand || ['uc', 'runner', 'uc-daemon', 'uc-session-host', 'uc-python-bridge', 'aixand-terminal-bridge', 'aixand-workflow-bridge', 'uv', 'uvx', 'codex', 'claude'].includes(name)) {
      if (['runner', 'aixand-workflow-bridge'].includes(name)) env.PYTHONHOME = config.tools.pythonHome
      return replaceProcess(program, argv, env)
    }
    else {
      const python = name.startsWith('aixand-vox') ? env.VOX_PYTHON : env.AGENTS_PYTHON
      return replaceProcess(python, [join(config.root, 'python-entry.py'), name, ...argv], env)
    }
  } else throw new Error(usage)
  console.log(JSON.stringify(result))
}
if (import.meta.main)
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
