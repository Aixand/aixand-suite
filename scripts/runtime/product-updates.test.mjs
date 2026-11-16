import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { saveInstallationPlan } from './installation-plan.mjs'
import { productLocation, productStatus } from './products.mjs'
import { productDefinitions } from './product-feed.mjs'
import { productObjectPath, productSelectionPath } from './product-selection.mjs'
import { productUpdateAction, productUpdateState, saveProductUpdateState, currentProductUpdatePlan, withProductUpdateLock } from './product-updates.mjs'
import { runProductUpdateWorker } from './product-update-worker.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const pair = generateKeyPairSync('ed25519')
const trust = { enabled: true, origin: 'https://updates.example', keys: { test: pair.publicKey.export({ type: 'spki', format: 'pem' }) } }

// This is a coordinator fixture, not native product qualification. Installation
// ownership and real artifact extraction have separate engine/native checks.
async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'suite-product-updates-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'application'), base = join(temporary, 'workspace'), home = join(temporary, 'home')
  await mkdir(join(root, 'products/consumer'), { recursive: true })
  if (process.env.AIXAND_TEST_PYTHON_HOME) await symlink(process.env.AIXAND_TEST_PYTHON_HOME, join(root, 'python'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(root, 'products/consumer/consumer.py'), '# coordinator fixture')
  const target = process.platform === 'win32' ? 'windows-x86_64-msvc' : process.platform === 'darwin' ? 'macos-arm64' : 'linux-x86_64-gnu'
  const build = hash('qualified application')
  const catalog = { schema: 1, target, consumer: { 'consumer/consumer.py': hash('# coordinator fixture') },
    assemblies: Object.entries(productDefinitions).map(([id, item]) => ({ id, artifact: 'artifacts/' + id, licenses: [], manifest_sha256: hash('manifest' + id),
      products: { [item.product]: { version: '1.0.0', release: hash(id), commands: [id] } } })) }
  const text = JSON.stringify(catalog)
  await writeFile(join(root, 'products/catalog.json'), text)
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ build, installation: { schema: 1, role: 'server', edition: 'distributed', catalogSha256: hash(text) } }))
  await writeFile(join(root, 'update-config.json'), JSON.stringify(trust))
  const config = { root, base, input: { HOME: home, LOCALAPPDATA: join(home, 'AppData/Local') }, env: {} }
  await saveInstallationPlan(root, config.input, base, 'isolated')
  const location = productLocation(root, config.input, base), receiptPath = join(location.prefix, 'installation-receipt.json')
  await mkdir(location.prefix, { recursive: true })
  const receipt = { schema: 2, scope: location.scope, owner: location.owner,
    products: Object.fromEntries(catalog.assemblies.flatMap(row => Object.entries(row.products).map(([id, product]) => [id, { product, dependency_releases: {} }]))) }
  await writeFile(receiptPath, JSON.stringify(receipt))
  const id = 'agent-manager', selection = productDefinitions[id].product
  const product = { id: selection, release: hash('new agent manager'), version: '1.1.0', commands: { [id]: {} } }
  const manifest = { schema: 2, kind: 'product', target, selection, products: { [selection]: product }, baseline: {} }
  const manifestText = JSON.stringify(manifest), manifestSha256 = hash(manifestText)
  const artifact = productObjectPath(base, id, manifestSha256)
  await mkdir(artifact, { recursive: true }); await writeFile(join(artifact, 'release-manifest.json'), manifestText)
  const bytes = Buffer.from('signed fixture download'), sha256 = hash(bytes)
  const download = join(base, 'software/product-updates/downloads', sha256 + '.archive')
  await mkdir(join(base, 'software/product-updates/downloads'), { recursive: true }); await writeFile(download, bytes)
  const candidate = { selection, version: product.version, release: product.release, compatibleBuilds: [build], requires: {}, licenses: [],
    artifact: { url: trust.origin + '/aixand-suite-products/' + target + '/fixture.tar.gz', size: bytes.length, sha256, manifestSha256 } }
  const payload = JSON.stringify({ schema: 1, product: 'aixand-suite-products', target, sequence: 1,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), products: { [id]: candidate } })
  const envelope = { schema: 1, keyId: 'test', payload, signature: sign(null, Buffer.from(payload), pair.privateKey).toString('base64') }
  const state = { schema: 1, phase: 'downloaded', daily: true, floor: 1, envelope, feedDigest: hash(payload), requested: [id] }
  await saveProductUpdateState(config, state)
  const events = []; let running = true, jobFile, fail = false
  const dependencies = {
    lifecycle: {
      status: async () => ({ services: [{ state: running ? 'running' : 'stopped' }] }), updateBlockers: async () => [],
      prepareUpdate: async () => { events.push('prepare') }, stop: async () => { events.push('stop'); running = false },
      start: async () => { events.push('start'); assert.equal(productStatus(root, config.input, base).ready, true); running = true },
    },
    engine: async (_config, args) => {
      if (args.includes('--dry-run')) return { operation: 'upgrade', scope: location.scope, owner: location.owner, prefix: location.prefix }
      if (fail) throw new Error('Engine installation interrupted')
      events.push('upgrade-agent')
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8')); receipt.products[selection].product = product
      await writeFile(receiptPath, JSON.stringify(receipt)); return { installed: true }
    },
    validateProducts: async () => { events.push('verify'); assert.equal(productStatus(root, config.input, base).ready, true) },
    launchWorker: async ({ job }) => { jobFile = job; return { outsideLifecycle: true, pid: process.pid } },
  }
  return { config, dependencies, events, receiptPath, manifestSha256, candidate, envelope, download,
    job: async () => ({ ...JSON.parse(await readFile(jobFile, 'utf8')), path: jobFile }), fail: () => { fail = true } }
}

test('product review, installation and restart preserve independent selections and other products', async t => {
  const f = await fixture(t)
  const before = JSON.parse(await readFile(f.receiptPath, 'utf8'))
  const plan = await currentProductUpdatePlan(f.config, productUpdateState(f.config), f.dependencies)
  assert.equal(plan.ready, true); assert.deepEqual(Object.keys(plan.candidates), ['agent-manager'])
  assert.deepEqual(f.events, [])
  await assert.rejects(productUpdateAction(f.config, 'install', { confirmed: true, revision: plan.revision, acceptedLicenses: [] }, f.dependencies), /restart/)
  // A rejected request does not authorize installation. Review freshly after it.
  await saveProductUpdateState(f.config, { ...productUpdateState(f.config), phase: 'downloaded' })
  const fresh = await currentProductUpdatePlan(f.config, productUpdateState(f.config), f.dependencies)
  await productUpdateAction(f.config, 'install', { confirmed: true, revision: fresh.revision, acceptedLicenses: [], restartConsent: true }, f.dependencies)
  await runProductUpdateWorker(f.config, await f.job(), { ...f.dependencies, outsideLifecycle: true })
  assert.deepEqual(f.events, ['prepare', 'stop', 'upgrade-agent', 'verify', 'start'])
  const selected = JSON.parse(await readFile(productSelectionPath(f.config.base), 'utf8'))
  assert.equal(selected.assemblies['agent-manager'].manifestSha256, f.manifestSha256)
  const after = JSON.parse(await readFile(f.receiptPath, 'utf8'))
  assert.deepEqual(after.products.runner, before.products.runner)
  assert.equal(productUpdateState(f.config).phase, 'completed')
  assert.equal((await productUpdateAction(f.config, 'status')).updateAvailable, false)
})

test('a changed shared receipt invalidates an already reviewed update before launch', async t => {
  const f = await fixture(t), plan = await currentProductUpdatePlan(f.config, productUpdateState(f.config), f.dependencies)
  const receipt = JSON.parse(await readFile(f.receiptPath, 'utf8')); receipt.externalChange = true
  await writeFile(f.receiptPath, JSON.stringify(receipt))
  await assert.rejects(productUpdateAction(f.config, 'install', { confirmed: true, revision: plan.revision, acceptedLicenses: [], restartConsent: true }, f.dependencies), /changed/)
  assert.deepEqual(f.events, [])
})

test('interrupted product installation retains recovery ownership and never restarts uncertain software', async t => {
  const f = await fixture(t), plan = await currentProductUpdatePlan(f.config, productUpdateState(f.config), f.dependencies)
  await productUpdateAction(f.config, 'install', { confirmed: true, revision: plan.revision, acceptedLicenses: [], restartConsent: true }, f.dependencies)
  f.fail()
  await assert.rejects(runProductUpdateWorker(f.config, await f.job(), { ...f.dependencies, outsideLifecycle: true }), /interrupted/)
  assert.deepEqual(f.events, ['prepare', 'stop'])
  const status = await productUpdateAction(f.config, 'status')
  assert.equal(status.recoveryRequired, true)
  await assert.rejects(productUpdateAction(f.config, 'check', {}, f.dependencies), /interrupted/)
  assert.equal(JSON.parse(await readFile(join(f.config.base, 'updates/activation.json'), 'utf8')).kind, 'product')
})

test('status remains readable while another process owns the product operation lock', async t => {
  const f = await fixture(t)
  await withProductUpdateLock(f.config, async () => {
    const status = await productUpdateAction(f.config, 'status')
    assert.equal(status.inventory.products['agent-manager'].version, '1.0.0')
  })
})

test('external product worker waits for its launching request to release the lock', async t => {
  const f = await fixture(t)
  const plan = await currentProductUpdatePlan(f.config, productUpdateState(f.config), f.dependencies)
  await productUpdateAction(f.config, 'install', { confirmed: true, revision: plan.revision, acceptedLicenses: [], restartConsent: true }, f.dependencies)
  const job = await f.job()
  let worker
  await withProductUpdateLock(f.config, async () => {
    worker = runProductUpdateWorker(f.config, job, { ...f.dependencies, outsideLifecycle: true })
    await delay(100)
    assert.deepEqual(f.events, [])
    assert.equal(productUpdateState(f.config).phase, 'preparing')
  })
  await worker
  assert.equal(productUpdateState(f.config).phase, 'completed')
})

test('reviewing an unstaged product never starts an implicit download', async t => {
  const f = await fixture(t); await rm(f.download)
  const plan = await currentProductUpdatePlan(f.config, productUpdateState(f.config), { ...f.dependencies, fetch: () => { throw new Error('unexpected network') } })
  assert.equal(plan.ready, false); assert.deepEqual(f.events, [])
})
test('a compatible tool changed by another installation is recognized without replacing its software', async t => {
  const f = await fixture(t)
  const artifact = productObjectPath(f.config.base, 'agent-manager', f.manifestSha256)
  const product = JSON.parse(await readFile(join(artifact, 'release-manifest.json'), 'utf8')).products[f.candidate.selection]
  const receipt = JSON.parse(await readFile(f.receiptPath, 'utf8')); receipt.products[product.id].product = product
  await writeFile(f.receiptPath, JSON.stringify(receipt))
  const dependencies = { ...f.dependencies, engine: async (_config, args) => {
    assert.equal(args[0], 'inspect'); return { verified: true }
  } }
  const plan = await currentProductUpdatePlan(f.config, productUpdateState(f.config), dependencies)
  assert.equal(plan.candidates['agent-manager'].action, 'adopt')
  await productUpdateAction(f.config, 'install', { confirmed: true, revision: plan.revision, acceptedLicenses: [], restartConsent: true }, dependencies)
  await runProductUpdateWorker(f.config, await f.job(), { ...dependencies, outsideLifecycle: true })
  assert.equal(productStatus(f.config.root, f.config.input, f.config.base).ready, true)
  assert.deepEqual(f.events, ['prepare', 'stop', 'verify', 'start'])
})
