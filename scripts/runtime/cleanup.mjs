// Local-only, explicit component removal. Preview never creates workspace data.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve, parse } from 'node:path'
import { inside, pythonPath, binary } from './platform.mjs'
import { sharedProductPrefix, productStatus, removeSharedProducts } from './products.mjs'
import { removeUcConnection } from './uc-connections.mjs'

const execute = promisify(execFile)
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const productNames = {
  undercurrent: 'Undercurrent', runner: 'Runner', carrier: 'Carrier',
  ...Object.fromEntries(['agent-manager', 'prompt-manager', 'skill-manager', 'mcp-manager', 'server-manager', 'orchestration-mcp']
    .map(name => ['manager-suite/' + name, name])),
}

// Do not traverse a relocated workspace, junction, or symlink on the way to a
// removal target. A symlink at the target itself is unlinked, never followed.
export function guardPath(path, boundary) {
  path = resolve(path); boundary = resolve(boundary)
  if (path === boundary || !inside(path, boundary)) throw new Error('Cleanup target is outside its component directory.')
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
      throw new Error('Cleanup cannot traverse a symbolic link or junction: ' + parent)
    if (parent === parse(parent).root) break
  }
  return path
}

function workspacePaths(base) {
  const children = path => existsSync(path) ? readdirSync(path).map(name => join(path, name)) : []
  const ownedNames = new Set(['auth', 'chats', 'scratch', 'uc', 'carrier', 'runner', 'vox', 'prompts', 'skills', 'mcps', 'servers',
    'workflow-runs', 'workflows.sock', 'logs', 'runtime.json'])
  const ownedConfig = new Set(['runtime.env', 'workflow-runtime.json', 'setup.json', 'product-installation.json', 'product-installation.json.lock'])
  return [
    ...children(base).filter(path => ownedNames.has(path.slice(base.length + 1))),
    ...children(join(base, 'config')).filter(path => ownedConfig.has(path.slice(join(base, 'config').length + 1))),
    ...children(join(base, 'state')).filter(path => !['agent-manager', 'opencode'].includes(path.slice(join(base, 'state').length + 1))),
    ...children(join(base, 'data')).filter(path => path !== join(base, 'data/opencode')),
    ...children(join(base, 'cache')).filter(path => path !== join(base, 'cache/opencode')),
  ]
}

async function providers(config, action = 'plan', options = {}) {
  const env = { ...config.env,
    AIXAND_USER_XDG_DATA_HOME: config.input.XDG_DATA_HOME || join(config.env.HOME, '.local/share'),
    AIXAND_USER_XDG_CONFIG_HOME: config.input.XDG_CONFIG_HOME || join(config.env.HOME, '.config'),
    AIXAND_USER_XDG_STATE_HOME: config.input.XDG_STATE_HOME || join(config.env.HOME, '.local/state'),
    AIXAND_USER_XDG_CACHE_HOME: config.input.XDG_CACHE_HOME || join(config.env.HOME, '.cache'),
  }
  delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV
  // Python/official logout may need a temporary directory after services stop.
  // Use the OS temp directory, so a cleanup never deletes its own scratch files.
  delete env.TEMP; delete env.TMP
  const operation = execute(pythonPath(join(config.root, 'python')),
    ['-I', '-B', join(config.root, 'provider-cleanup.py'), action],
    { env, windowsHide: true, timeout: 300_000, maxBuffer: 2 * 1024 * 1024 })
  // Keep large path lists off Windows' command line, and never expose them in
  // process arguments. execFile's promisified promise exposes its child.
  operation.child.stdin.on('error', () => {}) // An early process exit is reported below.
  operation.child.stdin.end(JSON.stringify(options))
  const result = await operation.catch(error => { throw new Error(error.stderr?.trim() || error.message) })
  return JSON.parse(result.stdout)
}

export async function cleanupPlan(config, dependencies = {}) {
  const base = resolve(config.base), home = resolve(config.env.HOME)
  if ([parse(base).root, home, resolve(config.root)].includes(base) || inside(config.root, base))
    throw new Error('The workspace directory is not safe for component cleanup.')
  guardPath(join(base, '.cleanup-target'), base)
  const installation = productStatus(config.root, { ...config.input, HOME: home }, base)
  if (['starting', 'running', 'activating'].includes(installation.job?.status))
    throw new Error('Wait for the current product installation to finish before removing components.')
  const provider = await (dependencies.providers || providers)(config)
  const providerItems = provider.items.map(item => {
    const name = item.id.startsWith('native:') ? item.id.slice(7) : null
    return !item.available && ['codex', 'claude'].includes(name) && !provider.items.some(row => row.id === 'provider:' + name)
      ? { ...item, recovery: { provider: name, label: 'Restore official ' + (name === 'codex' ? 'Codex' : 'Claude') + ' CLI (shared)' } } : item
  })
  const privateAccounts = !config.env.AGENT_MANAGER_HOME || resolve(config.env.AGENT_MANAGER_HOME) === join(base, 'agents')
  const items = [
    { id: 'workspace', group: 'Aixand', label: 'Workspace data and password', shared: false, available: true,
      description: 'Delete chats, terminal records, workspace password, onboarding, manager resources, local caches and settings. Project folders are kept. Provider accounts and software have separate choices.', paths: [base] },
    { id: 'provider-accounts', group: 'Providers', label: 'Aixand provider accounts and settings', shared: false, available: true,
      description: 'Sign out Aixand-owned Claude accounts and delete private managed profiles, saved accounts, API keys and provider configuration. Shared native provider logins have separate choices.' + (privateAccounts ? '' : ' Reused external manager accounts are kept; remove those through Agent Manager.'),
      paths: [join(base, 'agents'), join(base, 'config/providers.toml'), ...['data', 'config', 'state', 'cache'].map(kind => join(base, kind, 'opencode'))] },
    ...providerItems,
    { id: 'provider-runtime', group: 'Providers', label: 'Downloaded provider SDKs', shared: false, available: true,
      description: 'Delete downloaded provider SDKs. Provider CLIs and their accounts have separate choices. Included application files are removed with the app.',
      paths: [join(base, 'agents/provider-sdks')] },
    { id: 'provider-tool-store', group: 'Providers', label: 'Private provider tool store and install records', shared: false, available: true,
      description: 'Delete Aixand’s private npm/uv tool directory and provider installation records. Also select any provider CLIs installed in this directory; otherwise this choice cannot proceed.',
      paths: [join(base, 'tools'), join(base, 'state/agent-manager')],
      requires: provider.items.filter(item => item.id.startsWith('provider:') && item.paths?.some(path => inside(path, join(base, 'tools')))).map(item => item.id) },
  ]
  const prefix = sharedProductPrefix({ ...config.input, HOME: home })
  if (inside(prefix, base) || inside(base, prefix) || inside(base, config.root))
    throw new Error('Workspace and independent software directories must be separate.')
  const receiptPath = join(prefix, 'installation-receipt.json')
  let receipt = null
  if (existsSync(receiptPath)) {
    guardPath(receiptPath, prefix)
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    if (receipt.schema !== 2 || receipt.scope !== 'shared' || receipt.owner !== 'user')
      throw new Error('Independent tool ownership could not be verified.')
    for (const [id, label] of Object.entries(productNames)) if (receipt.products[id]) items.push({
      id: 'product:' + id, group: 'Independent tools', label, shared: true, available: true,
      description: 'Uninstall this shared product for your account. Other applications using it will need it reinstalled. Its separate data is kept. Stop its processes before continuing.', paths: [prefix],
    })
  }
  // Identity binds the review to this installation and these software receipts.
  // Chat activity is intentionally not part of it: stopping a workspace changes it.
  return { schema: 1, revision: hash({ base, root: config.root, prefix, receipt, items, providerRevision: provider.revision }), items,
    notice: 'Nothing is selected by default. Selected data is permanently deleted. Shared components affect other applications. Personal project folders and unrelated installations are kept.' }
}

export async function restoreCleanupProvider(config, options, dependencies = {}) {
  if (options?.confirmed !== true || !['codex', 'claude'].includes(options.provider))
    throw new Error('Confirm the shared provider CLI restoration.')
  const plan = await cleanupPlan(config, dependencies)
  if (plan.revision !== options.revision) throw new Error('Installed components changed. Refresh the checklist before restoring the CLI.')
  if (!plan.items.some(item => item.recovery?.provider === options.provider))
    throw new Error('This provider no longer needs CLI restoration. Refresh the checklist.')
  if (!dependencies.install) throw new Error('The provider installation adapter is unavailable.')
  await dependencies.install(config, options.provider)
  return { restored: options.provider, refreshRequired: true }
}

async function reviewedSelection(config, options, dependencies) {
  if (options?.confirmed !== true || !Array.isArray(options.selected) || !options.selected.length ||
      options.selected.some(id => typeof id !== 'string') || new Set(options.selected).size !== options.selected.length)
    throw new Error('Review the component checklist and confirm the selected removals.')
  const plan = await cleanupPlan(config, dependencies)
  if (plan.revision !== options.revision) throw new Error('Installed components changed. Refresh the checklist and review your choices again.')
  const selected = new Set(options.selected)
  if (options.selected.some(id => !plan.items.some(item => item.id === id && item.available)))
    throw new Error('An unknown or unavailable cleanup component was selected.')
  for (const item of plan.items) if (selected.has(item.id) && item.requires?.some(id => !selected.has(id)))
    throw new Error('Also select the provider CLIs in the private tool store before deleting that directory.')
  const prefix = sharedProductPrefix({ ...config.input, HOME: config.env.HOME })
  const receiptPath = join(prefix, 'installation-receipt.json')
  if (existsSync(receiptPath)) {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    for (const [id, entry] of Object.entries(receipt.products))
      if (!selected.has('product:' + id) && Object.keys(entry.dependency_releases || {}).some(dependency => selected.has('product:' + dependency)))
        throw new Error('Keep ' + id + ' requires keeping its selected dependencies.')
  }
  return { plan, selected, prefix }
}

function processTargets(config, selected, prefix) {
  const targets = []
  const add = (component, paths) => targets.push(...paths.map(path => ({ component, path })))
  if (selected.has('workspace')) add('workspace', [...workspacePaths(resolve(config.base)), join(config.base, 'config/uc-cli-connection.json')])
  if (selected.has('provider-runtime')) add('provider-runtime', [join(config.base, 'agents/provider-sdks')])
  if (selected.has('provider-tool-store')) add('provider-tool-store', [join(config.base, 'tools'), join(config.base, 'state/agent-manager')])
  if ([...selected].some(id => id.startsWith('product:'))) {
    const receipt = JSON.parse(readFileSync(join(prefix, 'installation-receipt.json'), 'utf8'))
    for (const id of selected) if (id.startsWith('product:')) {
      const name = id.slice(8), entry = receipt.products[name]
      // Removal includes this product's retired payloads, but no other product
      // or shared interpreter. Never scan the entire independent store.
      const paths = [guardPath(join(prefix, 'payloads', name), prefix)]
      for (const command of Object.keys(entry.product?.commands || {})) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(command)) throw new Error('Invalid installed product command.')
        paths.push(guardPath(join(prefix, 'bin', binary(command)), prefix))
      }
      add(id, paths)
    }
  }
  return targets
}

async function inspectProcesses(config, options, dependencies, selected, prefix, stopping = false, repairing = false) {
  const report = await (dependencies.providers || providers)(config, repairing ? 'repair-permissions' : stopping ? 'stop-processes' : 'preflight', {
    selected: options.selected, targets: processTargets(config, selected, prefix),
    protectedPids: [process.pid, process.ppid],
    ...(stopping ? { confirmed: true, reviewed: options.reviewed, force: options.force === true, forceConfirmed: options.forceConfirmed === true } : {}),
    ...(repairing ? { confirmed: true, reviewedPermissions: options.reviewedPermissions } : {}),
  })
  if (!Array.isArray(report.blockers) || !Array.isArray(report.errors)) throw new Error('Could not check applications using the selected components. Nothing was removed.')
  return { ...report, blocked: report.blockers.length > 0 || report.errors.length > 0, completed: [], failed: null }
}

export async function stopCleanupProcesses(config, options, dependencies = {}) {
  const { selected, prefix } = await reviewedSelection(config, options, dependencies)
  if (!Array.isArray(options.reviewed) || !options.reviewed.length || options.force === true && options.forceConfirmed !== true)
    throw new Error('Review the listed applications and confirm before stopping them.')
  await dependencies.stop(config)
  return dependencies.locked(config, () => inspectProcesses(config, options, dependencies, selected, prefix, true))
}

export async function repairCleanupPermissions(config, options, dependencies = {}) {
  const { selected, prefix } = await reviewedSelection(config, options, dependencies)
  if (!Array.isArray(options.reviewedPermissions) || !options.reviewedPermissions.length)
    throw new Error('Review the files requiring administrator access first.')
  await dependencies.stop(config)
  return dependencies.locked(config, () => inspectProcesses(config, options, dependencies, selected, prefix, false, true))
}

export async function applyCleanup(config, options, dependencies = {}) {
  const { plan, selected, prefix } = await reviewedSelection(config, options, dependencies)
  const completed = []
  // Stop and lock are supplied by the runtime, never by JSON from a caller.
  await dependencies.stop(config)
  return dependencies.locked(config, async () => {
    // No logout, data deletion or product receipt mutation until selected files
    // have been checked. Shared applications require their own reviewed action.
    const preflight = await inspectProcesses(config, options, dependencies, selected, prefix)
    if (preflight.blocked) return preflight
    const remove = async path => { guardPath(path, config.base); await rm(path, { recursive: true, force: true }) }
    try {
      // Log out through official provider APIs before removing any credentials or CLI.
      const providerIds = options.selected.filter(id => id.startsWith('provider:') || id.startsWith('native:') || id === 'provider-accounts')
      if (providerIds.length) {
        const report = await (dependencies.providers || providers)(config, 'apply', { selected: providerIds })
        completed.push(...report.completed)
        if (report.failed) throw new Error(report.failed)
      }
      if (selected.has('provider-runtime')) {
        await remove(join(config.base, 'agents/provider-sdks'))
        completed.push('provider-runtime')
      }
      if (selected.has('provider-tool-store')) {
        for (const path of [join(config.base, 'tools'), join(config.base, 'state/agent-manager')]) await remove(path)
        completed.push('provider-tool-store')
      }
      if (selected.has('workspace')) {
        await (dependencies.removeUcConnection || removeUcConnection)(config.tools.uc, config.input, config.base)
        for (const path of workspacePaths(resolve(config.base))) await remove(path)
        await remove(join(config.base, 'config/uc-cli-connection.json'))
        completed.push('workspace')
      }
      // Private products are handled by the OS uninstaller. Explicit shared
      // products are removed individually through their existing receipt engine.
      const products = options.selected.filter(id => id.startsWith('product:'))
      if (products.length) {
        const report = await (dependencies.removeSharedProducts || removeSharedProducts)(config.root, config.input, config.base, products.map(id => id.slice(8)))
        completed.push(...report.completed)
        if (report.failed) throw new Error(report.failed)
      }
      return { completed, failed: null, kept: plan.items.filter(item => !selected.has(item.id)).map(item => item.id) }
    } catch (error) {
      // Completed deletions cannot be rolled back. Return exact partial progress.
      return { completed, failed: 'Some files in unfinished components may already have been removed. ' + String(error.message),
        kept: plan.items.filter(item => !selected.has(item.id)).map(item => item.id),
        incomplete: options.selected.filter(id => !completed.includes(id)) }
    }
  })
}
