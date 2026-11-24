import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { productLocation, processBirth } from './products.mjs'
import { productDefinitions, validateProductFeed, planProductUpdates, planCatalogProductUpdates, compareProductVersions } from './product-feed.mjs'
import { privateProductPath, productObjectPath, selectedProductAssembly, readProductSelection, productSelectionPath, productArtifactPath } from './product-selection.mjs'
import { atomicJson, downloadArtifact, verifyArtifact } from './updates.mjs'
import { withRequestLock, reserveActivation } from './activation.mjs'
import { owningLifecycle } from './component-updates.mjs'
import { pythonPath } from './platform.mjs'

const execute = promisify(execFile)
const must = (ok, message) => { if (!ok) throw new Error(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = (file, fallback) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback
export const productUpdateDirectory = config => privateProductPath(config.base, join(config.base, 'software/product-updates'))
export const withProductUpdateLock = (config, callback) => withRequestLock(join(productUpdateDirectory(config), '.lock'), callback, 'Another product update operation is running.')
export function productUpdateState(config) {
  const file = privateProductPath(config.base, join(productUpdateDirectory(config), 'state.json'))
  const state = json(file,
    { schema: 1, phase: 'idle', daily: true, automaticDownload: false, floor: 0 })
  const observed = { phase: state.phase, operation: state.operation, workerPid: state.workerPid, workerBirth: state.workerBirth }
  if (['preparing', 'installing', 'restarting'].includes(state.phase)) {
    if (state.workerPid) {
      try { process.kill(state.workerPid, 0); must(state.workerBirth && state.workerBirth === processBirth(config.root, state.workerPid), 'Product update helper identity changed.') }
      catch (error) { if (error.code === 'ESRCH' || error.message === 'Product update helper identity changed.') { state.phase = 'failed'; state.recoveryRequired = true; state.error = 'Product update helper stopped or changed; inspect its retained recovery journal.' } }
    } else if (Date.now() - state.startedAt > 120000) {
      state.phase = 'failed'; state.recoveryRequired = true; state.error = 'Product update helper did not start; inspect its retained recovery journal.'
    }
  }
  if (state.phase === 'failed' && observed.phase !== 'failed') {
    // Completion is persisted before the helper exits. Its exit can race a
    // status reader that already loaded an older active snapshot.
    const latest = json(file, null)
    if (latest && Object.keys(observed).some(key => latest[key] !== observed[key])) return latest
  }
  return state
}
export const saveProductUpdateState = (config, state) => atomicJson(privateProductPath(config.base, join(productUpdateDirectory(config), 'state.json')), state)
const trustAt = config => json(join(config.root, 'update-config.json'), { enabled: false })
function selectable(inventory, id, candidate) {
  const installed = inventory.products[id]
  if (!installed?.updatable || !candidate.compatibleBuilds.includes(inventory.build)) return false
  if (installed.release === candidate.release) return installed.needsReview === true
  return !installed.maintenanceRequired && compareProductVersions(candidate.version, installed.version) > 0
}

export function productUpdateInventory(config) {
  const location = productLocation(config.root, config.input, config.base)
  if (!location) return { build: null, target: null, products: {} }
  const manifest = json(join(config.root, 'manifest.json'), {})
  const receiptFile = join(location.prefix, 'installation-receipt.json')
  const bytes = existsSync(receiptFile) ? readFileSync(receiptFile) : null
  const receipt = bytes ? JSON.parse(bytes) : null
  must(!receipt || receipt.schema === 2 && receipt.owner === location.owner && receipt.scope === location.scope, 'Product store belongs to a different owner.')
  const byProduct = Object.fromEntries(Object.entries(productDefinitions).map(([id, record]) => [record.product, id]))
  const products = {}
  for (const row of location.catalog.assemblies) {
    const selection = productDefinitions[row.id].product, entry = receipt?.products?.[selection]
    const expected = row.products[selection], selected = entry?.product
    const bundled = location.baseline.assemblies.find(item => item.id === row.id)?.products[selection]
    const maintenanceRequired = row.id === 'undercurrent' && location.scope === 'shared'
    const needsReview = Boolean(selected && expected && selected.release !== expected.release)
    const updatable = Boolean(selected && expected && (!maintenanceRequired || needsReview))
    products[row.id] = { name: productDefinitions[row.id].name, selection, version: selected?.version || null, bundledVersion: bundled?.version || null, canReviewRestore: Boolean(selected && bundled && selected.release !== bundled.release),
      release: selected?.release || null, updatable, needsReview, maintenanceRequired, scope: location.scope,
      requires: Object.fromEntries(Object.entries(entry?.dependency_releases || {}).map(([product, release]) => {
        must(byProduct[product], 'Installed product depends on an unknown product.')
        return [byProduct[product], release]
      })),
      reason: needsReview ? 'Review the tool version already selected by another installation.' : maintenanceRequired ? 'Shared Undercurrent requires its runtime backup and maintenance workflow.' : updatable ? null : 'This tool is not owned by this product store.' }
  }
  return { build: manifest.build, target: location.catalog.target, prefix: location.prefix, scope: location.scope, owner: location.owner,
    receiptDigest: bytes ? hash(bytes) : null, products }
}

function verifiedFeed(config, state, inventory) {
  const schema = state.feedSchema ?? 1
  return validateProductFeed(state.envelope, trustAt(config), { target: inventory.target, floor: state.floor, previousDigest: state.feedDigest, schema })
}
function productOffers(feed) {
  return Object.entries(feed.products).map(([id, value]) => [id, feed.schema === 2 ? value : [value]])
}
function recommendedOffers(inventory, offers) {
  return Object.fromEntries(offers.flatMap(([id, items]) => {
    const best = items.filter(item => selectable(inventory, id, item))
      .sort((a, b) => compareProductVersions(b.version, a.version))[0]
    return best ? [[id, best]] : []
  }))
}
function selectedReleases(inventory, feed, ids) {
  const candidates = recommendedOffers(inventory, productOffers(feed))
  return Object.fromEntries(ids.map(id => {
    must(Object.hasOwn(candidates, id), 'No eligible product release: ' + id)
    return [id, candidates[id].release]
  }))
}
export async function productEngine(config, args) {
  const env = { ...config.env, ...config.input, PIP_NO_INDEX: '1', UV_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1' }
  delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV
  const events = ['install', 'upgrade', 'reinstall'].includes(args[0])
  const result = await execute(pythonPath(join(config.root, 'python')), ['-I', '-B', join(config.root, 'products/consumer/consumer.py'), ...args, ...(events ? ['--events', 'jsonl'] : [])],
    { env, windowsHide: true, timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 })
  if (!events) return JSON.parse(result.stdout)
  const results = result.stdout.split('\n').flatMap(line => {
    try { const value = JSON.parse(line); return value.schema === 2 && value.stage === 'result' ? [value.result] : [] }
    catch { return [] }
  })
  must(results.length === 1, 'Installation engine did not return one verified operation result.')
  return results[0]
}

export async function stageProductPlan(config, plan, dependencies = {}) {
  const location = productLocation(config.root, config.input, config.base), staged = {}
  for (const [id, candidate] of Object.entries(plan.candidates)) {
    if (candidate.action === 'restore') {
      const row = location.baseline.assemblies.find(item => item.id === id)
      staged[id] = { ...row, artifact: productArtifactPath(config.root, row) }
      continue
    }
    const file = privateProductPath(config.base, join(productUpdateDirectory(config), 'downloads', candidate.artifact.sha256 + '.archive'))
    if (existsSync(file)) await verifyArtifact(file, candidate.artifact)
    else await downloadArtifact(candidate.artifact, file, undefined, dependencies.fetch || fetch)
    const output = privateProductPath(config.base, productObjectPath(config.base, id, candidate.artifact.manifestSha256))
    if (!existsSync(output)) {
      await execute(pythonPath(join(config.root, 'python')), ['-I', '-B', join(config.root, 'product-update-artifact.py'),
        '--archive', file, '--output', output, '--helper', join(config.root, 'products/consumer'),
        '--archive-sha256', candidate.artifact.sha256, '--manifest-sha256', candidate.artifact.manifestSha256,
        '--target', plan.inventory.target, '--selection', candidate.selection],
      { env: { ...config.env, PYTHONHOME: '', PYTHONPATH: '' }, windowsHide: true, timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 })
    }
    const original = location.catalog.assemblies.find(row => row.id === id)
    const row = selectedProductAssembly(config.base, original, { manifestSha256: candidate.artifact.manifestSha256 }, plan.inventory.target)
    const product = row.products[candidate.selection]
    must(product?.release === candidate.release && product.version === candidate.version, 'Signed product identity differs from downloaded manifest.')
    must(JSON.stringify(row.licenses.map(l => l.sha256).sort()) === JSON.stringify(candidate.licenses.map(l => l.sha256).sort()), 'Signed product licenses differ from downloaded manifest.')
    staged[id] = row
  }
  return staged
}

export async function currentProductUpdatePlan(config, state, dependencies = {}) {
  const inventory = productUpdateInventory(config)
  if (state.restoreBundled === true) return planBundledProductRestore(config, inventory, dependencies)
  const feed = verifiedFeed(config, state, inventory)
  const lifecycle = await owningLifecycle(dependencies)
  const [current, blockers] = await Promise.all([lifecycle.status(config), lifecycle.updateBlockers(config)])
  const context = { blockers, scope: { root: resolve(config.root), base: resolve(config.base) },
    running: current.services.some(s => ['running', 'starting', 'stopping'].includes(s.state)) }
  const plan = feed.schema === 2
    ? planCatalogProductUpdates(inventory, feed, state.releases ?? selectedReleases(inventory, feed, state.requested), context)
    : planProductUpdates(inventory, feed, state.requested, context)
  if (!['downloaded', 'preparing'].includes(state.phase) || !Object.entries(plan.candidates).every(([id, item]) =>
    existsSync(productObjectPath(config.base, id, item.artifact.manifestSha256))
    && existsSync(join(productUpdateDirectory(config), 'downloads', item.artifact.sha256 + '.archive')))) return { ...plan, ready: false }
  // Engine dry runs check shared-store ownership, collection pins, command and
  // installed-consumer conflicts. Do not weaken those checks in the UI planner.
  const staged = await stageProductPlan(config, plan, dependencies), enginePlans = {}
  for (const [id, row] of Object.entries(staged)) {
    try {
      enginePlans[id] = await (dependencies.engine || productEngine)(config, [plan.candidates[id].action === 'adopt' ? 'inspect' : 'upgrade',
        ...(plan.candidates[id].action === 'adopt' ? [] : ['--dry-run', '--artifact', row.artifact,
          '--expected-sha256', row.manifest_sha256, '--scope', inventory.scope, '--owner', inventory.owner]), '--prefix', inventory.prefix])
    } catch (error) { plan.blockers.push({ name: productDefinitions[id].name, reason: error.message }) }
  }
  // Include exact engine plans in the reviewed fingerprint, including store state.
  const { revision: _revision, ...body } = plan
  const reviewed = { ...body, enginePlans }
  return { ...reviewed, revision: hash(JSON.stringify(reviewed)), ready: true }
}

export async function planBundledProductRestore(config, inventory, dependencies = {}) {
  const location = productLocation(config.root, config.input, config.base)
  must(location, 'This installation has no bundled tool catalog.')
  const selection = readProductSelection(config.base)
  const candidates = {}, blockers = []
  const selected = Object.fromEntries(Object.entries(inventory.products).map(([id, product]) => [id, product.release]))
  const ids = Object.fromEntries(Object.entries(productDefinitions).map(([id, item]) => [item.product, id]))
  const requirements = {}
  for (const row of location.baseline.assemblies) {
    const id = row.id, installed = inventory.products[id], expected = row.products[installed.selection]
    if (!installed.release || installed.release === expected.release) continue
    if (inventory.scope === 'shared' && (installed.needsReview || !Object.hasOwn(selection.assemblies, id))) {
      blockers.push({ name: installed.name, reason: 'This shared tool changed outside this workspace. Review its owner before restoring it.' })
      continue
    }
    candidates[id] = { action: 'restore', version: expected.version, release: expected.release }
    selected[id] = expected.release
    try {
      const bytes = await readFile(join(productArtifactPath(config.root, row), 'release-manifest.json'))
      must(hash(bytes) === row.manifest_sha256, 'Bundled tool manifest changed.')
      const manifest = JSON.parse(bytes), product = manifest.products[installed.selection]
      must(manifest.target === inventory.target && product.release === expected.release && product.version === expected.version
        && Array.isArray(product.dependencies) && typeof product.stateful === 'boolean', 'Bundled tool manifest identity differs.')
      requirements[id] = Object.fromEntries(product.dependencies.map(companion => {
        must(Object.hasOwn(ids, companion) && manifest.products[companion]?.release, 'Bundled tool has an unknown companion.')
        return [ids[companion], manifest.products[companion].release]
      }))
      if (installed.maintenanceRequired) blockers.push({ name: installed.name, reason: 'Shared Undercurrent requires its backup and maintenance workflow.' })
      // The private Linux round trip exercised registry reads and writes with
      // these exact published manifests in both directions.
      else if (product.stateful && !(id === 'agent-manager' && inventory.scope === 'private'
        && inventory.target === 'linux-x86_64-gnu' && !installed.needsReview
        && installed.release === '1128b078925493d0450c73037a39dbbf94ef04f1e843528fb179fabf6a0f1813'
        && selection.assemblies[id]?.manifestSha256 === '3118c4c697f54e17a7b160dd1403d44546772ac190306f348ad6d9da74dc18c6'
        && row.manifest_sha256 === '20ef925c4ba374e9680e0fc3e37e3ce40c985b0079e275f610fec2c91fb9812d')) blockers.push({ name: installed.name, reason: 'Restore requires evidence that the bundled version can read current tool data or a compatible backup.' })
    } catch (error) {
      blockers.push({ name: installed.name, reason: error.message })
    }
  }
  for (const [id, product] of Object.entries(inventory.products)) {
    for (const [companion, release] of Object.entries(requirements[id] ?? product.requires)) {
      if (selected[companion] !== release) blockers.push({ name: product.name,
        reason: 'The bundled selection conflicts with required companion ' + productDefinitions[companion].name + '.' })
    }
  }
  const lifecycle = await owningLifecycle(dependencies)
  blockers.push(...await lifecycle.updateBlockers(config))
  const current = await lifecycle.status(config)
  const order = Object.keys(candidates), enginePlans = {}
  if (order.length > 1) blockers.push({ reason: 'Restoring multiple tools requires a coordinated recovery procedure.' })
  const licenses = location.baseline.assemblies.filter(row => Object.hasOwn(candidates, row.id)).flatMap(row => row.licenses)
  for (const row of location.baseline.assemblies.filter(row => Object.hasOwn(candidates, row.id))) {
    try {
      enginePlans[row.id] = await (dependencies.engine || productEngine)(config, ['upgrade', '--dry-run',
        '--artifact', productArtifactPath(config.root, row), '--expected-sha256', row.manifest_sha256,
        '--scope', inventory.scope, '--owner', inventory.owner, '--prefix', inventory.prefix])
    } catch (error) { blockers.push({ name: inventory.products[row.id].name, reason: error.message }) }
  }
  const running = current.services.some(service => ['running', 'starting', 'stopping'].includes(service.state))
  const plan = { kind: 'bundled-restore', inventory, candidates, blockers, order, enginePlans, licenses, running,
    restartRequired: running && order.length > 0, ready: order.length > 0 && blockers.length === 0 }
  return { ...plan, revision: hash(JSON.stringify(plan)) }
}

export function confirmProductUpdatePlan(plan, input) {
  must(input?.confirmed === true && input.revision === plan.revision, 'Product update plan changed; review it again.')
  must(plan.blockers.length === 0, 'Active work or product installation conflicts block this change.')
  must(plan.ready && Object.keys(plan.candidates).length, plan.kind === 'bundled-restore'
    ? 'No bundled tool version is ready to restore.' : 'Download and verify the selected product updates first.')
  must(!plan.restartRequired || input.restartConsent === true, 'Approve the reviewed workspace restart.')
  must(Array.isArray(input.acceptedLicenses) && plan.licenses.every(l => input.acceptedLicenses.includes(l.sha256)), 'Accept the exact reviewed product licenses.')
}

export async function productUpdateAction(config, action = 'status', input = {}, dependencies = {}) {
  const perform = async () => {
    const state = productUpdateState(config), inventory = productUpdateInventory(config), trust = trustAt(config)
    const available = trust.enabled === true && Boolean(inventory.target && /^[a-f0-9]{64}$/.test(inventory.build || ''))
    if (action === 'status') {
      let candidates = {}, versions = {}, error = state.error || null
      if (available && state.envelope) {
        try {
          const feed = verifiedFeed(config, state, inventory)
          const offers = productOffers(feed)
          candidates = recommendedOffers(inventory, offers)
          if (feed.schema === 2) versions = Object.fromEntries(offers.map(([id, items]) => [id, items.map(item => ({
            version: item.version, release: item.release, selectable: selectable(inventory, id, item),
            qualified: item.compatibleBuilds.includes(inventory.build),
          })).sort((a, b) => compareProductVersions(b.version, a.version))]))
          for (const [id, items] of offers) {
            const item = candidates[id] ?? [...items].sort((a, b) => compareProductVersions(b.version, a.version))[0]
            const installed = inventory.products[id]
            if (!installed || installed.release === item.release && !installed.needsReview) continue
            installed.availableVersion = item.version
            if (!item.compatibleBuilds.includes(inventory.build)) installed.reason = 'This release is not qualified for the installed Suite build.'
          }
        }
        catch (e) { error = e.message }
      }
      return { available, inventory, phase: state.phase, requested: state.phase === 'completed' ? [] : state.requested, checkedAt: state.checkedAt, daily: state.daily,
        automaticDownload: state.automaticDownload, candidates, versions, releases: state.releases, updateAvailable: Object.keys(candidates).length > 0,
        completed: state.completed || [], currentProduct: state.currentProduct, error, recoveryRequired: state.recoveryRequired === true,
        message: available ? error || ({ preparing: 'Preparing tool updates.', installing: 'Updating ' + (productDefinitions[state.currentProduct]?.name || 'selected tools') + '.', restarting: 'Restarting the workspace.' })[state.phase]
          || state.message || 'Choose product updates to review.' : 'Product update feeds are not enabled for this installation.' }
    }
    if (action === 'restore-plan') return planBundledProductRestore(config, inventory, dependencies)
    must(available || action === 'restore', 'Product updates require an installed application with enabled update trust.')
    must(!state.recoveryRequired, 'Resolve the interrupted product update before starting another.')
    must(!['preparing', 'installing', 'restarting'].includes(state.phase), 'A product update is already running.')
    try {
      if (action === 'settings') {
        must(typeof input.daily === 'boolean' || typeof input.automaticDownload === 'boolean', 'Choose product update preferences.')
        for (const key of ['daily', 'automaticDownload']) if (input[key] !== undefined) { must(typeof input[key] === 'boolean', 'Invalid product update preference.'); state[key] = input[key] }
      } else if (action === 'check' || action === 'due') {
        if (action === 'due' && (!state.daily || Date.now() - (state.checkedAt || 0) < 86400000)) return { skipped: true }
        const url = trust.origin + '/aixand-suite-products/' + inventory.target
        const fetchFeed = name => (dependencies.fetch || fetch)(url + '/' + name, {
          redirect: 'error', signal: AbortSignal.timeout(30000),
        })
        let schema = 2, response = await fetchFeed('catalog.json')
        if ([404, 503].includes(response.status) && state.feedSchema !== 2) {
          await response.body?.cancel()
          schema = 1
          response = await fetchFeed('latest.json')
        }
        must(response.ok, 'Product update check failed (HTTP ' + response.status + ').')
        const blocks = []; let length = 0
        for await (const block of response.body) { length += block.length; must(length <= 1500000, 'Product feed exceeds size limit.'); blocks.push(block) }
        const text = Buffer.concat(blocks).toString('utf8')
        const envelope = JSON.parse(text), feed = validateProductFeed(envelope, trust, { target: inventory.target, schema,
          floor: schema === (state.feedSchema ?? 1) ? state.floor : 0,
          previousDigest: schema === (state.feedSchema ?? 1) ? state.feedDigest : undefined })
        const offers = productOffers(feed)
        const selection = readProductSelection(config.base)
        let compatibilityChanged = false
        for (const [id, item] of Object.entries(selection.assemblies)) {
          const candidate = offers.find(([product]) => product === id)?.[1]
            .find(item => item.release === inventory.products[id]?.release)
          if (candidate?.release === inventory.products[id]?.release && candidate.artifact.manifestSha256 === item.manifestSha256
              && candidate.compatibleBuilds.includes(inventory.build) && JSON.stringify(candidate.compatibleBuilds) !== JSON.stringify(item.compatibleBuilds)) {
            item.compatibleBuilds = candidate.compatibleBuilds; compatibilityChanged = true
          }
        }
        if (compatibilityChanged) await atomicJson(productSelectionPath(config.base), selection)
        const recommended = recommendedOffers(inventory, offers)
        const requested = Object.keys(recommended)
        const releases = schema === 2 ? Object.fromEntries(requested.map(id => [id, recommended[id].release])) : undefined
        Object.assign(state, { envelope, restoreBundled: false, feedSchema: schema, floor: feed.sequence, feedDigest: feed.digest,
          checkedAt: Date.now(), phase: 'available', error: null, requested, releases })
        await saveProductUpdateState(config, state)
        state.message = state.requested.length ? 'Compatible tool updates are available.' : 'No compatible tool updates are available.'
        if (state.automaticDownload && state.requested.length) { const plan = await currentProductUpdatePlan(config, state, dependencies); await stageProductPlan(config, plan, dependencies); state.phase = 'downloaded' }
      } else if (action === 'plan' || action === 'download') {
        state.restoreBundled = false
        must(!(input.products && input.releases), 'Choose product IDs or exact releases.')
        if (input.releases) {
          must(state.feedSchema === 2, 'Exact release selection requires a verified product catalog.')
          state.releases = input.releases
          state.requested = Object.keys(input.releases)
        } else if (input.products) {
          state.requested = input.products
          state.releases = undefined
        }
        const plan = await currentProductUpdatePlan(config, state, dependencies)
        if (action === 'plan') { await saveProductUpdateState(config, state); return plan }
        state.phase = 'downloading'; await saveProductUpdateState(config, state)
        await stageProductPlan(config, plan, dependencies); state.phase = 'downloaded'
      } else if (action === 'install' || action === 'restore') {
        const restoreBundled = action === 'restore'
        const plan = await currentProductUpdatePlan(config, { ...state, restoreBundled }, dependencies)
        confirmProductUpdatePlan(plan, input)
        must(typeof dependencies.launchWorker === 'function', 'Product updates require an external lifecycle worker.')
        const operation = randomUUID(), path = privateProductPath(config.base, join(productUpdateDirectory(config), 'jobs', operation, 'job.json'))
        const job = { schema: 1, operation, revision: plan.revision, root: resolve(config.root), base: resolve(config.base), input }
        await reserveActivation(config.base, operation, 'product')
        await atomicJson(path, job)
        Object.assign(state, { operation, restoreBundled, phase: 'preparing', workerPid: null, startedAt: Date.now(), completed: [], recovery: { plan } })
        await saveProductUpdateState(config, state)
        const launched = await dependencies.launchWorker({ config, job: path, operation, worker: fileURLToPath(new URL('./product-update-worker.mjs', import.meta.url)) })
        must(launched?.outsideLifecycle === true && Number.isInteger(launched.pid) && launched.pid > 0, 'External product worker did not start.')
        state.workerPid = launched.pid; state.workerBirth = processBirth(config.root, launched.pid); await saveProductUpdateState(config, state)
        return { started: true, operation }
      } else throw new Error('Choose status, settings, check, due, plan, download, install, restore-plan or restore.')
      await saveProductUpdateState(config, state)
      return { phase: state.phase, daily: state.daily, automaticDownload: state.automaticDownload }
    } catch (error) {
      if (state.operation && state.phase === 'preparing') state.recoveryRequired = true
      state.phase = 'failed'; state.error = error.message; await saveProductUpdateState(config, state); throw error
    }
  }
  return action === 'status' ? perform() : withProductUpdateLock(config, perform)
}
