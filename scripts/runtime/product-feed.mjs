// Product feeds select canonical installation-engine artifacts, never pip updates.
import { createPublicKey, createHash, verify } from 'node:crypto'

export const productDefinitions = Object.freeze({
  undercurrent: { product: 'undercurrent', name: 'Undercurrent', repository: 'Aixand/undercurrent' },
  runner: { product: 'runner', name: 'Runner', repository: 'Aixand/aixand-suite' },
  carrier: { product: 'carrier', name: 'Carrier', repository: 'Aixand/carrier' },
  'agent-manager': { product: 'manager-suite/agent-manager', name: 'Agent Manager', repository: 'Aixand/manager-suite' },
  'conversation-manager': { product: 'manager-suite/conversation-manager', name: 'Conversation Manager', repository: 'Aixand/manager-suite' },
  'mcp-manager': { product: 'manager-suite/mcp-manager', name: 'MCP Manager', repository: 'Aixand/manager-suite' },
  'prompt-manager': { product: 'manager-suite/prompt-manager', name: 'Prompt Manager', repository: 'Aixand/manager-suite' },
  'skill-manager': { product: 'manager-suite/skill-manager', name: 'Skill Manager', repository: 'Aixand/manager-suite' },
  'orchestration-mcp': { product: 'aixand-suite/orchestration-mcp', name: 'Orchestration MCP', repository: 'Aixand/aixand-suite' },
})
const must = (ok, message) => { if (!ok) throw new Error(message) }
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fields = (value, expected) => must(object(value) && Object.keys(value).sort().join() === [...expected].sort().join(), 'Unexpected product feed fields.')
export const productFeedDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function compareProductVersions(left, right) {
  const parse = value => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
    must(match, 'Product updates require canonical semantic versions.')
    const pre = match[4]?.split('.')
    must(!pre || pre.every(part => /^[0-9A-Za-z-]+$/.test(part) && (!/^\d+$/.test(part) || part === '0' || !part.startsWith('0'))), 'Invalid product prerelease version.')
    return { core: match.slice(1, 4).map(BigInt), pre }
  }
  const a = parse(left), b = parse(right)
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1
    if (nx !== ny) return nx ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}
export function validateProductFeed(envelope, trust, { target, floor = 0, previousDigest, now = Date.now(), schema = 1 } = {}) {
  must(trust?.enabled === true, 'Product update trust is disabled.')
  fields(envelope, ['schema', 'keyId', 'payload', 'signature'])
  must(envelope.schema === 1 && typeof envelope.keyId === 'string' && typeof envelope.payload === 'string'
    && Buffer.byteLength(envelope.payload) <= 1024 * 1024 && typeof envelope.signature === 'string'
    && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature), 'Invalid bounded product feed envelope.')
  must(typeof trust.keys?.[envelope.keyId] === 'string', 'Unknown product signing key.')
  const key = createPublicKey(trust.keys[envelope.keyId])
  must(key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64')), 'Product feed signature verification failed.')
  const feed = JSON.parse(envelope.payload)
  fields(feed, ['schema', 'product', 'target', 'sequence', 'issuedAt', 'expiresAt', 'products'])
  must([1, 2].includes(schema) && feed.schema === schema && feed.product === 'aixand-suite-products' && feed.target === target
    && /^(linux-(x86_64|arm64)-gnu|macos-(arm64|x86_64)|windows-(x86_64|arm64)-msvc)$/.test(target), 'Product feed target mismatch.')
  must(Number.isSafeInteger(feed.sequence) && feed.sequence > 0 && feed.sequence >= floor, 'Product feed rollback refused.')
  const issued = Date.parse(feed.issuedAt), expires = Date.parse(feed.expiresAt)
  must(Number.isFinite(issued) && Number.isFinite(expires) && issued <= now + 300000 && expires > now
    && expires > issued && expires - issued <= 31 * 86400000, 'Product feed is expired or has invalid dates.')
  const digest = createHash('sha256').update(envelope.payload).digest('hex')
  must(feed.sequence !== floor || !previousDigest || previousDigest === digest, 'Immutable product feed sequence changed.')
  must(object(feed.products) && Object.keys(feed.products).length <= Object.keys(productDefinitions).length, 'Invalid product candidate list.')
  if (schema === 2) {
    for (const candidates of Object.values(feed.products)) {
      must(Array.isArray(candidates) && candidates.length > 0 && candidates.length <= 20
        && new Set(candidates.map(item => item?.version)).size === candidates.length
        && new Set(candidates.map(item => item?.release)).size === candidates.length, 'Invalid product version inventory.')
    }
  }
  const candidates = Object.entries(feed.products).flatMap(([id, value]) =>
    (schema === 2 ? value : [value]).map(item => [id, item]))
  for (const [id, item] of candidates) {
    must(Object.hasOwn(productDefinitions, id), 'Unknown product: ' + id)
    fields(item, ['selection', 'version', 'release', 'compatibleBuilds', 'requires', 'artifact', 'licenses'])
    must(item.selection === productDefinitions[id].product && hex(item.release)
      && typeof item.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item.version), 'Invalid product candidate identity.')
    compareProductVersions(item.version, item.version)
    must(Array.isArray(item.compatibleBuilds) && item.compatibleBuilds.length > 0 && item.compatibleBuilds.length <= 64
      && item.compatibleBuilds.every(hex) && new Set(item.compatibleBuilds).size === item.compatibleBuilds.length, 'Product requires reviewed compatible Suite builds.')
    must(object(item.requires) && Object.entries(item.requires).every(([id, release]) => Object.hasOwn(productDefinitions, id) && hex(release)), 'Invalid product companion requirements.')
    must(!Object.hasOwn(item.requires, id), 'Product cannot require itself.')
    fields(item.artifact, ['url', 'size', 'sha256', 'manifestSha256'])
    const url = new URL(item.artifact.url), origin = new URL(trust.origin)
    must(url.protocol === 'https:' && url.origin === origin.origin && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.startsWith('/aixand-suite-products/' + target + '/') && !/%|\.\.|\\/.test(url.pathname), 'Product artifacts must use the trusted release origin.')
    must(hex(item.artifact.sha256) && hex(item.artifact.manifestSha256) && Number.isSafeInteger(item.artifact.size)
      && item.artifact.size > 0 && item.artifact.size <= 8 * 1024 ** 3, 'Invalid product artifact identity.')
    must(Array.isArray(item.licenses) && item.licenses.length <= 32 && item.licenses.every(license => object(license)
      && typeof license.product === 'string' && typeof license.text === 'string' && license.text.length <= 100000
      && hex(license.sha256) && createHash('sha256').update(license.text).digest('hex') === license.sha256), 'Invalid signed product licenses.')
  }
  return { ...feed, digest }
}

export function planProductUpdates(inventory, feed, requested, context) {
  must(Array.isArray(requested) && requested.length > 0 && new Set(requested).size === requested.length
    && requested.every(id => Object.hasOwn(feed.products, id) && inventory.products[id]), 'Choose installed product candidates.')
  const selected = new Set(requested), visiting = new Set(), done = new Set()
  const add = id => {
    must(!visiting.has(id), 'Product companion dependency cycle.')
    if (done.has(id)) return
    visiting.add(id)
    const item = feed.products[id]
    must(item && inventory.products[id]?.updatable, 'This product is externally managed or its installed release changed: ' + id)
    must(item.compatibleBuilds.includes(inventory.build), 'Product is not qualified for this Suite build: ' + id)
    for (const [dependency, release] of Object.entries(item.requires)) {
      const candidate = selected.has(dependency) ? feed.products[dependency] : inventory.products[dependency]
      if (candidate?.release === release) { if (selected.has(dependency)) add(dependency); continue }
      must(feed.products[dependency]?.release === release, 'No exact product companion satisfies ' + id + ' -> ' + dependency)
      selected.add(dependency); add(dependency)
    }
    visiting.delete(id); done.add(id)
  }
  requested.forEach(add)
  // Selected changes must also preserve requirements of all installed consumers.
  const next = Object.fromEntries(Object.entries(inventory.products).map(([id, item]) => [id, selected.has(id) ? feed.products[id] : item]))
  for (const [id, item] of Object.entries(next)) for (const [dependency, release] of Object.entries(item.requires || {}))
    must(next[dependency]?.release === release, 'Update conflicts with installed product: ' + id)
  const order = [], ordered = new Set()
  const visit = id => { if (ordered.has(id)) return; ordered.add(id); Object.keys(feed.products[id].requires).filter(dep => selected.has(dep)).forEach(visit); order.push(id) }
  [...selected].sort().forEach(visit)
  const candidates = Object.fromEntries(order.filter(id => inventory.products[id].release !== feed.products[id].release || inventory.products[id].needsReview)
    .map(id => [id, { ...feed.products[id], action: inventory.products[id].release === feed.products[id].release ? 'adopt' : 'upgrade' }]))
  for (const [id, item] of Object.entries(candidates)) if (item.action === 'upgrade') {
    must(!inventory.products[id].maintenanceRequired, 'This shared product requires its runtime backup and maintenance workflow: ' + id)
    must(item.version !== inventory.products[id].version, 'A changed immutable product needs a new version: ' + id)
    must(compareProductVersions(item.version, inventory.products[id].version) > 0, 'Product downgrades require explicit maintenance: ' + id)
  }
  const plan = { schema: 1, kind: 'products', inventory, feedDigest: feed.digest, sequence: feed.sequence,
    requested: [...requested].sort(), order: order.filter(id => Object.hasOwn(candidates, id)), candidates,
    licenses: [...new Map(Object.values(candidates).flatMap(item => item.licenses).map(item => [item.sha256, item])).values()],
    blockers: context.blockers, scope: context.scope, running: context.running, restartRequired: context.running && Object.keys(candidates).length > 0,
    shared: inventory.scope === 'shared', unsupported: [] }
  return { ...plan, revision: productFeedDigest(plan) }
}

// Resolve explicit release identities before running the existing lifecycle and
// installed-consumer checks. The catalog's signed digest stays in the plan.
export function planCatalogProductUpdates(inventory, catalog, requested, context) {
  must(catalog.schema === 2 && object(requested) && Object.keys(requested).length > 0,
    'Choose exact product catalog releases.')
  const products = {}
  function select(id, release) {
    must(Object.hasOwn(productDefinitions, id) && hex(release), 'Invalid product selection: ' + id)
    if (Object.hasOwn(products, id)) {
      must(products[id].release === release, 'Conflicting companion releases: ' + id)
      return
    }
    const candidate = catalog.products[id]?.find(item => item.release === release)
    must(candidate, 'Selected release is absent from the product catalog: ' + id)
    products[id] = candidate
    for (const [companion, required] of Object.entries(candidate.requires)) {
      const selected = requested[companion]
      must(!selected || selected === required, 'Conflicting companion releases: ' + companion)
      if (selected || inventory.products[companion]?.release !== required) select(companion, required)
    }
  }
  for (const [id, release] of Object.entries(requested)) select(id, release)
  return { ...planProductUpdates(inventory, { ...catalog, products }, Object.keys(requested), context), selectedReleases: { ...requested } }
}
