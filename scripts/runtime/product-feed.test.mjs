import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { productDefinitions, validateProductFeed, planProductUpdates, compareProductVersions } from './product-feed.mjs'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const target = 'linux-x86_64-gnu', build = 'a'.repeat(64), now = Date.now()
const trust = { enabled: true, origin: 'https://updates.example', keys: { release: publicKey.export({ type: 'spki', format: 'pem' }) } }
const digest = text => createHash('sha256').update(text).digest('hex')
function candidate(id, requires = {}) {
  return { selection: productDefinitions[id].product, version: '0.1.1-beta', release: digest(id), compatibleBuilds: [build], requires,
    artifact: { url: 'https://updates.example/aixand-suite-products/' + target + '/' + id + '.tar.gz', size: 12, sha256: digest('archive'), manifestSha256: digest('manifest') }, licenses: [] }
}
function feed(products, extra = {}) { return { schema: 1, product: 'aixand-suite-products', target, sequence: 1,
  issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), products, ...extra } }
function envelope(value) { const payload = JSON.stringify(value); return { schema: 1, keyId: 'release', payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') } }
const validate = (value, extra) => validateProductFeed(envelope(value), trust, { target, now, ...extra })
const context = { running: true, blockers: [], scope: { base: '/workspace', root: '/app' } }
function inventory(ids = ['agent-manager', 'prompt-manager']) { return { build, scope: 'shared', products: Object.fromEntries(ids.map(id => [id,
  { release: digest('old-' + id), version: '0.1.0-beta', updatable: true, requires: {} }])) } }

test('product feed binds signature, target, expiry, release sequence and delivery origin', () => {
  const value = feed({ 'agent-manager': candidate('agent-manager') })
  assert.equal(validate(value).sequence, 1)
  const changed = envelope(value); changed.payload += ' '
  assert.throws(() => validateProductFeed(changed, trust, { target }), /signature/)
  assert.throws(() => validate(value, { target: 'macos-arm64' }), /identity|target/)
  assert.throws(() => validate(value, { floor: 2 }), /identity|older|rollback/)
  assert.throws(() => validate(value, { floor: 1, previousDigest: digest('other') }), /Immutable/)
  assert.throws(() => validate(feed({}, { expiresAt: new Date(now - 1).toISOString() })), /expired/)
  const foreign = candidate('agent-manager'); foreign.artifact.url = 'https://evil.example/manager.tar.gz'
  assert.throws(() => validate(feed({ 'agent-manager': foreign })), /trusted/)
  assert.throws(() => validateProductFeed(envelope(value), { ...trust, enabled: false }, { target }), /disabled/)
  const wrong = candidate('agent-manager'); wrong.selection = 'manager-suite/prompt-manager'
  assert.throws(() => validate(feed({ 'agent-manager': wrong })), /identity/)
})

test('manager updates remain independent and bind receipt state, scope and restart review', () => {
  const installed = inventory(), value = validate(feed({ 'agent-manager': candidate('agent-manager'), 'prompt-manager': candidate('prompt-manager') }))
  const plan = planProductUpdates(installed, value, ['agent-manager'], context)
  assert.deepEqual(Object.keys(plan.candidates), ['agent-manager'])
  assert.equal(plan.shared, true); assert.equal(plan.restartRequired, true)
  const changed = structuredClone(installed); changed.products['prompt-manager'].release = digest('external-update')
  assert.notEqual(planProductUpdates(changed, value, ['agent-manager'], context).revision, plan.revision)
  installed.products['agent-manager'].updatable = false
  assert.throws(() => planProductUpdates(installed, value, ['agent-manager'], context), /externally managed/)
})

test('planner closes exact companions and refuses cycles, conflicting consumers and immutable version changes', () => {
  const installed = inventory(), agent = candidate('agent-manager', { 'prompt-manager': digest('prompt-manager') }), prompt = candidate('prompt-manager')
  const value = validate(feed({ 'agent-manager': agent, 'prompt-manager': prompt }))
  assert.deepEqual(planProductUpdates(installed, value, ['agent-manager'], context).order, ['prompt-manager', 'agent-manager'])
  prompt.requires['agent-manager'] = agent.release
  assert.throws(() => planProductUpdates(installed, validate(feed({ 'agent-manager': agent, 'prompt-manager': prompt })), ['agent-manager'], context), /cycle/)
  prompt.requires = {}; agent.requires = {}
  installed.products['prompt-manager'].requires['agent-manager'] = installed.products['agent-manager'].release
  assert.throws(() => planProductUpdates(installed, validate(feed({ 'agent-manager': agent })), ['agent-manager'], context), /conflicts/)
  installed.products['prompt-manager'].requires = {}; agent.version = '0.1.0-beta'
  assert.throws(() => planProductUpdates(installed, validate(feed({ 'agent-manager': agent })), ['agent-manager'], context), /new version/)
})

test('a newer product needs qualification for the installed Suite build', () => {
  const item = candidate('agent-manager'); item.compatibleBuilds = [digest('another-build')]
  assert.throws(() => planProductUpdates(inventory(), validate(feed({ 'agent-manager': item })), ['agent-manager'], context), /not qualified/)
})
test('product ordering refuses downgrade offers across stable and prerelease versions', () => {
  const versions = ['0.1.0-alpha.2', '0.1.0-alpha.10', '0.1.0-beta', '0.1.0-beta.1', '0.1.0', '0.2.0']
  for (let i = 1; i < versions.length; i++) assert.equal(compareProductVersions(versions[i], versions[i - 1]), 1)
  assert.equal(compareProductVersions('1.0.0', '1.0.0'), 0)
  const installed = inventory(); installed.products['agent-manager'].version = '0.2.0'
  assert.throws(() => planProductUpdates(installed, validate(feed({ 'agent-manager': candidate('agent-manager') })), ['agent-manager'], context), /downgrades/)
})
