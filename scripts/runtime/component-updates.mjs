import { withRequestLock, reserveActivation } from './activation.mjs'
// Component activation changes workspace selections; package and product owners retain their receipts.
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, lstatSync, realpathSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { mkdir, open, rm, rename, writeFile } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { atomicJson, downloadArtifact, verifyArtifact } from './updates.mjs'

const execute = promisify(execFile)
const must = (ok, message) => { if (!ok) throw new Error(message) }
const sha = value => createHash('sha256').update(value).digest('hex')
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (object(value)) return '{' + Object.keys(value).sort((left, right) => {
    const a = [...left], b = [...right]
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const difference = a[i].codePointAt(0) - b[i].codePointAt(0)
      if (difference) return difference
    }
    return a.length - b.length
  }).map(k => canonical(k) + ':' + canonical(value[k])).join(',') + '}'
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}
export const componentDigest = value => sha(canonical(value))
const owners = {
  server: ['runtime', 'application'], web: ['runtime', 'assets'], vox: ['runtime', 'service'], connect: ['runtime', 'service'],
  desktop: ['native-installer', 'application'], 'orchestration-mcp': ['product-engine', 'product'], runner: ['product-engine', 'product'],
  ir: ['consumer-build', 'library'], 'runner-client': ['consumer-build', 'library'], 'python-sdk': ['consumer-build', 'library'],
}
const targets = ['linux-x86_64-gnu', 'linux-arm64-gnu', 'macos-x86_64', 'macos-arm64', 'windows-x86_64-msvc']
export function componentWorkspace(input = process.env) {
  const home = resolve(input.HOME || input.USERPROFILE || homedir())
  const base = input.AIXAND_LOCAL_HOME || (process.platform === 'win32'
    ? join(input.LOCALAPPDATA || join(home, 'AppData/Local'), 'Aixand/local')
    : join(input.XDG_DATA_HOME || join(home, '.local/share'), 'aixand/local'))
  must(isAbsolute(base), 'Component workspace must be an absolute path.')
  return base
}
function keys(value, expected) { must(object(value) && Object.keys(value).sort().join() === [...expected].sort().join(), 'Unexpected metadata fields.') }
function pins(value, inputs = false) { must(object(value) && Object.entries(value).every(([id, release]) => (Object.hasOwn(owners, id) || inputs && id === 'runtime') && hex(release)), 'Dependencies must pin exact component releases.') }
function roleCheck(id, role) { must(!(role === 'server' && id === 'web') && !(role === 'client' && id === 'server'), 'Component does not belong to this role: ' + id) }
function identity(id, item, target, role) {
  must(Object.hasOwn(owners, id) && object(item), 'Unknown component: ' + id)
  must(item.activation === owners[id][0] && (!item.kind || item.kind === owners[id][1]), 'Component activation owner mismatch: ' + id)
  must(item.target === target && targets.includes(target), 'Component target mismatch: ' + id)
  must(hex(item.release) && typeof item.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(item.version) && (!item.version.includes('-') || item.version.slice(item.version.indexOf('-') + 1).split('.').every(part => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'))), 'Invalid component release identity.')
  pins(item.requires); pins(item.inputs, true)
  must(!Object.hasOwn(item.requires, id), 'A component cannot depend on itself.')
  roleCheck(id, role)
}
function secureUrl(value, origin) {
  const url = new URL(value)
  must(url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.origin === new URL(origin).origin, 'Artifact URL must use the trusted HTTPS origin.')
}
export function validateComponentFeed(envelope, trust, { role, target, floor = 0, previousDigest, now = Date.now() } = {}) {
  must(trust?.enabled === true, 'Component update trust is disabled.')
  keys(envelope, ['schema', 'keyId', 'payload', 'signature'])
  must(envelope.schema === 1 && typeof envelope.keyId === 'string' && typeof envelope.payload === 'string' && Buffer.byteLength(envelope.payload) <= 1024 * 1024 && typeof envelope.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature), 'Invalid bounded signed envelope.')
  must(typeof trust.keys?.[envelope.keyId] === 'string', 'Unknown signing key.')
  const key = createPublicKey(trust.keys[envelope.keyId])
  must(key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64')), 'Component feed signature verification failed.')
  const feed = JSON.parse(envelope.payload)
  keys(feed, ['schema', 'product', 'role', 'target', 'sequence', 'publishedAt', 'issuedAt', 'expiresAt', 'components'])
  must(feed.schema === 2 && feed.product === 'aixand-suite-components' && feed.role === role && ['desktop', 'server', 'client'].includes(role) && feed.target === target && targets.includes(target), 'Feed product, role or target mismatch.')
  must(Number.isSafeInteger(feed.sequence) && feed.sequence > 0 && feed.sequence >= floor, 'Component feed rollback refused.')
  const times = ['publishedAt', 'issuedAt', 'expiresAt'].map(k => typeof feed[k] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(feed[k]) ? Date.parse(feed[k]) : NaN)
  must(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= now + 300000 && times[2] > now && times[2] > times[1] && times[2] - times[1] <= 31 * 86400000, 'Component feed timestamps are invalid or expired.')
  const digest = sha(envelope.payload)
  must(feed.sequence !== floor || !previousDigest || previousDigest === digest, 'Immutable feed sequence changed.')
  must(object(feed.components) && Object.keys(feed.components).length <= Object.keys(owners).length, 'Invalid component list.')
  for (const [id, item] of Object.entries(feed.components)) {
    keys(item, ['version', 'release', 'target', 'kind', 'activation', 'requires', 'inputs', 'artifact', 'licenses'])
    identity(id, item, target, role)
    keys(item.artifact, ['url', 'sha256', 'size', 'manifestSha256'])
    secureUrl(item.artifact.url, trust.origin)
    must(hex(item.artifact.sha256) && hex(item.artifact.manifestSha256) && Number.isSafeInteger(item.artifact.size) && item.artifact.size > 0 && item.artifact.size <= 16 * 1024 ** 3, 'Invalid artifact identity.')
    must(Array.isArray(item.licenses) && item.licenses.length <= 64, 'Invalid component licences.')
    for (const license of item.licenses) {
      keys(license, ['id', 'url', 'sha256'])
      must(typeof license.id === 'string' && license.id.length > 0 && license.id.length < 200 && hex(license.sha256), 'Invalid licence identity.')
      secureUrl(license.url, trust.origin)
    }
  }
  return { ...feed, digest }
}
function safePath(base, path) {
  const home = resolve(base), full = resolve(path), rel = relative(home, full)
  must(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')), 'Component path escapes workspace.')
  let current = home
  for (const part of ['', ...rel.split(/[\\/]/).filter(Boolean)]) {
    current = part ? join(current, part) : current
    if (existsSync(current)) must(!lstatSync(current).isSymbolicLink(), 'Redirected component path.')
  }
  if (existsSync(home) && existsSync(full)) {
    const expected = join(realpathSync(home), rel), actual = realpathSync(full)
    must(actual === expected || process.platform === 'win32' && actual.toLowerCase() === expected.toLowerCase(), 'Component path is redirected.')
  }
  return full
}
function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return fallback; throw e } }
export function validateClosure(components) {
  const visiting = new Set(), done = new Set()
  const visit = id => {
    must(!visiting.has(id), 'Component dependency cycle.')
    if (done.has(id)) return
    visiting.add(id)
    for (const [dep, release] of Object.entries(components[id].requires)) {
      must(components[dep]?.release === release, id + ' requires exact release of ' + dep)
      visit(dep)
    }
    visiting.delete(id); done.add(id)
  }
  Object.keys(components).forEach(visit)
  return components
}
function fileDigest(path) {
  const descriptor = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
  try { let count; while ((count = readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); return hash.digest('hex') }
  finally { closeSync(descriptor) }
}
function verifyPayload(base, item) {
  safePath(base, item.path)
  const names = []
  const walk = (directory, prefix = '') => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), info = lstatSync(path), key = prefix + name
      must(!info.isSymbolicLink(), 'Component payload contains a link.')
      if (info.isDirectory()) walk(path, key + '/')
      else {
        must(info.isFile(), 'Component payload contains a special file.')
        names.push(key)
        const file = item.manifest.files[key]
        must(file && info.size === file.size && fileDigest(path) === file.sha256 && (process.platform === 'win32' || Boolean(info.mode & 0o111) === file.executable), 'Installed component payload changed.')
      }
    }
  }
  walk(item.path)
  must(names.sort().join('\0') === Object.keys(item.manifest.files).sort().join('\0'), 'Component payload inventory changed.')
}
// Baseline uses the artifacts.py composition shape. Selection records carry the verified manifest.
export function resolveComponentSelection(root, base, { verifyPayloads = false } = {}) {
  const baseline = readJson(join(root, 'components.json'), null)
  if (!baseline) {
    must(!existsSync(join(base, 'config/component-selection.json')), 'Selection requires a packaged baseline.')
    return { schema: 1, role: null, target: null, components: {}, paths: {} }
  }
  must(baseline.schema === 1 && ['desktop', 'server', 'client'].includes(baseline.role) && targets.includes(baseline.target) && object(baseline.components), 'Invalid packaged component baseline.')
  const components = structuredClone(baseline.components), paths = {}
  for (const [id, item] of Object.entries(components)) identity(id, { ...item, target: item.target || baseline.target }, baseline.target, baseline.role)
  const file = safePath(base, join(base, 'config/component-selection.json'))
  const selection = readJson(file, { schema: 1, components: {} })
  keys(selection, ['schema', 'components'])
  must(selection.schema === 1 && object(selection.components), 'Invalid component selection.')
  for (const [id, item] of Object.entries(selection.components)) {
    keys(item, ['path', 'manifest'])
    const m = item.manifest
    must(object(m) && m.component === id && m.schema === 1 && object(m.files) && Object.keys(m.files).length > 0, 'Invalid selected manifest.')
    const { release, source, ...body } = m
    must(componentDigest(body) === release, 'Selected component identity changed.')
    identity(id, m, baseline.target, baseline.role)
    must(m.activation === 'runtime', 'Selection cannot overlay this activation owner: ' + id)
    const expected = join(resolve(base), 'software/components/objects', id, release, 'payload')
    must(item.path === expected, 'Unexpected component object path.')
    safePath(base, item.path)
    must(existsSync(item.path) && lstatSync(item.path).isDirectory(), 'Selected component payload is missing.')
    if (verifyPayloads) verifyPayload(base, item)
    const runtime = readJson(join(root, 'manifest.json'), {})
    must(!m.inputs.runtime || m.inputs.runtime === runtime.build, 'Component requires a different application runtime.')
    components[id] = { ...m }; paths[id] = expected
  }
  validateClosure(components)
  return { schema: 1, role: baseline.role, target: baseline.target, components, paths }
}
export function planComponents(inventory, feed, requested = Object.keys(feed.components), context = {}) {
  must(Array.isArray(requested) && requested.length > 0 && new Set(requested).size === requested.length && requested.every(id => Object.hasOwn(feed.components, id)), 'Select known candidate components.')
  const selected = {}, next = structuredClone(inventory.components)
  const add = id => { selected[id] = feed.components[id]; next[id] = feed.components[id] }
  requested.forEach(add)
  for (let pass = 0; pass <= Object.keys(owners).length; pass++) {
    let changed = false
    for (const [id, item] of Object.entries(next)) for (const [dep, release] of Object.entries(item.requires)) {
      if (next[dep]?.release === release) continue
      if (feed.components[dep]?.release === release && !selected[dep]) { add(dep); changed = true }
      else if (!selected[id] && feed.components[id] && feed.components[id].release !== item.release) { add(id); changed = true; break }
      else throw new Error('No exact companion release satisfies ' + id + ' -> ' + dep)
    }
    if (!changed) break
    must(pass < Object.keys(owners).length, 'Cannot resolve component dependency closure.')
  }
  validateClosure(next)
  const actions = Object.entries(selected).filter(([id, item]) => inventory.components[id]?.release !== item.release)
  const unsupported = actions.filter(([, item]) => item.activation !== 'runtime').map(([id, item]) => ({ id, action: item.activation === 'consumer-build' ? 'consumer rebuild required' : item.activation + ' action required' }))
  const plan = { schema: 1, scope: context.scope || null, inventory, feedDigest: feed.digest, sequence: feed.sequence, requested: [...requested].sort(),
    candidates: Object.fromEntries(actions.sort(([a], [b]) => a.localeCompare(b))),
    licenses: [...new Map(actions.flatMap(([, i]) => i.licenses).map(i => [i.sha256, i])).values()].sort((a, b) => a.sha256.localeCompare(b.sha256)),
    blockers: context.blockers || [], running: context.running === true, restartRequired: actions.length > 0 && context.running === true, unsupported }
  return { ...plan, revision: componentDigest(plan) }
}
function locations(config) {
  const directory = safePath(config.base, join(config.base, 'software/components'))
  const fromRoot = relative(resolve(config.root), directory)
  must(fromRoot === '..' || fromRoot.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(fromRoot), 'Workspace component objects must be outside the packaged application root.')
  return { directory, state: safePath(config.base, join(directory, 'state.json')), selection: safePath(config.base, join(config.base, 'config/component-selection.json')) }
}
export async function withComponentLock(config, callback) {
  return withRequestLock(join(locations(config).directory, '.lock'), callback, 'Another component operation is in progress.')
}
export function componentState(config) {
  const state = readJson(locations(config).state, { schema: 1, daily: true, automaticDownload: false, phase: 'idle', floor: 0 })
  if (['preparing', 'installing'].includes(state.phase) && state.workerPid) {
    try { process.kill(state.workerPid, 0) } catch (e) { if (e.code === 'ESRCH') { state.phase = 'failed'; state.recoveryRequired = true; state.error = 'Component activation interrupted; inspect recovery before retrying.' } }
  } else if (state.phase === 'preparing' && Date.now() - state.startedAt > 120000) {
    state.phase = 'failed'; state.recoveryRequired = true; state.error = 'Component worker did not start; inspect recovery before retrying.'
  }
  return state
}
export async function saveComponentState(config, state) {
  if (state.recovery && /^[a-f0-9-]{36}$/.test(state.operation || '')) {
    const journal = safePath(config.base, join(locations(config).directory, 'jobs', state.operation, 'recovery.json'))
    await atomicJson(journal, { operation: state.operation, phase: state.phase, error: state.error || null, recoveryError: state.recoveryError || null, recovery: state.recovery })
  }
  await atomicJson(locations(config).state, state)
}
function trustAt(config) { return readJson(join(config.root, 'update-config.json'), { enabled: false }) }
function feedAt(config, state) {
  const inventory = resolveComponentSelection(config.root, config.base)
  return validateComponentFeed(state.envelope, trustAt(config), { role: inventory.role, target: inventory.target, floor: state.floor, previousDigest: state.feedDigest })
}
export async function owningLifecycle(dependencies = {}) {
  if (dependencies.lifecycle) return dependencies.lifecycle
  return import('./runtime.mjs')
}
export async function currentComponentPlan(config, state = componentState(config), dependencies = {}) {
  const lifecycle = await owningLifecycle(dependencies)
  const [current, blockers] = await Promise.all([lifecycle.status(config), lifecycle.updateBlockers(config)])
  must(Array.isArray(blockers) && Array.isArray(current.services), 'Invalid owning lifecycle status.')
  const feed = feedAt(config, state), runtime = readJson(join(config.root, 'manifest.json'), {})
  const plan = planComponents(resolveComponentSelection(config.root, config.base, { verifyPayloads: true }), feed, state.requested,
    { blockers, scope: { root: resolve(config.root), base: resolve(config.base) }, running: current.services.some(i => ['running', 'starting', 'stopping'].includes(i.state)) })
  for (const item of Object.values(plan.candidates))
    must(!item.inputs.runtime || item.inputs.runtime === runtime.build, 'Component requires a different application runtime.')
  return plan
}
export function confirmComponentPlan(plan, input) {
  must(input?.confirmed === true && input.revision === plan.revision, 'Confirm the current complete component plan; stale plans are refused.')
  must(Array.isArray(input.acceptedLicenses) && plan.licenses.every(i => input.acceptedLicenses.includes(i.sha256)), 'Accept every reviewed licence hash.')
  must(plan.blockers.length === 0, 'Active workspace work blocks component activation.')
  must(plan.unsupported.length === 0, plan.unsupported.map(i => i.id + ': ' + i.action).join('; '))
  must(!plan.restartRequired || input.restartConsent === true, 'Explicit stop/restart consent is required.')
  must(Object.keys(plan.candidates).length > 0, 'No component changes to activate.')
}
export async function verifyComponentArchive(config, id, candidate, file, extract) {
  await verifyArtifact(file, candidate.artifact)
  const python = config.tools?.python || join(config.root, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  const script = join(config.root, 'scripts/release/artifacts.py')
  must(existsSync(script), 'Bundled scripts/release/artifacts.py is required.')
  const args = [script, 'verify', '--artifact', file, '--component', id, '--target', candidate.target, '--sha256', candidate.artifact.sha256]
  if (extract) args.push('--extract', extract)
  const { stdout } = await execute(python, args, { env: { ...config.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '' }, maxBuffer: 8 * 1024 * 1024, timeout: 30 * 60_000 })
  const manifest = JSON.parse(stdout)
  must(componentDigest(manifest) === candidate.artifact.manifestSha256 && ['version', 'release', 'target', 'kind', 'activation', 'requires', 'inputs'].every(key => canonical(manifest[key]) === canonical(candidate[key])), 'Archive manifest disagrees with signed candidate.')
  return manifest
}
export async function stageComponentPlan(config, plan, dependencies = {}) {
  const { directory } = locations(config), staged = {}
  for (const [id, candidate] of Object.entries(plan.candidates)) {
    const file = safePath(config.base, join(directory, 'downloads', candidate.artifact.sha256 + '.tar.gz'))
    if (existsSync(file)) await verifyArtifact(file, candidate.artifact)
    else await downloadArtifact(candidate.artifact, file, undefined, dependencies.fetch || fetch)
    await verifyComponentArchive(config, id, candidate, file)
    if (candidate.activation !== 'runtime') continue
    const objectRoot = safePath(config.base, join(directory, 'objects', id, candidate.release))
    const payload = join(objectRoot, 'payload'), receipt = join(objectRoot, 'manifest.json')
    if (existsSync(objectRoot)) {
      must(canonical(readJson(receipt, null)) === canonical(await verifyComponentArchive(config, id, candidate, file)), 'Existing immutable object differs.')
      verifyPayload(config.base, { path: payload, manifest: readJson(receipt) })
    } else {
      const temporary = safePath(config.base, join(directory, 'staging', randomUUID()))
      await mkdir(temporary, { recursive: true, mode: 0o700 })
      try {
        const manifest = await verifyComponentArchive(config, id, candidate, file, join(temporary, 'payload'))
        await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
        await mkdir(dirname(objectRoot), { recursive: true, mode: 0o700 }); await rename(temporary, objectRoot)
      } finally { await rm(temporary, { recursive: true, force: true }) }
    }
    staged[id] = { path: payload, manifest: readJson(receipt) }
  }
  return staged
}
export async function componentUpdateAction(config, action, input = {}, dependencies = {}) {
  if (action === 'status') {
    const state = componentState(config), inventory = resolveComponentSelection(config.root, config.base)
    const { envelope, recovery, workerPid, ...publicState } = state
    const visible = { schema: inventory.schema, role: inventory.role, target: inventory.target,
      components: Object.fromEntries(Object.entries(inventory.components).map(([id, value]) => [id, {
        version: value.version, release: value.release, activation: value.activation, requires: value.requires,
      }])) }
    let candidates = {}, feedError
    try { if (state.envelope) candidates = feedAt(config, state).components } catch (error) { feedError = error.message }
    return { ...publicState, available: Boolean(inventory.role && trustAt(config).enabled), inventory: visible,
      candidates, updateAvailable: Object.entries(candidates).some(([id, value]) => inventory.components[id]?.release !== value.release),
      error: feedError || state.error,
      message: !inventory.role ? 'Component updates require a packaged application.' : !trustAt(config).enabled ? 'Update publishing is not configured for this installation.' : feedError || state.error || '' }
  }
  return withComponentLock(config, async () => {
    const state = componentState(config)
    must(!['preparing', 'installing'].includes(state.phase), 'Component activation is in progress.')
    try {
      if (action === 'settings') {
        must(Object.keys(input).length > 0 && Object.entries(input).every(([k, v]) => ['daily', 'automaticDownload'].includes(k) && typeof v === 'boolean'), 'Invalid component update preferences.')
        Object.assign(state, input)
      } else if (action === 'check' || action === 'due') {
        const inventory = resolveComponentSelection(config.root, config.base), trust = trustAt(config)
        if (!inventory.role || !trust.enabled) return { available: false, inventory, daily: state.daily, automaticDownload: state.automaticDownload }
        const now = dependencies.now?.() ?? Date.now()
        if (action === 'due' && (!state.daily || now - (state.checkedAt || 0) < 86400000 || now - (state.attemptedAt || 0) < 3600000)) return { ...state, envelope: undefined }
        state.attemptedAt = now; await saveComponentState(config, state)
        secureUrl(trust.origin, trust.origin)
        const response = await (dependencies.fetch || fetch)(trust.origin.replace(/\/$/, '') + '/aixand-suite-components/' + inventory.role + '/' + inventory.target + '/latest.json', { redirect: 'error', signal: AbortSignal.timeout(20000) })
        must(response.ok, 'Component feed request failed.')
        const blocks = []; let length = 0
        for await (const block of response.body) { length += block.length; must(length <= 1500000, 'Component feed envelope exceeds bound.'); blocks.push(block) }
        const envelope = JSON.parse(Buffer.concat(blocks).toString('utf8'))
        const feed = validateComponentFeed(envelope, trust, { role: inventory.role, target: inventory.target, floor: state.floor, previousDigest: state.feedDigest, now })
        Object.assign(state, { envelope, floor: feed.sequence, feedDigest: feed.digest, checkedAt: now, requested: Object.keys(feed.components), phase: 'available', error: null })
        await saveComponentState(config, state)
        if (state.automaticDownload && state.requested.length) { await stageComponentPlan(config, planComponents(inventory, feed, state.requested), dependencies); state.phase = 'downloaded' }
      } else if (action === 'plan') {
        if (input.components) { state.requested = input.components; await saveComponentState(config, state) }
        return { ...await currentComponentPlan(config, state, dependencies), ready: state.phase === 'downloaded' }
      } else if (action === 'download') {
        if (input.components) state.requested = input.components
        const plan = await currentComponentPlan(config, state, dependencies)
        await stageComponentPlan(config, plan, dependencies); state.phase = 'downloaded'
      } else if (action === 'install') {
        must(!state.recoveryRequired, 'Resolve the recorded interrupted activation before installing another component update.')
        const plan = await currentComponentPlan(config, state, dependencies)
        confirmComponentPlan(plan, input)
        must(state.phase === 'downloaded', 'Download and verify the selected components first.')
        must(typeof dependencies.launchWorker === 'function', 'Root launch adapter required: worker must run outside Server and Windows Job Object.')
        const operation = randomUUID(), job = { schema: 1, operation, revision: plan.revision, input, requested: state.requested, root: resolve(config.root), base: resolve(config.base) }
        await reserveActivation(config.base, operation, 'component')
        const path = safePath(config.base, join(locations(config).directory, 'jobs', operation, 'job.json'))
        await atomicJson(path, job)
        Object.assign(state, { phase: 'preparing', operation, workerPid: null, startedAt: Date.now(), recovery: { selection: readJson(locations(config).selection, null), plan } })
        await saveComponentState(config, state)
        const result = await dependencies.launchWorker({ config, job: path, operation, worker: fileURLToPath(new URL('./component-update-worker.mjs', import.meta.url)) })
        must(result?.outsideLifecycle === true && Number.isInteger(result.pid) && result.pid > 0, 'Launch adapter must attest an external owning-lifecycle worker.')
        state.workerPid = result.pid; await saveComponentState(config, state)
        return { started: true, operation }
      } else throw new Error('Choose status, settings, check, due, plan, download or install.')
      await saveComponentState(config, state)
      return { phase: state.phase, daily: state.daily, automaticDownload: state.automaticDownload }
    } catch (error) { state.phase = 'failed'; state.error = error.message; await saveComponentState(config, state); throw error }
  })
}
