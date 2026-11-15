// Setup policy is workspace state, independent of the signed product catalog.
import { existsSync, readFileSync, realpathSync, openSync, readSync, closeSync, accessSync, constants } from 'node:fs'
import { mkdir, writeFile, rename, readFile, lstat } from 'node:fs/promises'
import { join, resolve, isAbsolute, delimiter } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { binary, inside, pythonPath } from './platform.mjs'
import { productCatalog, sharedProductPrefix } from './products.mjs'

const execute = promisify(execFile)
const names = ['AGENT_MANAGER_HOME', 'AGENT_MANAGER_CONFIG', 'AGENT_MANAGER_HOMES_ROOT', 'MCP_MANAGER_HOME', 'PROMPT_MANAGER_HOME', 'SKILL_MANAGER_HOME', 'SERVER_MANAGER_HOME', 'CONVERSATION_MANAGER_HOME', 'CONVERSATION_MANAGER_CONFIG', 'ORCHESTRATION_HOME']
const userKeys = [...names, 'AIXAND_MANAGER_ROOT', 'PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'UNDERCURRENT_HOME', 'RUNNER_HOME']
export const planPath = base => join(base, 'config/installation-plan.json')
export const instanceId = base => createHash('sha256').update(base).digest('hex').slice(0, 12)

export function userEnvironment(input) {
  const original = input.AIXAND_SETUP_USER_ENV ? JSON.parse(input.AIXAND_SETUP_USER_ENV) : input
  return Object.fromEntries(userKeys.filter(key => typeof original[key] === 'string').map(key => [key, original[key]]))
}

export function readInstallationPlan(base) {
  if (!existsSync(planPath(base))) return null
  const value = JSON.parse(readFileSync(planPath(base), 'utf8'))
  if (value.schema !== 2 || 'managerHomesVersion' in value || !['shared', 'isolated'].includes(value.mode) || value.instanceId !== instanceId(base) ||
      (value.managerRoot != null && (typeof value.managerRoot !== 'string' || !isAbsolute(value.managerRoot) || value.mode !== 'shared')) ||
      (value.userPath !== undefined && typeof value.userPath !== 'string') ||
      (value.mode === 'isolated' ? !['fresh', 'copy'].includes(value.settings) : value.settings !== 'reuse') ||
      !value.managers || Array.isArray(value.managers) || !value.undercurrent || typeof value.undercurrent.owned !== 'boolean' ||
      (value.mode === 'shared' && names.some(key => typeof value.managers[key] !== 'string' || inside(value.managers[key], base))) ||
      (value.undercurrent.program && !isAbsolute(value.undercurrent.program)) ||
      value.undercurrent.owned !== (value.mode === 'isolated') || !isAbsolute(value.undercurrent.home) ||
      (value.mode === 'isolated' && (value.undercurrent.home !== join(base, 'uc') || Object.keys(value.managers).length > 0)) ||
      (value.mode === 'shared' && (value.undercurrent.home === base || inside(value.undercurrent.home, base))) ||
      (value.userDirectories && Object.entries(value.userDirectories).some(([key, path]) => !['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'].includes(key) || typeof path !== 'string' || !isAbsolute(path))) ||
      Object.entries(value.managers).some(([key, path]) => !names.includes(key) || typeof path !== 'string' || !isAbsolute(path)))
    throw new Error('Invalid saved installation plan. Restore the workspace configuration before starting.')
  if (value.reusedProducts && (typeof value.reusedProducts !== 'object' || Array.isArray(value.reusedProducts) || value.mode !== 'shared' && Object.keys(value.reusedProducts).length ||
      Object.values(value.reusedProducts).some(product => !product || typeof product.version !== 'string' || !product.commands ||
        Object.values(product.commands).some(path => typeof path !== 'string' || !isAbsolute(path) || inside(path, base)))))
    throw new Error('Invalid saved tool selection.')
  return value
}

export function standardManagers(input) {
  const home = resolve(input.HOME || input.USERPROFILE)
  const expand = value => resolve(value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value)
  const data = input.XDG_DATA_HOME && isAbsolute(input.XDG_DATA_HOME) ? input.XDG_DATA_HOME : join(home, '.local/share')
  const root = input.AIXAND_MANAGER_ROOT ? expand(input.AIXAND_MANAGER_ROOT) : join(data, 'aixand/manager')
  const pick = (key, path) => input[key] ? expand(input[key]) : path
  const state = pick('AGENT_MANAGER_HOME', join(root, 'agent/state'))
  return {
    AGENT_MANAGER_HOME: state,
    AGENT_MANAGER_CONFIG: pick('AGENT_MANAGER_CONFIG', join(root, 'agent/providers.toml')),
    AGENT_MANAGER_HOMES_ROOT: pick('AGENT_MANAGER_HOMES_ROOT', state === join(root, 'agent/state') ? join(root, 'agent/home') : join(state, 'home')),
    MCP_MANAGER_HOME: pick('MCP_MANAGER_HOME', join(root, 'mcp')),
    PROMPT_MANAGER_HOME: pick('PROMPT_MANAGER_HOME', join(root, 'prompt')),
    SKILL_MANAGER_HOME: pick('SKILL_MANAGER_HOME', join(root, 'skill')),
    CONVERSATION_MANAGER_HOME: pick('CONVERSATION_MANAGER_HOME', join(root, 'conversation/state')),
    CONVERSATION_MANAGER_CONFIG: pick('CONVERSATION_MANAGER_CONFIG', join(root, 'conversation/config.toml')),
    // These are separate services, not members of the five-manager layout.
    SERVER_MANAGER_HOME: pick('SERVER_MANAGER_HOME', join(data, 'server-manager')),
    ORCHESTRATION_HOME: pick('ORCHESTRATION_HOME', join(input.XDG_STATE_HOME || join(home, '.local/state'), 'aixand/orchestration')),
  }
}

function independentCommand(path, root) {
  let descriptor
  try {
    accessSync(path, constants.X_OK)
    if (inside(realpathSync(path), root)) return false
    descriptor = openSync(path, 'r')
    const prefix = Buffer.alloc(400)
    const length = readSync(descriptor, prefix, 0, prefix.length, 0)
    const text = prefix.subarray(0, length).toString()
    // Suite launchers initialize a private runtime even for CLI reads.
    return !(text.startsWith('#!') && text.includes('runtime.mjs'))
  } catch { return false }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}

async function resolveConversationHome(root, env, managers) {
  if (env.CONVERSATION_MANAGER_HOME || !existsSync(managers.CONVERSATION_MANAGER_CONFIG) || !existsSync(pythonPath(join(root, 'python')))) return
  const probeEnv = { ...process.env }
  for (const key of [...userKeys, 'PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV']) delete probeEnv[key]
  Object.assign(probeEnv, env, { CONVERSATION_MANAGER_CONFIG: managers.CONVERSATION_MANAGER_CONFIG, PYTHONDONTWRITEBYTECODE: '1' })
  const result = await execute(pythonPath(join(root, 'python')), ['-I', '-B', '-c',
    'import json,tomllib; from conversation_manager.config import path,load,state_home; data=tomllib.loads(path().read_text()); settings=load(); print(json.dumps(str(state_home(settings=settings)) if "home" in data.get("storage",{}) else None))'],
    { env: probeEnv, timeout: 15000, windowsHide: true, maxBuffer: 65536 })
  const configured = JSON.parse(result.stdout)
  if (configured) managers.CONVERSATION_MANAGER_HOME = configured
}

export async function discoverInstallation(root, input, base) {
  const env = userEnvironment(input), home = env.HOME || env.USERPROFILE
  const managers = standardManagers(env)
  let configurationIssue = env.CONVERSATION_MANAGER_CONFIG && !existsSync(managers.CONVERSATION_MANAGER_CONFIG)
    ? 'The selected Conversation Manager config file does not exist.' : null
  try { await resolveConversationHome(root, env, managers) }
  catch { configurationIssue = 'Could not resolve the Conversation Manager home. Check its configuration file before setup.' }

  const data = Object.entries(managers).filter(([, path]) => existsSync(path)).map(([name, path]) => ({ name, path }))
  const tools = []
  const catalog = productCatalog(root)
  const products = catalog?.assemblies.flatMap(row => Object.entries(row.products)) || []
  const commands = [...new Set(['uc', 'runner', 'carrier', 'agent', 'prompt-manager', 'skill-manager', 'mcp-manager', 'conversation-manager', 'orchestration-mcp',
    ...products.flatMap(([, product]) => product.commands)])]
  const directories = [...new Set([...(env.PATH || '').split(delimiter).filter(isAbsolute),
    join(sharedProductPrefix({ ...input, ...env }), 'bin'), join(home, '.local/bin')])]
  const probeEnv = { ...process.env, ...env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
  for (const key of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV']) delete probeEnv[key]
  await Promise.all(commands.map(async name => {
    const path = directories.map(directory => join(directory, binary(name)))
      .find(path => !inside(path, base) && independentCommand(path, root))
    if (path) {
      const product = products.find(([, product]) => product.commands.includes(name))
      const primary = ['uc', 'runner', 'carrier', 'agent', 'prompt-manager', 'skill-manager', 'mcp-manager', 'conversation-manager', 'orchestration-mcp'].includes(name)
      let version = null, compatible = null, issue = null
      if (primary) {
        try {
          version = (await execute(path, ['--version'], { env: probeEnv, timeout: 15000, windowsHide: true, maxBuffer: 65536 })).stdout.trim()
          compatible = product ? version.split(/\s+/).map(value => value.replace(/^v/, '').replace(/b0$/, '-beta')).includes(product[1].version) : null
        } catch { issue = 'Could not check the tool version.'; compatible = false }
      }
      tools.push({ name, path, version, compatible, issue, product: product?.[0], primary })
    }
  }))
  tools.sort((left, right) => commands.indexOf(left.name) - commands.indexOf(right.name))
  let undercurrent = { home: env.UNDERCURRENT_HOME || join(home, '.aixand/undercurrent'), profile: null }
  const uc = tools.find(tool => tool.name === 'uc')
  let issue = configurationIssue
  const probeProgram = uc?.path || (existsSync(join(root, 'bin', binary('uc'))) ? join(root, 'bin', binary('uc')) : null)
  if (probeProgram) {
    try {
      const probeEnv = { ...process.env }
      for (const key of [...userKeys, 'PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV']) delete probeEnv[key]
      Object.assign(probeEnv, env)
      const result = await execute(probeProgram, ['--json', 'settings', 'show'], { env: probeEnv, timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 })
      const settings = JSON.parse(result.stdout)
      if (!settings.effective || !isAbsolute(settings.effective.home)) throw new Error('Could not resolve the existing Undercurrent connection.')
      undercurrent = { home: settings.effective.home, profile: settings.effective.profile || settings.active_profile }
    } catch { issue = 'The existing Undercurrent connection could not be inspected. Repair it or choose a separate Suite installation.' }
  }
  const found = data.length > 0 || tools.length > 0 || existsSync(undercurrent.home) || Boolean(undercurrent.profile && undercurrent.profile !== 'default')
  const configSources = [...new Set([managers.AGENT_MANAGER_CONFIG])].filter(path => existsSync(path))
  return { schema: 1, found, issue, managers, data, tools, undercurrent, saved: readInstallationPlan(base),
    copyableSettings: configSources.map(source => ({ source, destination: join(base, 'config/providers.toml'), label: 'Provider definitions (can include credentials and external paths)' })),
    productPrefix: sharedProductPrefix({ ...input, ...env }) }
}

export async function saveInstallationPlan(root, input, base, mode, settings = mode === 'isolated' ? 'fresh' : 'reuse') {
  if (!['shared', 'isolated'].includes(mode)) throw new Error('Choose shared or isolated installation.')
  if (mode === 'isolated' ? !['fresh', 'copy'].includes(settings) : settings !== 'reuse')
    throw new Error('Isolated setup uses fresh or copied settings. Shared setup reuses shared settings.')
  const previous = readInstallationPlan(base)
  if (previous) {
    if (previous.mode !== mode) throw new Error('Changing an existing installation mode requires stopping and reviewing the workspace first.')
    return previous
  }
  const discovery = mode === 'shared' || settings === 'copy' ? await discoverInstallation(root, input, base) : null
  if (mode === 'shared' && discovery?.issue) throw new Error(discovery.issue)
  if (mode === 'shared' && [discovery.undercurrent.home, ...Object.values(discovery.managers)].some(path => path === base || inside(path, base)))
    throw new Error('The detected setup uses this Suite workspace. Choose a separate Suite installation to retain workspace ownership.')
  let ucProgram = null
  const existingUc = mode === 'shared' && discovery?.tools.find(tool => tool.name === 'uc')
  if (existingUc && existsSync(join(root, 'bin', binary('uc')))) {
    const probe = program => execute(program, ['--version'], { env: { ...process.env, ...userEnvironment(input) }, timeout: 15000, windowsHide: true }).then(result => result.stdout.trim())
    const [existing, bundled] = await Promise.all([probe(existingUc.path), probe(join(root, 'bin', binary('uc')))])
    if (existing !== bundled) throw new Error('The existing Undercurrent version differs from this Suite release. Update it or choose a separate Suite installation.')
    ucProgram = existingUc.path
  }
  const user = userEnvironment(input), home = user.HOME || user.USERPROFILE
  const selectedManagers = mode === 'shared' ? discovery.managers : {}
  const directories = Object.fromEntries(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'].map((key, index) =>
    [key, user[key] || join(home, ['.config', '.local/share', '.local/state', '.cache'][index])]))
  const reusedProducts = {}
  for (const row of mode === 'shared' ? productCatalog(root)?.assemblies || [] : []) {
    for (const [id, product] of Object.entries(row.products)) {
      const selected = discovery.tools.filter(tool => product.commands.includes(tool.name))
      if (selected.length === product.commands.length && selected.some(tool => tool.primary) && selected.filter(tool => tool.primary).every(tool => tool.compatible) &&
          selected.every(tool => !inside(realpathSync(tool.path), sharedProductPrefix({ ...input, HOME: home }))))
        reusedProducts[id] = { version: product.version, commands: Object.fromEntries(selected.map(tool => [tool.name, tool.path])) }
    }
  }
  const plan = { schema: 2, instanceId: instanceId(base), mode, settings, reusedProducts,
    managerRoot: mode === 'shared' && user.AIXAND_MANAGER_ROOT ? resolve(user.AIXAND_MANAGER_ROOT.replace(/^~(?=\/|$)/, home)) : null,
    userPath: mode === 'shared' ? user.PATH || '' : '',
    managers: selectedManagers,
    userDirectories: mode === 'shared' ? directories : {},
    undercurrent: mode === 'shared' ? { ...discovery.undercurrent, program: ucProgram, owned: false } : { home: join(base, 'uc'), profile: null, owned: true },
  }
  if (Object.values(plan.managers).some(path => !isAbsolute(path))) throw new Error('Manager locations must be absolute.')
  await mkdir(join(base, 'config'), { recursive: true, mode: 0o700 })
  if (settings === 'copy') {
    if (!discovery.copyableSettings.length) throw new Error('No supported settings were found to copy. Choose fresh settings.')
    const item = discovery.copyableSettings[0]
    if (!(await lstat(item.source)).isFile() || realpathSync(item.source) !== resolve(item.source) ||
        realpathSync(join(base, 'config')) !== resolve(base, 'config'))
      throw new Error('Settings copy requires regular files and real directories.')
    const content = await readFile(item.source)
    if (content.length > 2 * 1024 * 1024) throw new Error('The provider settings file is too large to copy.')
    await writeFile(item.destination, content, { mode: 0o600, flag: 'wx' })
    plan.settingsReport = 'Copied provider definitions. External paths are unchanged. Accounts, databases and runtime connections were not copied.'
  }
  plan.actions = (productCatalog(root)?.assemblies || []).flatMap(row => Object.entries(row.products).map(([id]) => ({ name: id,
    action: reusedProducts[id] ? 'Reuse compatible tool' : mode === 'isolated' ? 'Install private tool' : 'Install independent tool',
    path: reusedProducts[id] ? Object.values(reusedProducts[id].commands)[0] : mode === 'isolated' ? join(base, 'software/products') : sharedProductPrefix({ ...input, HOME: home }) })))
  const temporary = planPath(base) + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(temporary, planPath(base))
  return plan
}

export function ownsSession(config, item) {
  if (!config.plan || config.plan.undercurrent.owned) return true
  return item.labels?.['suite.instance'] === config.plan.instanceId
}
