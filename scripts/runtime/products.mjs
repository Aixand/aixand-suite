// Schema-2 product installations. Suite API libraries remain in Suite's own Python.
import { spawn, execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readlink, lstat, realpath, rename, symlink, writeFile, open, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { binary, pythonPath, pythonSite, cliDirectory, windows, inside, addUserPath } from './platform.mjs'
import { readInstallationPlan } from './installation-plan.mjs'
import { registerUcConnection, ucConnectionStatus } from './uc-connections.mjs'
import { resolveProductCatalog, productArtifactPath } from './product-selection.mjs'
import { compareProductVersions } from './product-feed.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const labels = { undercurrent: 'Undercurrent', runner: 'Runner', carrier: 'Carrier', 'agent-manager': 'Agent Manager', 'conversation-manager': 'Conversation Manager',
  'mcp-manager': 'MCP Manager', 'prompt-manager': 'Prompt Manager', 'skill-manager': 'Skill Manager', 'orchestration-mcp': 'Orchestration MCP' }

export function processBirth(root, pid) {
  try {
    if (process.platform === 'linux') {
      const value = readFileSync('/proc/' + pid + '/stat', 'utf8')
      const fields = value.slice(value.lastIndexOf(')') + 1).trim().split(/\s+/)
      return fields[0] === 'Z' ? null : readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + fields[19]
    }
    return JSON.parse(execFileSync(pythonPath(join(root, 'python')), ['-I', '-B', '-c',
      'import json,sys; from aixand_local_runtime import process_start; print(json.dumps(process_start(int(sys.argv[1]))))', String(pid)],
    { encoding: 'utf8', timeout: 5000, windowsHide: true }))
  } catch { return null }
}

export function sharedProductPrefix(input) {
  const prefix = input.AIXAND_SHARED_PRODUCT_PREFIX || (windows
    ? join(input.LOCALAPPDATA || join(input.HOME, 'AppData/Local'), 'Aixand/products')
    : process.platform === 'darwin' ? join(input.HOME, 'Library/Application Support/Aixand/products')
      : join(input.XDG_DATA_HOME || join(input.HOME, '.local/share'), 'aixand/products'))
  if (!isAbsolute(prefix) || prefix.includes('\0')) throw new Error('The shared product prefix must be absolute.')
  return resolve(prefix)
}

export function productCatalog(root) {
  const manifestPath = join(root, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  const installation = JSON.parse(readFileSync(manifestPath, 'utf8')).installation
  if (!installation) return null
  if (installation.schema !== 1 || installation.edition !== 'distributed')
    throw new Error('Unsupported Suite installation edition.')
  if (installation.role && !['desktop', 'server'].includes(installation.role)) throw new Error('Unsupported Aixand package role.')
  const path = join(root, 'products/catalog.json'), bytes = readFileSync(path)
  if (sha(bytes) !== installation.catalogSha256) throw new Error('Product catalog integrity check failed.')
  const value = JSON.parse(bytes)
  const target = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform] + '-' +
    ({ x64: 'x86_64', arm64: 'arm64' }[process.arch]) +
    (process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : '')
  if (value.schema !== 1 || value.target !== target || value.assemblies.length !== 9 ||
      new Set(value.assemblies.map(row => row.id)).size !== value.assemblies.length ||
      value.assemblies.some(row => !labels[row.id] || row.artifact !== 'artifacts/' + row.id))
    throw new Error('The product kit does not match this computer.')
  const required = Object.keys(labels)
  if (required.some(id => !value.assemblies.some(row => row.id === id)))
    throw new Error('The product kit is incomplete.')
  for (const [name, digest] of Object.entries(value.consumer)) {
    if (!/^consumer\/[A-Za-z0-9_.-]+$/.test(name) || sha(readFileSync(join(root, 'products', name))) !== digest)
      throw new Error('Installer engine integrity check failed.')
  }
  return { ...value, ...installation, runtimeBuild: JSON.parse(readFileSync(manifestPath, 'utf8')).build, digest: sha(bytes) }
}

export function productLocation(root, input, base) {
  const baseline = productCatalog(root)
  if (!baseline) return null
  const catalog = resolveProductCatalog(base, baseline)
  const plan = readInstallationPlan(base)
  const mode = plan ? (plan.mode === 'isolated' ? 'bundled' : 'system') : 'unconfigured'
  const prefix = mode !== 'system' ? join(base, 'software/products') : sharedProductPrefix(input)
  if (mode === 'system' && (inside(prefix, root) || inside(prefix, base)))
    throw new Error('Shared products must live outside the Suite installation and workspace.')
  return { catalog, baseline, mode, scope: mode !== 'system' ? 'private' : 'shared',
    owner: mode !== 'system' ? 'aixand-suite' : 'user',
    prefix }
}

function receiptAt(prefix) {
  const path = join(prefix, 'installation-receipt.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

export function productStatus(root, input, base) {
  const location = productLocation(root, input, base)
  if (!location) return { available: false, ready: true }
  const { catalog, prefix, scope, owner } = location, receipt = receiptAt(prefix)
  if (receipt && (receipt.schema !== 2 || receipt.scope !== scope || receipt.owner !== owner))
    throw new Error('The product installation belongs to a different owner.')
  const plan = readInstallationPlan(base)
  const reused = plan?.reusedProducts || {}
  const assemblies = catalog.assemblies.map(row => ({
    id: row.id, name: labels[row.id], versions: Object.values(row.products).map(p => p.version),
    currentVersions: Object.keys(row.products).map(id => reused[id]?.version || receipt?.products[id]?.product?.version).filter(Boolean),
    installed: Boolean(plan) && Object.entries(row.products).every(([id, product]) => receipt?.products[id]?.product?.release === product.release ||
      reused[id]?.version === product.version && product.commands.every(name => existsSync(reused[id].commands[name] || ''))),
    reused: Object.keys(row.products).filter(id => reused[id]),
  }))
  let job = null
  const path = join(base, 'config/product-installation.json')
  if (existsSync(path)) {
    job = JSON.parse(readFileSync(path, 'utf8'))
    if (job.catalog !== catalog.digest) job = null
    if (job && ['starting', 'running', 'activating'].includes(job.status) && job.pid) {
      if (!job.birth || job.birth !== processBirth(root, job.pid))
        job = { ...job, status: 'interrupted', message: 'Setup was interrupted. Retry to resume the installed products.' }
    }
  }
  const ucConnection = plan && !plan.undercurrent.owned ? { ...plan.undercurrent, verified: true } : scope === 'shared' ? ucConnectionStatus(base) : null
  return { available: true, setupMode: plan?.mode, edition: catalog.edition, ready: assemblies.every(row => row.installed),
    role: catalog.role || 'desktop',
    connectionSetupRequired: scope === 'shared' && !ucConnection, ucConnection,
    commandSetupRequired: scope === 'shared' && windows && input.AIXAND_SKIP_PATH_REGISTRATION !== '1' && !job?.terminal?.registered,
    prefix, mode: location.mode, scope, assemblies, licenses: catalog.assemblies.flatMap(row => row.licenses), job,
    cliDirectory: scope === 'shared' ? windows ? join(prefix, 'bin') : cliDirectory(input) : null }
}

export function installedProductTools(root, input, base) {
  const status = productStatus(root, input, base)
  if (!status.available || !status.ready) return null
  const receipt = receiptAt(status.prefix), bin = join(status.prefix, 'bin')
  const commands = Object.fromEntries(Object.values(receipt?.products || {}).flatMap(entry =>
    Object.keys(entry.product.commands).map(name => [name, join(bin, binary(name))])))
  for (const product of Object.values(readInstallationPlan(base)?.reusedProducts || {})) Object.assign(commands, product.commands)
  return {
    uc: commands.uc, runner: commands.runner, bridge: commands['uc-python-bridge'],
    carrierPython: receipt?.products.carrier?.python || pythonPath(join(root, 'python')), commands, binDirectory: bin,
    // These are API dependencies of the Suite, not independent CLI installations.
    python: pythonPath(join(root, 'python')), pythonHome: join(root, 'python'),
    pythonExecutable: pythonPath(join(root, 'python')),
    pythonPrefix: join(root, 'python'), pythonBaseExecutable: pythonPath(join(root, 'python')),
    pythonPaths: [pythonSite(join(root, 'python'))], voicePython: pythonPath(join(root, 'voice/python')),
    // SDK workflows retain their existing Suite-owned worker. The independent
    // Runner product has no embedded Suite SDK and remains usable on its own.
    workflowRunner: join(root, 'bin', binary('runner')), productPrefix: status.prefix,
  }
}

async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}

async function consumer(root, args, onEvent) {
  const python = pythonPath(join(root, 'python'))
  const env = { ...process.env, PIP_NO_INDEX: '1', UV_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1' }
  delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV
  await new Promise((accept, reject) => {
    const child = spawn(python, ['-I', '-B', join(root, 'products/consumer/consumer.py'), ...args],
      { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let pending = '', diagnostic = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      pending += chunk
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1)
        try { onEvent?.(JSON.parse(line)) } catch { /* Pip and product verification also write ordinary lines. */ }
      }
    })
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-6000) })
    child.once('error', reject)
    child.once('close', code => code === 0 ? accept() : reject(new Error(diagnostic || 'Product installation failed. Retry to resume.')))
  })
}

export async function validateInstalledProducts(root, input, base) {
  const status = productStatus(root, input, base)
  if (!status.available || !status.ready) throw new Error('Product setup is incomplete.')
  if (receiptAt(status.prefix)) await consumer(root, ['inspect', '--prefix', status.prefix])
  const reused = readInstallationPlan(base)?.reusedProducts || {}
  for (const product of Object.values(reused)) {
    const primary = Object.entries(product.commands).find(([name]) => ['uc', 'runner', 'carrier', 'agent', 'prompt-manager', 'skill-manager', 'mcp-manager', 'conversation-manager', 'orchestration-mcp'].includes(name))
    if (!primary) throw new Error('The reused tool selection is incomplete. Run setup again.')
    const result = await promisify(execFile)(primary[1], ['--version'], { env: input, windowsHide: true, timeout: 15000, maxBuffer: 65536 })
    if (!result.stdout.trim().split(/\s+/).map(value => value.replace(/^v/, '').replace(/b0$/, '-beta')).includes(product.version))
      throw new Error('A reused tool changed version: ' + primary[0] + '. Repair the shared tool selection.')
  }
}

async function commandReport(root, prefix, input, names, policy) {
  const args = ['-I', '-B', join(root, 'products/consumer/consumer.py'), 'commands', '--prefix', prefix,
    ...names.flatMap(name => ['--command', name]),
    ...(policy ? ['--register-path', '--command-policy', policy] : [])]
  const env = { ...process.env, ...input, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
  delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV
  const result = await promisify(execFile)(pythonPath(join(root, 'python')), args,
    { env, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 })
  return JSON.parse(result.stdout)
}

export async function productCommands(root, input, base) {
  const location = productLocation(root, input, base)
  if (!location || location.scope !== 'shared') return { commands: [], userPathSupported: false }
  const versions = Object.fromEntries(location.catalog.assemblies.flatMap(row =>
    Object.values(row.products).flatMap(product => product.commands.map(name => [name, product.version]))))
  const report = await commandReport(root, location.prefix, input, Object.keys(versions))
  return { ...report, commands: report.commands.map(row => ({ ...row, suiteVersion: versions[row.name] })) }
}

async function expose(prefix, input, names) {
  if (windows) return { cliDirectory: join(prefix, 'bin'), retained: [],
    pathRegistered: input.AIXAND_SKIP_PATH_REGISTRATION !== '1' && await addUserPath(join(prefix, 'bin'), input) }
  const directory = cliDirectory(input), retained = [], canonicalPrefix = await realpath(prefix)
  await mkdir(directory, { recursive: true })
  for (const name of names) {
    const destination = join(directory, name), target = join(prefix, 'bin', name)
    let present
    try { present = await lstat(destination) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (present) {
      if (!present.isSymbolicLink() || !inside(await realpath(destination).catch(() => destination), canonicalPrefix)) {
        retained.push(destination); continue
      }
      if (await realpath(destination) === await realpath(target)) continue
      const temporary = destination + '.' + randomUUID() + '.tmp'
      await symlink(target, temporary); await rename(temporary, destination)
    } else {
      try { await symlink(target, destination) }
      catch (error) { if (error.code === 'EEXIST') retained.push(destination); else throw error }
    }
  }
  return { cliDirectory: directory, retained, pathRegistered: false }
}

export async function installProducts(root, input, base, raw = {}, activate) {
  if (!readInstallationPlan(base)) throw new Error('Choose shared or isolated setup before installing products.')
  const location = productLocation(root, input, base)
  if (!location) throw new Error('This package does not contain product installers.')
  const { catalog, prefix, scope, owner } = location
  const reused = readInstallationPlan(base)?.reusedProducts || {}
  if (scope === 'shared') for (const row of catalog.assemblies) for (const [id, product] of Object.entries(row.products)) {
    const current = receiptAt(prefix)?.products?.[id]?.product
    if (current && current.release !== product.release && compareProductVersions(product.version, current.version) <= 0)
      throw new Error('Shared ' + row.id + ' changed outside this workspace. Review its compatible selection in Updates; setup and repair will not downgrade or replace its immutable version.')
  }
  if (raw.repair !== undefined && typeof raw.repair !== 'boolean') throw new Error('Repair must be explicitly enabled or disabled.')
  const connectionVerification = raw.connectionVerification ?? (catalog.role === 'server' ? 'configuration' : 'live-daemon')
  if (!['configuration', 'live-daemon'].includes(connectionVerification)) throw new Error('Invalid Undercurrent connection verification mode.')
  if (catalog.role !== 'server' && connectionVerification === 'configuration' && raw.repair !== true)
    throw new Error('Offline connection verification requires an explicit repair.')
  const terminalPolicy = raw.terminalPolicy ?? 'keep'
  if (!['keep', 'prefer'].includes(terminalPolicy) || terminalPolicy === 'prefer' && (!windows || scope !== 'shared'))
    throw new Error('Choose a supported terminal command policy.')
  const accepted = raw.acceptedLicenses ?? []
  if (!Array.isArray(accepted) || accepted.some(value => !/^[a-f0-9]{64}$/.test(value)))
    throw new Error('Invalid license acceptance.')
  const required = catalog.assemblies.flatMap(row => row.licenses)
  if (required.some(license => !accepted.includes(license.sha256)))
    throw new Error('Review and accept the included product terms before continuing.')
  const jobPath = join(base, 'config/product-installation.json')
  const previous = productStatus(root, input, base).job
  if (previous && ['starting', 'running', 'activating'].includes(previous.status) && previous.pid !== process.pid)
    throw new Error('A product installation is already in progress.')
  await mkdir(dirname(jobPath), { recursive: true, mode: 0o700 })
  const lock = jobPath + '.lock'
  let held
  try { held = await open(lock, 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = JSON.parse(await readFile(lock, 'utf8') || 'null')
    let stale = false
    if (owner?.pid) stale = !owner.birth || owner.birth !== processBirth(root, owner.pid)
    else if (typeof owner === 'number') stale = true // Pre-release PID-only lock.
    else stale = Date.now() - (await stat(lock)).mtimeMs > 120_000
    if (!stale) throw new Error('A product installation is already in progress.')
    await rm(lock)
    held = await open(lock, 'wx', 0o600)
  }
  const birth = processBirth(root, process.pid)
  if (!birth) { await held.close(); await rm(lock); throw new Error('Cannot identify the installer process.') }
  await held.writeFile(JSON.stringify({ pid: process.pid, birth })); await held.close()
  const job = { catalog: catalog.digest, pid: process.pid, birth, status: 'running',
    product: null, completed: [], message: 'Preparing included installers.',
    repair: raw.repair === true,
    repairToken: raw.repair ? (previous?.repair && ['error', 'interrupted'].includes(previous.status) && previous.catalog === catalog.digest ? previous.repairToken : randomUUID()) : null }
  try {
    await atomic(jobPath, job)
    for (const row of catalog.assemblies) {
      job.product = row.id; job.message = 'Installing ' + labels[row.id]
      await atomic(jobPath, job)
      const current = receiptAt(prefix)
      const missing = Object.keys(row.products).filter(id => !reused[id])
      if (missing.length && (raw.repair || !missing.every(id => current?.products[id]?.product?.release === row.products[id].release))) {
        const changed = Object.entries(row.products).some(([id, product]) =>
          current?.products[id] && current.products[id].product.release !== product.release)
        const operation = raw.repair && (current?.groups?.[row.id] || current?.products?.[row.id]) ? 'reinstall' : changed ? 'upgrade' : 'install'
        const selections = missing.length !== Object.keys(row.products).length
          ? missing : [null]
        for (const selection of selections) await consumer(root, [
          selection && current?.products?.[selection] ? 'reinstall' : operation, '--artifact', productArtifactPath(root, row),
          ...(selection ? ['--product', selection] : []),
          '--expected-sha256', row.manifest_sha256, '--prefix', prefix, '--scope', scope, '--owner', owner,
          // The engine fingerprints the operation. Uninstall preserves request
          // history, so a later install must not reuse an earlier upgrade ID.
          '--request-id', 'suite-' + catalog.digest.slice(0, 20) + '-' + row.id + '-' + operation +
            (raw.repair ? '-' + job.repairToken : '') + (selection ? '-' + selection.replaceAll('/', '-') : ''), '--events', 'jsonl',
          ...required.flatMap(license => ['--accept-license', license.sha256]),
        ], event => { if (event.product) job.product = event.product })
      }
      job.completed.push(row.id); await atomic(jobPath, job)
    }
    // Check the receipt through the actual engine before publishing CLI links.
    await validateInstalledProducts(root, input, base)
    if (!productStatus(root, input, base).ready) throw new Error('Some tools are incomplete. Retry setup.')
    if (scope === 'shared' && Object.keys(receiptAt(prefix)?.products || {}).length) {
      const names = catalog.assemblies.flatMap(row => Object.entries(row.products).filter(([id]) => !reused[id]).flatMap(([, product]) => product.commands))
      if (windows && input.AIXAND_SKIP_PATH_REGISTRATION !== '1') {
        job.message = 'Registering and checking your terminal commands.'; await atomic(jobPath, job)
        job.terminal = await commandReport(root, prefix, input, names, terminalPolicy)
        job.cliDirectory = join(prefix, 'bin'); job.pathRegistered = job.terminal.registered
      } else Object.assign(job, await expose(prefix, input, names))
    }
    if (activate) {
      job.status = 'activating'; job.message = 'Connecting the installed tools to your workspace.'
      await atomic(jobPath, job)
      await activate()
    }
    if (scope === 'shared' && !readInstallationPlan(base)) {
      job.status = 'activating'; job.message = 'Configuring your Undercurrent connection profile.'
      await atomic(jobPath, job)
      job.ucConnection = await registerUcConnection(join(prefix, 'bin', binary('uc')), input, base, catalog.role || 'desktop', connectionVerification)
    }
    job.status = 'complete'; job.runningProcessesRetained = true
    job.message = scope === 'shared' ? 'Tools installed for your user account.' : 'Included tools are ready.'
    await atomic(jobPath, job)
    return { ...productStatus(root, input, base), ...job }
  } catch (error) {
    job.status = 'error'; job.message = error.message.slice(-4000)
    await atomic(jobPath, job); throw error
  } finally {
    await rm(lock, { force: true })
  }
}

export async function removePrivateProducts(root, input, base) {
  const location = productLocation(root, input, base)
  if (!location) return { sharedProductsPreserved: true }
  // The shared prefix is never a deletion target.
  const prefix = join(base, 'software/products')
  if (!existsSync(prefix)) return { removed: false, userDataPreserved: true, sharedProductsPreserved: true }
  await consumer(root, ['inspect', '--prefix', prefix])
  const receipt = receiptAt(prefix)
  if (receipt.schema !== 2 || receipt.scope !== 'private' || receipt.owner !== 'aixand-suite')
    throw new Error('Refusing to remove products owned by another installation.')
  const known = new Set(location.catalog.assemblies.flatMap(row => Object.keys(row.products)))
  let remaining = receiptAt(prefix).products
  if (Object.keys(remaining).some(name => !known.has(name))) throw new Error('Unrecognized private products were retained; review their ownership before removal.')
  // Explicit members can outlive collection removal. Retire only recognized
  // Suite-owned software, removing dependents before their pinned dependencies.
  while (Object.keys(remaining).length) {
    const name = Object.keys(remaining).find(name => !Object.entries(remaining).some(([other, entry]) => other !== name && entry.dependency_releases?.[name]))
    if (!name) throw new Error('Private product dependencies could not be resolved safely.')
    await consumer(root, ['uninstall', '--prefix', prefix, '--product', name, '--stopped'])
    remaining = receiptAt(prefix).products
  }
  if (Object.keys(receiptAt(prefix).products).length)
    throw new Error('Some private products are still installed.')
  await rm(prefix, { recursive: true })
  return { removed: true, userDataPreserved: true, sharedProductsPreserved: true }
}

// The cleanup checklist is the only caller that may explicitly remove shared
// products. Normal uninstallation continues to preserve every shared product.
export async function removeSharedProducts(root, input, base, ids) {
  const prefix = sharedProductPrefix({ ...input, HOME: input.HOME || input.USERPROFILE })
  if (inside(prefix, base) || inside(prefix, root)) throw new Error('Invalid shared product directory.')
  await consumer(root, ['inspect', '--prefix', prefix])
  const receipt = receiptAt(prefix)
  if (receipt?.schema !== 2 || receipt.scope !== 'shared' || receipt.owner !== 'user' || ids.some(id => !receipt.products[id]))
    throw new Error('The selected independent product changed or belongs to another owner.')
  const env = { ...process.env, ...input, PYTHONDONTWRITEBYTECODE: '1' }
  delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV
  const result = await promisify(execFile)(pythonPath(join(root, 'python')),
    ['-I', '-B', join(root, 'product-cleanup.py'), prefix, JSON.stringify(ids)],
    { env, windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 })
    .catch(error => { throw new Error(error.stderr?.trim() || error.message) })
  const report = JSON.parse(result.stdout)
  if (!windows) {
    const directory = cliDirectory({ ...input, HOME: input.HOME || input.USERPROFILE })
    // Remove only links that still point at this exact store's removed commands.
    // User replacements and aliases for unchecked products are preserved.
    for (const name of report.completed.flatMap(id => Object.keys(receipt.products[id.slice(8)].product.commands))) {
      const path = join(directory, name)
      try {
        if ((await lstat(path)).isSymbolicLink() &&
            resolve(dirname(path), await readlink(path)) === join(prefix, 'bin', name)) await rm(path)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  return report
}

export async function purgeSharedProductStore(root, input, base) {
  const prefix = sharedProductPrefix({ ...input, HOME: input.HOME || input.USERPROFILE })
  if (inside(prefix, base) || inside(prefix, root)) throw new Error('Invalid shared product directory.')
  const env = { ...process.env, ...input, PYTHONDONTWRITEBYTECODE: '1' }
  delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV
  const result = await promisify(execFile)(pythonPath(join(root, 'python')),
    ['-I', '-B', join(root, 'product-cleanup.py'), prefix, '--purge-store'],
    { env, windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 })
    .catch(error => { throw new Error(error.stderr?.trim() || error.message) })
  return JSON.parse(result.stdout)
}
