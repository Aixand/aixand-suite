import { reserveActivation, withActivationAccess } from './activation.mjs'
import { configuration, start } from './runtime.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { validateComponentFeed, planComponents, componentDigest, resolveComponentSelection, componentUpdateAction,
  componentState, saveComponentState } from './component-updates.mjs'
import { runComponentWorker } from './component-update-worker.mjs'

const python = process.platform === 'win32' ? 'python' : 'python3'
const target = 'linux-x86_64-gnu', now = Date.now(), digest = text => createHash('sha256').update(text).digest('hex')
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const trust = { schema: 1, enabled: true, origin: 'https://updates.example', keys: { test: publicKey.export({ type: 'spki', format: 'pem' }) } }
function signed(feed) { const payload = JSON.stringify(feed); return { schema: 1, keyId: 'test', payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') } }
function feed(components, extra = {}) { return { schema: 2, product: 'aixand-suite-components', role: 'desktop', target, sequence: 1,
  publishedAt: new Date(now - 2000).toISOString(), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), components, ...extra } }
function candidate(id, release = 'a'.repeat(64), requires = {}) {
  const kinds = { web: 'assets', server: 'application', connect: 'service', vox: 'service', desktop: 'application', ir: 'library', runner: 'product' }
  return { version: '1.0.0', release, target, kind: kinds[id], activation: id === 'desktop' ? 'native-installer' : id === 'ir' ? 'consumer-build' : id === 'runner' ? 'product-engine' : 'runtime', requires, inputs: {},
    artifact: { url: 'https://updates.example/' + id + '.tar.gz', size: 1, sha256: 'c'.repeat(64), manifestSha256: 'd'.repeat(64) }, licenses: [{ id: 'Licence', url: 'https://updates.example/license', sha256: 'e'.repeat(64) }] }
}
const validate = (value, options = {}) => validateComponentFeed(signed(value), trust, { role: 'desktop', target, now, ...options })

test('bounded Ed25519 feed binds role, target, owner, sequence, expiry and origin', () => {
  const value = feed({ web: candidate('web') }), good = validate(value)
  assert.equal(good.sequence, 1)
  const envelope = signed(value); envelope.payload += ' '
  assert.throws(() => validateComponentFeed(envelope, trust, { role: 'desktop', target }), /signature/)
  assert.throws(() => validate(value, { role: 'server' }), /role or target/)
  assert.throws(() => validate(value, { target: 'macos-arm64' }), /role or target/)
  assert.throws(() => validate(value, { floor: 2 }), /rollback/)
  assert.throws(() => validate(value, { floor: 1, previousDigest: 'f'.repeat(64) }), /Immutable/)
  assert.throws(() => validate(feed({}, { expiresAt: new Date(now - 1).toISOString() })), /expired/)
  const owner = candidate('web'); owner.activation = 'product-engine'
  assert.throws(() => validate(feed({ web: owner })), /owner/)
  const url = candidate('web'); url.artifact.url = 'https://evil.example/file'
  assert.throws(() => validate(feed({ web: url })), /trusted HTTPS/)
  assert.throws(() => validateComponentFeed(signed(value), { ...trust, enabled: false }), /disabled/)
})

test('exact dependency closure includes dependencies and installed consumer companions', () => {
  const oldWeb = candidate('web', '1'.repeat(64)), oldServer = candidate('server', '2'.repeat(64), { web: oldWeb.release })
  const newWeb = candidate('web', '3'.repeat(64)), newServer = candidate('server', '4'.repeat(64), { web: newWeb.release })
  const inventory = { components: { web: oldWeb, server: oldServer } }
  const value = validate(feed({ web: newWeb, server: newServer }))
  const plan = planComponents(inventory, value, ['web'])
  assert.deepEqual(Object.keys(plan.candidates).sort(), ['server', 'web'])
  assert.equal(Object.keys(planComponents(inventory, value, ['server']).candidates).length, 2)
  assert.throws(() => planComponents(inventory, validate(feed({ web: newWeb })), ['web']), /companion/)
  const native = planComponents({ components: {} }, validate(feed({ desktop: candidate('desktop'), ir: candidate('ir'), runner: candidate('runner') })))
  assert.deepEqual(native.unsupported.map(i => i.action).sort(), ['consumer rebuild required', 'native-installer action required', 'product-engine action required'])
})

async function fixture(t, { automaticDownload = false, multiple = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'suite-components-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'package'), base = join(home, 'workspace')
  await mkdir(join(root, 'scripts/release'), { recursive: true }); await mkdir(base)
  for (const file of ['artifacts.py', 'components.py']) await cp(resolve('scripts/release', file), join(root, 'scripts/release', file))
  await writeFile(join(root, 'update-config.json'), JSON.stringify(trust))
  await writeFile(join(root, 'components.json'), JSON.stringify({ schema: 1, role: 'desktop', target, components: { connect: candidate('connect') } }))
  await writeFile(join(root, 'sealed.txt'), 'sealed application')
  await writeFile(join(base, 'account-data'), 'private account')
  const artifactPath = join(home, 'web.tar.gz')
  const script = `import sys, json, hashlib, tarfile, io\nsys.path.insert(0,sys.argv[1])\nfrom artifacts import canonical, validate_manifest\ndata=b'fresh web runtime'\nm={'schema':1,'component':'web','version':'1.0.0','target':'${target}','kind':'assets','activation':'runtime','requires':{},'inputs':{},'source':{'revision':'a'*40,'dirty':False},'files':{'index.html':{'sha256':hashlib.sha256(data).hexdigest(),'size':len(data),'executable':False}}}\nm['release']=hashlib.sha256(canonical({k:v for k,v in m.items() if k!='source'})).hexdigest()\nvalidate_manifest(m)\nwith tarfile.open(sys.argv[2],'w:gz',format=tarfile.USTAR_FORMAT) as a:\n for name,body in [('component.json',canonical(m)),('payload/index.html',data)]:\n  e=tarfile.TarInfo(name);e.size=len(body);e.mode=0o644;a.addfile(e,io.BytesIO(body))\nprint(json.dumps(m))`
  const manifest = JSON.parse(execFileSync(python, ['-B', '-c', script, join(root, 'scripts/release'), artifactPath], { encoding: 'utf8' }))
  const archive = await readFile(artifactPath)
  const item = { ...candidate('web', manifest.release), artifact: { url: 'https://updates.example/web.tar.gz', sha256: digest(archive), size: archive.length, manifestSha256: componentDigest(manifest) } }
  const value = feed({ web: item, ...(multiple ? { connect: candidate('connect') } : {}) }), envelope = signed(value)
  let active = [], running = false, stops = 0, starts = 0, failStart = false, fetches = 0
  const config = { root, base, input: { HOME: home }, env: { PATH: process.env.PATH }, tools: { python: execFileSync(python, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim() } }
  const dependencies = { lifecycle: {
    status: async () => ({ services: [{ state: running ? 'running' : 'stopped' }] }),
    updateBlockers: async () => active,
    prepareUpdate: async () => { if (active.length) throw new Error('Active work during preparation') },
    stop: async () => { stops++; running = false },
    start: async () => { starts++; if (failStart) throw new Error('owning lifecycle failed'); running = true },
  }, fetch: async url => { fetches++; return new Response(url.endsWith('latest.json') ? JSON.stringify(envelope) : archive) } }
  const action = (name, input) => componentUpdateAction(config, name, input, dependencies)
  if (automaticDownload) await action('settings', { automaticDownload: true })
  return { home, root, base, config, dependencies, action, item, archive, envelope,
    active: value => { active = value }, running: value => { running = value }, failStart: value => { failStart = value },
    counts: () => ({ stops, starts, fetches }) }
}
async function ready(f) { await f.action('check'); await f.action('download'); return f.action('plan') }
function consent(plan) { return { confirmed: true, revision: plan.revision, acceptedLicenses: plan.licenses.map(i => i.sha256), restartConsent: true } }
async function launch(f, plan) {
  f.dependencies.launchWorker = async ({ job }) => { f.job = JSON.parse(await readFile(job, 'utf8')); return { outsideLifecycle: true, pid: process.pid } }
  return f.action('install', consent(plan))
}

test('source mode needs no network or baseline and defaults to daily checks', async t => {
  const f = await fixture(t); await rm(join(f.root, 'components.json'))
  assert.deepEqual(resolveComponentSelection(f.root, f.base).components, {})
  const status = await f.action('status'); assert.equal(status.daily, true); assert.equal(status.automaticDownload, false)
  assert.equal((await f.action('check')).available, false); assert.equal(f.counts().fetches, 0)
})

test('automatic download persists preference and never selects, stops or starts software', async t => {
  const f = await fixture(t, { automaticDownload: true })
  assert.equal((await f.action('check')).phase, 'downloaded')
  assert.equal(componentState(f.config).automaticDownload, true)
  assert.equal(existsSync(join(f.base, 'config/component-selection.json')), false)
  assert.deepEqual(f.counts(), { stops: 0, starts: 0, fetches: 2 })
  assert.equal((await f.action('due')).phase, 'downloaded')
  assert.equal(f.counts().fetches, 2)
})

test('component-only activation preserves sealed files and workspace data', async t => {
  const f = await fixture(t), plan = await ready(f)
  await launch(f, plan)
  await runComponentWorker(f.config, f.job, { ...f.dependencies, outsideLifecycle: true })
  const selected = resolveComponentSelection(f.root, f.base)
  assert.equal(await readFile(join(selected.paths.web, 'index.html'), 'utf8'), 'fresh web runtime')
  assert.equal(await readFile(join(f.root, 'sealed.txt'), 'utf8'), 'sealed application')
  assert.equal(await readFile(join(f.base, 'account-data'), 'utf8'), 'private account')
  assert.equal(componentState(f.config).phase, 'completed')
  assert.equal(selected.components.connect.release, candidate('connect').release)
  assert.equal(selected.paths.connect, undefined)
  assert.equal(f.counts().stops, 0); assert.equal(f.counts().starts, 0)
})

test('missing confirmation, licence consent, restart consent and stale full plan are refused', async t => {
  const f = await fixture(t); f.running(true)
  let plan = await ready(f)
  for (const bad of [{ ...consent(plan), confirmed: false }, { ...consent(plan), acceptedLicenses: [] }, { ...consent(plan), restartConsent: false }, { ...consent(plan), revision: 'stale' }]) {
    await assert.rejects(f.action('install', bad), /Confirm|licence|consent/)
    plan = await ready(f)
  }
  f.active([{ id: 'task', state: 'running' }])
  await assert.rejects(f.action('install', consent(plan)), /stale/)
  const blocked = await f.action('plan')
  await assert.rejects(f.action('install', consent(blocked)), /Active workspace/)
  assert.equal(f.counts().stops, 0)
})

test('worker requires external launch and rejects changed work after launch', async t => {
  const f = await fixture(t), plan = await ready(f)
  await assert.rejects(f.action('install', consent(plan)), /Root launch adapter/)
  const next = await ready(f); await launch(f, next)
  await assert.rejects(runComponentWorker(f.config, f.job, f.dependencies), /External/)
  f.active([{ id: 'work' }])
  await assert.rejects(runComponentWorker(f.config, f.job, { ...f.dependencies, outsideLifecycle: true }), /plan changed/)
  assert.equal(componentState(f.config).phase, 'failed')
  assert.equal(existsSync(join(f.base, 'config/component-selection.json')), false)
})

test('failed updated runtime retains selection and requires reviewed recovery', async t => {
  const f = await fixture(t); f.running(true)
  const plan = await ready(f); await launch(f, plan); f.failStart(true)
  await assert.rejects(runComponentWorker(f.config, f.job, { ...f.dependencies, outsideLifecycle: true }), /owning lifecycle failed/)
  const state = componentState(f.config)
  assert.equal(state.phase, 'failed'); assert.match(state.recoveryError, /automatic downgrade is refused/)
  assert.equal(state.recovery.selection, null)
  assert.equal(state.recoveryRequired, true)
  assert.equal(existsSync(join(f.base, 'config/component-selection.json')), true)
  assert.equal(f.counts().stops, 1)
})

test('archive tampering and installed payload mutation fail closed', async t => {
  const f = await fixture(t), plan = await ready(f)
  const file = join(f.base, 'software/components/downloads', f.item.artifact.sha256 + '.tar.gz')
  await writeFile(file, Buffer.alloc(f.archive.length))
  await assert.rejects(f.action('download'), /checksum/)
  await writeFile(file, f.archive)
  await f.action('download'); const current = await f.action('plan'); await launch(f, current)
  await runComponentWorker(f.config, f.job, { ...f.dependencies, outsideLifecycle: true })
  const selected = resolveComponentSelection(f.root, f.base)
  const startup = configuration(f.root, { HOME: f.home, AIXAND_LOCAL_HOME: f.base })
  await writeFile(join(selected.paths.web, 'index.html'), 'tamper')
  assert.throws(() => resolveComponentSelection(f.root, f.base, { verifyPayloads: true }), /payload changed/)
  assert.throws(() => configuration(f.root, { HOME: f.home, AIXAND_LOCAL_HOME: f.base }), /payload changed/)
  await assert.rejects(start(startup), /payload changed/)
  assert.equal(f.counts().starts, 0)
  assert.equal(plan.candidates.web.release, f.item.release)
})

test('interrupted download resumes bounded artifact and unsafe archive is rejected', async t => {
  const f = await fixture(t)
  await f.action('check')
  const fetcher = f.dependencies.fetch
  f.dependencies.fetch = async () => new Response(f.archive.subarray(0, 32))
  await assert.rejects(f.action('download'), /interrupted/)
  f.dependencies.fetch = async (url, options) => {
    assert.equal(options.headers.Range, 'bytes=32-')
    return new Response(f.archive.subarray(32), { status: 206, headers: { 'content-range': `bytes 32-${f.archive.length - 1}/${f.archive.length}` } })
  }
  await f.action('download')
  f.dependencies.fetch = fetcher
  const evil = join(f.home, 'evil.tar.gz')
  execFileSync(python, ['-c', "import tarfile,io,sys\nwith tarfile.open(sys.argv[1],'w:gz') as a:\n e=tarfile.TarInfo('../escape');e.size=1;e.mode=0o644;a.addfile(e,io.BytesIO(b'x'))", evil])
  const bytes = await readFile(evil), item = { ...f.item, artifact: { ...f.item.artifact, sha256: digest(bytes), size: bytes.length } }
  const envelope = signed(feed({ web: item }, { sequence: 2 }))
  f.dependencies.fetch = async url => new Response(url.endsWith('latest.json') ? JSON.stringify(envelope) : bytes)
  await f.action('check')
  await assert.rejects(f.action('download'), /Command failed/)
  assert.equal(existsSync(join(f.base, 'escape')), false)
  assert.equal(componentState(f.config).phase, 'failed')
})


test('interrupted worker retains journal and blocks another activation pending recovery', async t => {
  const f = await fixture(t), plan = await ready(f)
  await launch(f, plan)
  const state = componentState(f.config)
  state.phase = 'installing'; state.workerPid = 2147483647
  await saveComponentState(f.config, state)
  const status = await f.action('status')
  assert.equal(status.phase, 'failed'); assert.equal(status.recoveryRequired, true)
  await assert.rejects(f.action('install', consent(plan)), /interrupted activation/)
  const journal = JSON.parse(await readFile(join(f.base, 'software/components/jobs', state.operation, 'recovery.json'), 'utf8'))
  assert.equal(journal.operation, state.operation)
  assert.equal(journal.phase, 'failed')
  assert.equal(existsSync(join(f.base, 'config/component-selection.json')), false)
})

test('selection rejects redirected paths and non-runtime activation owners', async t => {
  const f = await fixture(t), plan = await ready(f)
  await launch(f, plan)
  await runComponentWorker(f.config, f.job, { ...f.dependencies, outsideLifecycle: true })
  const path = join(f.base, 'config/component-selection.json'), selection = JSON.parse(await readFile(path, 'utf8'))
  selection.components.web.path = f.root
  await writeFile(path, JSON.stringify(selection))
  assert.throws(() => resolveComponentSelection(f.root, f.base), /object path/)
  const native = { ...selection.components.web.manifest, component: 'desktop', kind: 'application', activation: 'native-installer' }
  delete native.release; const { source, ...content } = native; native.release = componentDigest(content)
  await writeFile(path, JSON.stringify({ schema: 1, components: { desktop: { path: f.root, manifest: native } } }))
  assert.throws(() => resolveComponentSelection(f.root, f.base), /cannot overlay/)
})


test('running runtime quiesces and restarts only after prior consent', async t => {
  const f = await fixture(t); f.running(true)
  const order = []
  for (const method of ['prepareUpdate', 'stop', 'start']) {
    const original = f.dependencies.lifecycle[method]
    f.dependencies.lifecycle[method] = async (...args) => { order.push(method); return original(...args) }
  }
  const plan = await ready(f); await launch(f, plan)
  await runComponentWorker(f.config, f.job, { ...f.dependencies, outsideLifecycle: true })
  assert.deepEqual(order, ['prepareUpdate', 'stop', 'start'])
  assert.equal(componentState(f.config).phase, 'completed')
})

test('inventory mutation invalidates reviewed plan before install', async t => {
  const f = await fixture(t), plan = await ready(f)
  const file = join(f.root, 'components.json'), baseline = JSON.parse(await readFile(file, 'utf8'))
  baseline.components.connect.release = 'b'.repeat(64)
  await writeFile(file, JSON.stringify(baseline))
  await assert.rejects(f.action('install', consent(plan)), /stale/)
  assert.equal(existsSync(join(f.base, 'config/component-selection.json')), false)
})

test('new work during preparation refuses stop and activation', async t => {
  const f = await fixture(t); f.running(true)
  const plan = await ready(f); await launch(f, plan)
  f.dependencies.lifecycle.prepareUpdate = async () => f.active([{ id: 'late-work' }])
  await assert.rejects(runComponentWorker(f.config, f.job, { ...f.dependencies, outsideLifecycle: true }), /Active work/)
  assert.equal(f.counts().stops, 0)
  assert.equal(existsSync(join(f.base, 'config/component-selection.json')), false)
  assert.equal(componentState(f.config).phase, 'failed')
})

test('direct download honors explicit selections instead of the last inspected plan', async t => {
  const f = await fixture(t, { multiple: true })
  await f.action('check')
  await f.action('plan', { components: ['web'] })
  await f.action('download', { components: ['connect'] })
  const plan = await f.action('plan')
  assert.deepEqual(plan.requested, ['connect'])
  assert.deepEqual(plan.candidates, {})
  assert.equal(f.counts().fetches, 1)
  await assert.rejects(f.action('download', { components: ['unknown'] }), /known candidate/)
})

test('unselected runtime-bound candidates do not block an independent compatible update', async t => {
  const f = await fixture(t)
  const connect = candidate('connect', 'b'.repeat(64)); connect.inputs.runtime = '9'.repeat(64)
  const envelope = signed(feed({ web: f.item, connect }))
  const original = f.dependencies.fetch
  f.dependencies.fetch = async url => url.endsWith('latest.json') ? new Response(JSON.stringify(envelope)) : original(url)
  await f.action('check')
  const plan = await f.action('plan', { components: ['web'] })
  assert.deepEqual(Object.keys(plan.candidates), ['web'])
  await assert.rejects(f.action('plan', { components: ['connect'] }), /different application runtime/)
})


test('component worker stop barrier excludes native admission and ordinary startup', async t => {
  const f = await fixture(t); f.running(true)
  await launch(f, await ready(f))
  let entered, release
  const prepared = new Promise(resolve => { entered = resolve })
  const proceed = new Promise(resolve => { release = resolve })
  f.dependencies.lifecycle.prepareUpdate = async () => { entered(); await proceed }
  const worker = runComponentWorker(f.config, f.job, { ...f.dependencies, outsideLifecycle: true })
  await prepared
  try {
    await assert.rejects(reserveActivation(f.base, 'native-rival', 'native'), /reserved/)
    await assert.rejects(withActivationAccess(f.base, null, () => assert.fail('ordinary startup entered')), /reserved/)
    assert.equal(f.counts().stops, 0)
  } finally { release() }
  await worker
  assert.equal(f.counts().stops, 1)
  assert.equal(f.counts().starts, 1)
})
