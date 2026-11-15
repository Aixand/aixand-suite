import { withRequestLock, reserveActivation } from './activation.mjs'
// Shared update policy. Only bundled public keys and signed releases select code.
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, open, rm, stat, lstat, cp, readdir, statfs, realpath } from 'node:fs/promises'
import { dirname, join, basename, resolve } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const ownRoot = dirname(fileURLToPath(import.meta.url))
const day = 86_400_000
const active = new Set(['downloading', 'preparing', 'installing', 'restarting'])
const hash = value => createHash('sha256').update(value).digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
const require = (condition, message) => { if (!condition) throw new Error(message) }
export const updateFiles = ['activation.mjs', 'updates.mjs', 'update-worker.mjs', 'update-config.json']

export async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.new'
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}
async function json(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}
export function artifactTarget(platform = process.platform, architecture = process.arch) {
  const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[platform]
  const arch = { x64: 'x86_64', x86_64: 'x86_64', arm64: 'arm64', aarch64: 'arm64' }[architecture]
  require(os && arch, 'Updates are unavailable for this operating system or architecture.')
  return os + '-' + arch
}
export function verifyRelease(envelope, trust, { product, floor = 0, now = Date.now() } = {}) {
  require(envelope?.schema === 1 && typeof envelope.payload === 'string' && envelope.payload.length <= 1024 * 1024 &&
    typeof envelope.signature === 'string' && envelope.signature.length < 256 && typeof envelope.keyId === 'string', 'Invalid signed release metadata.')
  const key = trust.keys?.[envelope.keyId]
  require(typeof key === 'string', 'The release was signed by an unknown key.')
  const publicKey = createPublicKey(key)
  require(publicKey.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(envelope.payload), publicKey, Buffer.from(envelope.signature, 'base64')),
    'Release signature verification failed.')
  const release = JSON.parse(envelope.payload)
  require(release.schema === 1 && release.apiProtocol === 1 && release.product === product && Number.isSafeInteger(release.sequence) && release.sequence > 0 &&
    release.sequence >= floor && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version), 'Invalid release identity or an older release was offered.')
  const pathVersion = release.version + (release.version.includes('-') ? '.' : '-') + 'r' + release.sequence
  require(release.pathVersion === pathVersion, 'Invalid immutable release path.')
  const published = Date.parse(release.publishedAt), issued = Date.parse(release.issuedAt), expires = Date.parse(release.expiresAt)
  require(Number.isFinite(published) && Number.isFinite(issued) && published <= issued && issued <= now + 300_000 && expires > now && expires > issued && expires - issued <= 90 * day,
    'Release metadata is expired or has invalid dates.')
  require(typeof release.notes === 'string' && release.notes.length <= 32_000 && release.artifacts && typeof release.artifacts === 'object' && !Array.isArray(release.artifacts), 'Invalid release description.')
  for (const [target, artifact] of Object.entries(release.artifacts)) {
    require(artifact.releaseSequence === undefined || Number.isSafeInteger(artifact.releaseSequence) && artifact.releaseSequence > 0
      && artifact.releaseSequence <= release.sequence, 'Invalid application package sequence.')
    require(/^(windows|macos|linux)-(x86_64|arm64)(?:-(deb|rpm))?$/.test(target) && artifact &&
      /^[a-f0-9]{64}$/.test(artifact.sha256) && /^[a-f0-9]{64}$/.test(artifact.build) &&
      Number.isSafeInteger(artifact.size) && artifact.size > 0 && artifact.size <= 8 * 1024 ** 3 &&
      (product === 'aixand-client' ? ['nsis', 'macos-dmg', 'macos-pkg', 'deb', 'rpm'] : ['server-setup', 'nsis', 'macos-app', 'deb', 'rpm']).includes(artifact.kind), 'Invalid update artifact.')
    const url = new URL(artifact.url), origin = new URL(trust.origin)
    require(url.protocol === 'https:' && url.origin === origin.origin && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.startsWith('/' + product + '/' + pathVersion + '/') && url.pathname.split('/').length === 4 &&
      /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(basename(url.pathname)) && url.pathname.length <= 512, 'Update files must come from the configured release origin.')
    const extension = { nsis: '.exe', 'macos-app': '.tar.gz', 'macos-dmg': '.dmg', 'macos-pkg': '.pkg', deb: '.deb', rpm: '.rpm' }[artifact.kind]
    require(!extension || url.pathname.endsWith(extension), 'Update artifact format does not match its file.')
    require(product === 'aixand-server' ? artifact.kind === 'server-setup' : artifact.kind !== 'server-setup', 'Update artifact has the wrong application role.')
    require(Array.isArray(artifact.licenses) && artifact.licenses.length <= 32 && artifact.licenses.every(license =>
      typeof license.product === 'string' && typeof license.text === 'string' && license.text.length <= 100_000 && hash(license.text) === license.sha256), 'Invalid release license inventory.')
    require(Array.isArray(artifact.products) && artifact.products.length <= 32 && artifact.products.every(row =>
      typeof row.id === 'string' && typeof row.version === 'string' && /^[a-f0-9]{64}$/.test(row.release)), 'Invalid shared product inventory.')
    require(product !== 'aixand-client' || artifact.products.length === 0, 'Client cannot install backend products.')
    const os = target.split('-')[0]
    require(artifact.kind === 'server-setup' || os === 'windows' && artifact.kind === 'nsis' || os === 'macos' && (product === 'aixand-client' ? ['macos-dmg', 'macos-pkg'].includes(artifact.kind) : artifact.kind === 'macos-app') ||
      os === 'linux' && target.endsWith('-' + artifact.kind) && ['deb', 'rpm'].includes(artifact.kind), 'Update artifact does not match its target.')
  }
  require(Object.keys(release.artifacts).length > 0 && Object.keys(release.artifacts).length <= 32, 'The release contains no supported packages.')
  // Feed freshness can be renewed without inventing a new application release.
  const { issuedAt, expiresAt, ...identity } = release
  return { ...release, digest: hash(JSON.stringify(canonical(identity))) }
}

async function layout(config) {
  const manifest = await json(join(config.root, 'manifest.json'), null)
  const role = manifest?.installation?.role || manifest?.role
  const trust = await json(join(config.root, 'update-config.json'), { enabled: false })
  if (trust.enabled) {
    const url = new URL(trust.origin)
    require(trust.schema === 1 && url.protocol === 'https:' && url.origin === trust.origin && Object.keys(trust.keys || {}).length > 0,
      'The installed update configuration is invalid.')
    require(Object.values(trust.keys).every(key => typeof key === 'string' && key.startsWith('-----BEGIN PUBLIC KEY-----') && !key.includes('PRIVATE KEY')),
      'Only public verification keys belong in an installed update configuration.')
  }
  const identity = { version: manifest?.version || '0.1.0-beta', sequence: manifest?.releaseSequence || 0, build: manifest?.build || '', role,
    target: artifactTarget(), product: role === 'server' ? 'aixand-server' : 'aixand-desktop' }
  if (trust.enabled) require(Number.isSafeInteger(identity.sequence) && identity.sequence > 0 && /^[a-f0-9]{64}$/.test(identity.build), 'The installed release identity is invalid.')
  // Desktop preferences belong to this application, not a connected server.
  const directory = config.updateDirectory || join(config.base, 'updates', role || 'development')
  return { manifest, trust, identity, root: config.root, directory, stateFile: join(directory, 'state.json') }
}
async function lock(directory, callback) {
  return withRequestLock(join(directory, '.lock'), callback)
}
async function readState(info) {
  const state = await json(info.stateFile, { schema: 1, daily: true, phase: 'idle', floor: info.identity.sequence, checkedAt: null, attemptedAt: null })
  if (active.has(state.phase) && state.operationPid) {
    try { process.kill(state.operationPid, 0) }
    catch (error) {
      if (error.code === 'ESRCH') {
        state.phase = 'failed'; state.error = 'The update was interrupted. Review the installation before retrying.'; state.message = state.error
      }
    }
  }
  if (active.has(state.phase) && !state.operationPid && state.job) {
    const lease = await json(join(dirname(state.job), 'lease.json'), null)
    if (lease?.pid) {
      try { process.kill(lease.pid, 0) }
      catch (error) { if (error.code === 'ESRCH') { state.phase = 'failed'; state.error = 'The update helper stopped. Review the installation before retrying.'; state.message = state.error } }
    } else if (Date.now() - state.startedAt > 120_000) {
      state.phase = 'failed'; state.error = 'The update helper could not start. Retry the update.'; state.message = state.error
    }
  }
  return state
}
async function selectArtifact(info, release) {
  let target = info.identity.target
  if (info.identity.role === 'desktop' && process.platform === 'linux') {
    // Package provenance is set at packaging, never guessed from another distro.
    let kind = info.manifest.packageFormat
    try { await execute('/usr/bin/rpm', ['-qf', join(info.root, 'manifest.json')], { timeout: 5000 }); kind = 'rpm' } catch { /* Not owned by RPM. */ }
    if (!kind) try { await execute('/usr/bin/dpkg-query', ['-S', join(info.root, 'manifest.json')], { timeout: 5000 }); kind = 'deb' } catch { /* Unregistered package. */ }
    if (!['deb', 'rpm'].includes(kind)) return null
    target += '-' + kind
  }
  return release.artifacts[target] || null
}
function available(info) { return Boolean(info.manifest?.installation && info.trust.enabled) }
export async function updateStatus(config) {
  const info = await layout(config), state = await readState(info)
  const installed = info.identity
  const { envelope, job, operationPid, backup, databaseBackup, artifact, ...publicState } = state
  return { ...publicState, available: available(info), installed,
    message: !info.manifest?.installation ? 'Installer updates are unavailable in source development mode.' : !info.trust.enabled ? 'Update publishing has not been configured for this installation.' : state.message || '',
    // Never send private worker paths or the signed envelope to a browser.
    artifact: artifact ? { size: artifact.size, kind: artifact.kind } : null,
    recoveryAvailable: Boolean(backup || databaseBackup), updateAvailable: Boolean(state.release && (state.release.releaseSequence || state.release.sequence) > installed.sequence) }
}
export async function checkUpdates(config, { due = false } = {}, dependencies = {}) {
  const info = await layout(config)
  if (!available(info)) return updateStatus(config)
  await lock(info.directory, async () => {
    const state = await readState(info), now = dependencies.now?.() || Date.now()
    if (active.has(state.phase) || due && (!state.daily || state.checkedAt && now - state.checkedAt < day || state.attemptedAt && now - state.attemptedAt < 3600_000)) return
    state.attemptedAt = now
    await atomicJson(info.stateFile, state)
    try {
      const response = await (dependencies.fetch || fetch)(info.trust.origin + '/' + info.identity.product + '/latest.json',
        { signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { Accept: 'application/json', ...(state.etag ? { 'If-None-Match': state.etag } : {}) } })
      let envelope = state.envelope
      if (response.status !== 304) {
        require(response.ok, 'Could not check for updates (HTTP ' + response.status + ').')
        const reader = response.body.getReader(); let bytes = 0; const blocks = []
        try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; require(bytes <= 1024 * 1024, 'Release metadata is too large.'); blocks.push(value) } }
        finally { await reader.cancel() }
        envelope = JSON.parse(Buffer.concat(blocks).toString('utf8'))
      }
      const release = verifyRelease(envelope, info.trust, { product: info.identity.product, floor: Math.max(state.floor || 0, info.identity.sequence), now })
      require(!state.release || release.sequence !== state.release.sequence || release.digest === state.release.digest, 'A published release revision changed. Updates were refused.')
      const artifact = await selectArtifact(info, release)
      const packageSequence = artifact?.releaseSequence || release.sequence
      const newer = packageSequence > info.identity.sequence
      const sameDownload = state.artifact?.sha256 === artifact?.sha256 && state.phase === 'downloaded'
      const needsRepair = !newer && state.phase === 'failed'
      Object.assign(state, { envelope, artifact, release: { version: release.version, sequence: release.sequence, releaseSequence: packageSequence, notes: release.notes, digest: release.digest },
        floor: release.sequence, etag: response.status === 304 ? state.etag : response.headers.get('etag'), checkedAt: now, error: needsRepair ? state.error : null,
        phase: needsRepair ? 'failed' : sameDownload ? 'downloaded' : newer && artifact ? 'available' : 'idle',
        message: needsRepair ? 'The last update did not finish. Review its recovery files or repair this installation.' : newer ? artifact ? 'An update is available.' : 'This release has no update package for this installation.' : 'You are up to date.' })
    } catch (error) { state.error = error.message; state.message = error.message }
    await atomicJson(info.stateFile, state)
  })
  return updateStatus(config)
}
export async function updateSettings(config, input) {
  require(input && Object.keys(input).length === 1 && typeof input.daily === 'boolean', 'Choose whether to check daily.')
  const info = await layout(config)
  await lock(info.directory, async () => {
    const state = await readState(info); require(!active.has(state.phase), 'Wait for the current update operation to finish.')
    state.daily = input.daily; await atomicJson(info.stateFile, state)
  })
  return updateStatus(config)
}
export async function downloadArtifact(artifact, file, onProgress = async () => {}, fetcher = fetch) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const partial = file + '.partial'
  for (const path of [partial, file]) {
    const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
    require(!info || info.isFile() && !info.isSymbolicLink(), 'The update download path is redirected.')
  }
  let offset = (await stat(partial).catch(error => { if (error.code !== 'ENOENT') throw error }))?.size || 0
  if (offset > artifact.size) { await rm(partial); offset = 0 }
  if (offset < artifact.size) {
    const disk = await statfs(dirname(file))
    require(Number(disk.bavail) * Number(disk.bsize) > artifact.size - offset + 64 * 1024 ** 2, 'There is not enough free space to download this update.')
    const response = await fetcher(artifact.url, { redirect: 'error', signal: AbortSignal.timeout(30 * 60_000),
      headers: offset ? { Range: 'bytes=' + offset + '-' } : {} })
    require(response.status === 200 || response.status === 206 && offset > 0, 'The update download failed (HTTP ' + response.status + ').')
    if (response.status === 200) offset = 0
    else require(response.headers.get('content-range') === `bytes ${offset}-${artifact.size - 1}/${artifact.size}`, 'The download server returned an unexpected range.')
    const handle = await open(partial, offset ? 'a' : 'w', 0o600)
    const reader = response.body.getReader(); let reported = 0
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        require(offset + value.length <= artifact.size, 'The update download exceeded its signed size.')
        await handle.writeFile(value); offset += value.length
        if (Date.now() - reported > 500) { await onProgress(offset); reported = Date.now() }
      }
      await handle.sync()
    } finally { await handle.close(); await reader.cancel() }
  }
  require(offset === artifact.size, 'The update download was interrupted. Retry to resume it.')
  try { await verifyArtifact(partial, artifact) }
  catch (error) { await rm(partial, { force: true }); throw error }
  await rename(partial, file)
  await onProgress(offset)
}
export async function verifyArtifact(file, artifact) {
  const { createReadStream } = await import('node:fs')
  require((await lstat(file)).isFile() && (await stat(file)).size === artifact.size, 'The update package size changed.')
  const digest = createHash('sha256')
  for await (const block of createReadStream(file)) digest.update(block)
  require(digest.digest('hex') === artifact.sha256, 'The update package failed signature-bound checksum verification.')
}
async function validatedState(info) {
  const state = await readState(info)
  const release = verifyRelease(state.envelope, info.trust, { product: info.identity.product, floor: Math.max(state.floor || 0, info.identity.sequence) })
  const artifact = await selectArtifact(info, release)
  require((artifact?.releaseSequence || release.sequence) > info.identity.sequence, 'No newer release is ready to install.')
  require(artifact && hash(JSON.stringify(artifact)) === hash(JSON.stringify(state.artifact)), 'The selected update package changed. Check for updates again.')
  return { state, release, artifact }
}
export async function downloadUpdate(config, dependencies = {}) {
  const info = await layout(config)
  require(available(info), 'Updates are not configured for this installation.')
  await lock(info.directory, async () => {
    const { state, release, artifact } = await validatedState(info)
    require(!active.has(state.phase), 'Another update operation is in progress.')
    const file = join(info.directory, 'packages', artifact.sha256 + '-' + basename(new URL(artifact.url).pathname))
    Object.assign(state, { phase: 'downloading', sequence: release.sequence, transferred: 0, error: null, operationPid: process.pid })
    await atomicJson(info.stateFile, state)
    try {
      await downloadArtifact(artifact, file, async transferred => { state.transferred = transferred; await atomicJson(info.stateFile, state) }, dependencies.fetch || fetch)
      Object.assign(state, { phase: 'downloaded', message: 'Update downloaded. Ready to install.' })
    } catch (error) { Object.assign(state, { phase: 'available', error: error.message, message: error.message }); throw error }
    finally { await atomicJson(info.stateFile, state) }
  })
  return updateStatus(config)
}
export async function componentSelectionSnapshot(workspace) {
  const file = join(workspace, 'config/component-selection.json')
  let bytes
  try {
    require((await lstat(file)).isFile() && await realpath(dirname(file)) === join(await realpath(workspace), 'config'), 'Component selection path is redirected.')
    bytes = await readFile(file)
  } catch (error) { if (error.code === 'ENOENT') return { digest: null, components: [], selection: null }; throw error }
  const selection = JSON.parse(bytes)
  require(selection?.schema === 1 && selection.components && typeof selection.components === 'object' && !Array.isArray(selection.components), 'Invalid component selection.')
  return { digest: hash(bytes), components: Object.keys(selection.components).sort(), selection }
}
export async function productSelectionSnapshot(workspace) {
  const file = join(workspace, 'config/product-selection.json')
  let bytes
  try {
    require((await lstat(file)).isFile() && await realpath(dirname(file)) === join(await realpath(workspace), 'config'), 'Product selection path is redirected.')
    bytes = await readFile(file)
  } catch (error) { if (error.code === 'ENOENT') return { digest: null, assemblies: [], selection: null }; throw error }
  const selection = JSON.parse(bytes)
  require(selection?.schema === 1 && selection.assemblies && typeof selection.assemblies === 'object' && !Array.isArray(selection.assemblies), 'Invalid product selection.')
  for (const [id, item] of Object.entries(selection.assemblies)) require(/^[a-z][a-z0-9-]*$/.test(id)
    && /^[a-f0-9]{64}$/.test(item.manifestSha256) && (!item.compatibleBuilds || Array.isArray(item.compatibleBuilds)
      && item.compatibleBuilds.every(build => /^[a-f0-9]{64}$/.test(build))), 'Invalid product selection identity.')
  return { digest: hash(bytes), assemblies: Object.keys(selection.assemblies).sort(), selection }
}
export async function updatePlan(config) {
  const info = await layout(config), { state, release, artifact } = await validatedState(info)
  const { status, updateBlockers } = await import('./runtime.mjs')
  const current = await status(config), sessions = await updateBlockers(config)
  const productInventory = config.products ? (await import('./products.mjs')).productStatus(config.root, config.input, config.base) : null
  const products = productInventory?.assemblies || []
  const licenses = [...new Map([...artifact.licenses, ...(productInventory?.licenses || [])].map(item => [item.sha256, item])).values()]
  const selection = await componentSelectionSnapshot(config.base)
  const productSelection = await productSelectionSnapshot(config.base)
  const productBlockers = Object.entries(productSelection.selection?.assemblies || {}).filter(([, item]) => !item.compatibleBuilds?.includes(artifact.build))
    .map(([id]) => ({ id, reason: 'The selected tool is not qualified for the new application build. Check for compatible tool updates first.' }))
  const preservedProducts = (config.products?.catalog.assemblies || []).filter(row => productSelection.assemblies.includes(row.id))
    .flatMap(row => Object.entries(row.products).map(([id, item]) => ({ id, version: item.version, release: item.release })))
  const requiredProducts = artifact.products.filter(row => !preservedProducts.some(item => item.id === row.id)).concat(preservedProducts)
  const plan = { componentSelectionDigest: selection.digest, productSelectionDigest: productSelection.digest, preservedProducts, productBlockers,
    resetComponents: selection.components, release: release.sequence, version: release.version, digest: release.digest, installedBuild: info.identity.build, root: resolve(config.root),
    sessions: sessions.map(item => ({ id: item.id, name: item.name, state: item.lifecycle?.state })),
    running: current.services.some(item => ['running', 'starting', 'stopping'].includes(item.state)), products, requiredProducts, licenses, packageKind: artifact.kind,
    sharedProducts: (selection.components.length ? 'Independent runtime selections (' + selection.components.join(', ') + ') will be replaced by the packaged component baseline; the previous selection is retained for recovery. ' : '')
      + (productSelection.assemblies.length ? 'Independently selected tools (' + productSelection.assemblies.join(', ') + ') will be preserved when qualified for this application. ' : '')
      + 'The listed tools will be verified or repaired for this release. Other applications may use shared tools. Provider commands and account data are preserved.' }
  return { ...plan, revision: hash(JSON.stringify(plan)), ready: state.phase === 'downloaded' && productBlockers.length === 0 }
}

export async function launchUpdate(config, input) {
  require(input?.confirmed === true && typeof input.revision === 'string', 'Review and confirm the update plan.')
  const info = await layout(config)
  await lock(info.directory, async () => {
    const { state, release, artifact } = await validatedState(info), plan = await updatePlan(config)
    require(state.phase === 'downloaded' && plan.revision === input.revision, 'The update or running sessions changed. Review the update again.')
    require(plan.productBlockers.length === 0, 'Selected tools require qualification for the new application. Check for compatible tool updates first.')
    // First release: never terminate agent work from the updater. Stop sessions
    // explicitly in their terminal, then review a fresh plan.
    require(plan.sessions.length === 0, 'Finish or stop the listed workspace sessions before updating.')
    require(Array.isArray(input.acceptedLicenses) && plan.licenses.every(license => input.acceptedLicenses.includes(license.sha256)), 'Review and accept the release product licenses.')
    if (info.identity.role === 'desktop') require(Number.isInteger(input.parentPid) && input.parentPid > 0 && typeof input.application === 'string', 'Start Desktop updates from its connection window.')
    const packageFile = join(info.directory, 'packages', artifact.sha256 + '-' + basename(new URL(artifact.url).pathname))
    await verifyArtifact(packageFile, artifact)
    const operation = randomUUID()
    await reserveActivation(config.base, operation, 'native')
    const directory = join(info.directory, 'jobs', operation)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const node = join(directory, process.platform === 'win32' ? 'node.exe' : 'node')
    await cp(process.execPath, node)
    if (process.platform === 'win32') for (const name of await readdir(dirname(process.execPath)))
      if (name.toLowerCase().endsWith('.dll')) await cp(join(dirname(process.execPath), name), join(directory, name))
    for (const name of ['activation.mjs', 'updates.mjs', 'update-worker.mjs']) await cp(join(ownRoot, name), join(directory, name))
    const env = Object.fromEntries(Object.entries(config.input).filter(([key]) => ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SystemRoot', 'SYSTEMROOT', 'PATH', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'USER', 'LOGNAME', 'AIXAND_SHARED_PRODUCT_PREFIX', 'AIXAND_SKIP_PATH_REGISTRATION'].includes(key)))
    for (const key of ['AIXAND_PRODUCTION_ORIGINS', 'AIXAND_PRODUCTION_TRANSPORT', 'AIXAND_PRODUCTION_TRUST_PROXY', 'NODE_EXTRA_CA_CERTS']) if (config.env[key]) env[key] = config.env[key]
    const options = { operation, config: { root: config.root, base: config.base, updateDirectory: info.directory }, packageFile, envelope: state.envelope,
      trust: info.trust, product: info.identity.product, sequence: release.sequence, installedBuild: info.identity.build,
      componentSelectionDigest: plan.componentSelectionDigest,
      productSelectionDigest: plan.productSelectionDigest,
      artifact, root: config.root, wasRunning: plan.running, workspace: config.base, port: config.port, carrierPort: config.carrierPort, env,
      parentPid: input.parentPid || null, application: input.application || null, acceptedLicenses: input.acceptedLicenses,
      taskName: process.platform === 'win32' ? 'AixandUpdate-' + randomUUID() : null }
    await atomicJson(join(directory, 'job.json'), options)
    Object.assign(state, { operation, phase: 'preparing', operationPid: null, startedAt: Date.now(), job: join(directory, 'job.json'), error: null, message: 'Preparing the update. The application will close.' })
    await atomicJson(info.stateFile, state)
    try {
      if (process.platform === 'win32') {
        // A detached child still inherits a Windows Job Object. The per-user
        // scheduler starts this helper outside the workspace job being stopped.
        const program = join(env.SystemRoot || env.SYSTEMROOT || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
        const payload = Buffer.from(JSON.stringify({ node, worker: join(directory, 'update-worker.mjs'), job: join(directory, 'job.json') })).toString('base64')
        const launch = `$ErrorActionPreference='Stop'\n$env:NODE_OPTIONS=$null\n$env:NODE_PATH=$null\n$job=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json\n& $job.node $job.worker $job.job\nexit $LASTEXITCODE\n`
        const args = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + Buffer.from(launch, 'utf16le').toString('base64')
        const data = Buffer.from(JSON.stringify({ name: options.taskName, program, args })).toString('base64')
        // Keep an elevated Server's existing token level: its owner-only files
        // may belong to the enabled Administrators group. Normal Desktop and
        // Server callers retain Limited helpers and never request elevation.
        const script = `$ErrorActionPreference='Stop'\n$job=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json\n$token=[Security.Principal.WindowsIdentity]::GetCurrent()\n$identity=$token.Name\n$level=if((New-Object Security.Principal.WindowsPrincipal($token)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){'Highest'}else{'Limited'}\n$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel $level\n$action=New-ScheduledTaskAction -Execute $job.program -Argument $job.args\n$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromHours(2)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries\nRegister-ScheduledTask -TaskName $job.name -Action $action -Principal $principal -Settings $settings | Out-Null\nStart-ScheduledTask -TaskName $job.name\n`
        await execute(program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, windowsHide: true, timeout: 30_000 })
      } else {
        const child = spawn(node, [join(directory, 'update-worker.mjs'), join(directory, 'job.json')], { detached: true, stdio: 'ignore',
          env: { ...env, NODE_OPTIONS: '', NODE_PATH: '' } })
        await new Promise((ready, fail) => { child.once('spawn', ready); child.once('error', fail) }); child.unref()
        await atomicJson(join(directory, 'lease.json'), { pid: child.pid })
      }
    } catch (error) { state.phase = 'downloaded'; state.error = error.message; await atomicJson(info.stateFile, state); throw error }
  })
  return { started: true }
}
export async function updateAction(config, action, input = {}) {
  if (action === 'status') return updateStatus(config)
  if (action === 'check' || action === 'due') return checkUpdates(config, { due: action === 'due' })
  if (action === 'settings') return updateSettings(config, input)
  if (action === 'download') return downloadUpdate(config)
  if (action === 'plan') return updatePlan(config)
  if (action === 'install') return launchUpdate(config, input)
  throw new Error('Choose update status, check, settings, download, plan or install.')
}
