import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupPlan, applyCleanup, stopCleanupProcesses, repairCleanupPermissions, restoreCleanupProvider } from './cleanup.mjs'

async function fixture() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'aixand-cleanup-')))
  const base = join(temporary, 'home/local'), home = join(temporary, 'home'), prefix = join(home, 'products')
  const config = { root: join(temporary, 'app'), base, input: { HOME: home, AIXAND_SHARED_PRODUCT_PREFIX: prefix }, env: { HOME: home, AGENT_MANAGER_HOME: join(base, 'agents') }, tools: {} }
  const calls = []
  const deps = { providers: async (_config, action = 'plan') => action === 'apply' ? { completed: ['provider-accounts'] }
    : action === 'plan' ? { items: [], revision: {} } : { blockers: [], errors: [] },
    stop: async () => calls.push('stop'), locked: async (_config, callback) => { calls.push('lock'); return callback() },
    removeUcConnection: async () => calls.push('connection'),
    removeSharedProducts: async (_root, _input, _base, ids) => { calls.push(ids); return { completed: ids.map(id => 'product:' + id) } },
  }
  async function put(path, contents = 'fixture') { await mkdir(join(base, path, '..'), { recursive: true }); await writeFile(join(base, path), contents) }
  async function apply(selected, options = {}) { const plan = await cleanupPlan(config, deps); return applyCleanup(config, { selected, revision: plan.revision, confirmed: true, ...options }, deps) }
  return { temporary, config, deps, calls, put, apply, cleanup: () => rm(temporary, { recursive: true, force: true }) }
}

test('preview does not initialize or write a never-started workspace', async () => {
  const f = await fixture()
  try { const plan = await cleanupPlan(f.config, f.deps); assert.ok(plan.items.length >= 3); assert.equal(existsSync(f.config.base), false); assert.deepEqual(f.calls, []) }
  finally { await f.cleanup() }
})

test('administrator access repair needs a fresh review and never applies component removal', async () => {
  const f = await fixture()
  try {
    await f.put('auth/auth.db')
    await f.put('agents/opencode/history')
    const plan = await cleanupPlan(f.config, f.deps)
    const request = { selected: ['provider-accounts'], revision: plan.revision, confirmed: true }
    await assert.rejects(repairCleanupPermissions(f.config, request, f.deps), /Review/)
    assert.deepEqual(f.calls, [])
    const original = f.deps.providers, review = [{ path: join(f.config.base, 'agents/opencode/history'), identity: { file: 'reviewed' } }]
    f.deps.providers = async (config, action, options) => {
      if (action !== 'repair-permissions') return original(config, action, options)
      assert.deepEqual(options.reviewedPermissions, review)
      assert.equal(options.confirmed, true)
      assert.ok(!options.targets.some(target => target.path === '/unrelated'))
      return { blockers: [], errors: [], permissionsRepaired: true }
    }
    const result = await repairCleanupPermissions(f.config, { ...request, reviewedPermissions: review, targets: [{ path: '/unrelated' }] }, f.deps)
    assert.equal(result.blocked, false)
    assert.equal(result.permissionsRepaired, true)
    assert.deepEqual(result.completed, [])
    assert.deepEqual(f.calls, ['stop', 'lock'])
    assert.ok(existsSync(join(f.config.base, 'auth/auth.db')))
    assert.ok(existsSync(join(f.config.base, 'agents/opencode/history')))
  } finally { await f.cleanup() }
})

test('missing shared account CLI has a reviewed restore action that never deletes data', async () => {
  const f = await fixture()
  try {
    await f.put('auth/auth.db')
    f.deps.providers = async () => ({ revision: {}, items: [{ id: 'native:codex', group: 'Shared provider accounts',
      label: 'Codex shared logins and data', available: false, shared: true, paths: ['/fixture/.codex'] }] })
    let installations = 0
    f.deps.install = async (_config, provider) => { assert.equal(provider, 'codex'); installations++ }
    const plan = await cleanupPlan(f.config, f.deps)
    assert.equal(plan.items.find(item => item.id === 'native:codex').recovery.provider, 'codex')
    await assert.rejects(restoreCleanupProvider(f.config, { provider: 'codex', revision: plan.revision }, f.deps), /Confirm/)
    await assert.rejects(restoreCleanupProvider(f.config, { provider: 'codex', revision: 'stale', confirmed: true }, f.deps), /changed/)
    assert.equal(installations, 0)
    assert.deepEqual(await restoreCleanupProvider(f.config, { provider: 'codex', revision: plan.revision, confirmed: true }, f.deps), { restored: 'codex', refreshRequired: true })
    assert.equal(installations, 1)
    assert.deepEqual(f.calls, [], 'No services stopped or data removed')
    assert.equal(existsSync(join(f.config.base, 'auth/auth.db')), true)
  } finally { await f.cleanup() }
})

test('workspace reset clears password and history while unchecked provider data and software survive', async () => {
  const f = await fixture()
  try {
    for (const path of ['auth/auth.db', 'chats/history', 'config/runtime.env', 'agents/codex/accounts', 'agents/provider-sdks/claude/sdk', 'tools/bin/provider', 'state/agent-manager/installations/claude.json', 'config/providers.toml', 'data/opencode/auth.json', 'software/products/payload', 'my-project/source.py']) await f.put(path)
    for (const path of ['config/opencode/preferences.json', 'state/opencode/session', 'cache/opencode/account-cache', 'config/project.json']) await f.put(path)
    const report = await f.apply(['workspace'])
    assert.equal(report.failed, null)
    for (const path of ['auth', 'chats', 'config/runtime.env']) assert.equal(existsSync(join(f.config.base, path)), false)
    for (const path of ['config/opencode/preferences.json', 'state/opencode/session', 'cache/opencode/account-cache', 'config/project.json']) assert.equal(existsSync(join(f.config.base, path)), true, path)
    for (const path of ['agents/codex/accounts', 'agents/provider-sdks/claude/sdk', 'tools/bin/provider', 'state/agent-manager/installations/claude.json', 'config/providers.toml', 'data/opencode/auth.json', 'software/products/payload', 'my-project/source.py']) assert.equal(existsSync(join(f.config.base, path)), true, path)
    assert.deepEqual(f.calls, ['stop', 'lock', 'connection'])
  } finally { await f.cleanup() }
})

test('software support removal keeps provider accounts and workspace password', async () => {
  const f = await fixture()
  try {
    for (const path of ['auth/auth.db', 'agents/codex/accounts', 'agents/provider-sdks/claude/sdk', 'tools/bin/provider']) await f.put(path)
    assert.equal((await f.apply(['provider-runtime', 'provider-tool-store'])).failed, null)
    assert.equal(existsSync(join(f.config.base, 'auth/auth.db')), true)
    assert.equal(existsSync(join(f.config.base, 'agents/codex/accounts')), true)
    assert.equal(existsSync(join(f.config.base, 'tools')), false)
    assert.equal(existsSync(join(f.config.base, 'agents/provider-sdks')), false)
  } finally { await f.cleanup() }
})

test('stale, unknown, duplicate and unconfirmed selections do not stop or delete anything', async () => {
  const f = await fixture()
  try {
    await f.put('auth/auth.db')
    for (const [selected, options] of [[['workspace'], { revision: 'stale' }], [['unknown'], {}], [['workspace', 'workspace'], {}], [['workspace'], { confirmed: false }], [[], {}]])
      await assert.rejects(f.apply(selected, options))
    assert.equal(existsSync(join(f.config.base, 'auth/auth.db')), true)
    assert.deepEqual(f.calls, [])
  } finally { await f.cleanup() }
})

test('a redirected workspace is rejected before provider inspection or service stops', async () => {
  const f = await fixture()
  try {
    const outside = join(f.temporary, 'outside'); await mkdir(outside)
    await mkdir(join(f.config.env.HOME), { recursive: true })
    await symlink(outside, f.config.base, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(f.apply(['workspace']), /symbolic link or junction/)
    assert.deepEqual(await readdir(outside), [])
    assert.deepEqual(f.calls, [])
  } finally { await f.cleanup() }
})

test('individual shared selections are explicit and dependencies are checked before deletion', async () => {
  const f = await fixture()
  try {
    const prefix = f.config.input.AIXAND_SHARED_PRODUCT_PREFIX
    await mkdir(prefix, { recursive: true })
    const receipt = { schema: 2, scope: 'shared', owner: 'user', products: { runner: { dependency_releases: {} }, carrier: { dependency_releases: { runner: 'release' } } } }
    await writeFile(join(prefix, 'installation-receipt.json'), JSON.stringify(receipt))
    await assert.rejects(f.apply(['product:runner']), /requires keeping/)
    assert.deepEqual(f.calls, [])
    const result = await f.apply(['product:carrier'])
    assert.deepEqual(result.completed, ['product:carrier'])
    assert.deepEqual(f.calls, ['stop', 'lock', ['carrier']])
  } finally { await f.cleanup() }
})

test('provider logout failure retains password and reports earlier completed work', async () => {
  const f = await fixture()
  try {
    await f.put('auth/auth.db')
    f.deps.providers = async (_config, action = 'plan') => action === 'apply' ? { completed: ['provider-accounts'], failed: 'Official logout failed' }
      : action === 'plan' ? { items: [], revision: {} } : { blockers: [], errors: [] }
    const result = await f.apply(['provider-accounts', 'workspace'])
    assert.deepEqual(result.completed, ['provider-accounts'])
    assert.match(result.failed, /Official logout failed/)
    assert.deepEqual(result.incomplete, ['workspace'])
    assert.ok(!result.kept.includes('workspace'))
    assert.equal(existsSync(join(f.config.base, 'auth/auth.db')), true)
  } finally { await f.cleanup() }
})

test('blocking files stop cleanup before any logout, data removal, or product mutation', async () => {
  const f = await fixture()
  try {
    await f.put('auth/auth.db')
    await f.put('agents/codex/accounts.json')
    const original = f.deps.providers, events = []
    const blocker = { pid: 123, birth: 'fixture', name: 'codex', canStop: true }
    f.deps.providers = async (config, action, options) => {
      events.push(action || 'plan')
      return action === 'preflight' ? { blockers: [blocker], errors: [] } : original(config, action, options)
    }
    const report = await f.apply(['workspace', 'provider-accounts'])
    assert.equal(report.blocked, true)
    assert.deepEqual(report.completed, [])
    assert.deepEqual(report.blockers, [blocker])
    assert.ok(!events.includes('apply'))
    assert.equal(existsSync(join(f.config.base, 'auth/auth.db')), true)
    assert.equal(existsSync(join(f.config.base, 'agents/codex/accounts.json')), true)
    assert.deepEqual(f.calls, ['stop', 'lock'])
  } finally { await f.cleanup() }
})

test('unidentified locks and unavailable process scans also prevent destructive work', async () => {
  const f = await fixture()
  try {
    await f.put('auth/auth.db')
    const original = f.deps.providers
    f.deps.providers = async (config, action, options) => action === 'preflight'
      ? { blockers: [], errors: [{ path: 'guard', message: 'Owner could not be identified' }] } : original(config, action, options)
    assert.equal((await f.apply(['workspace'])).blocked, true)
    assert.equal(existsSync(join(f.config.base, 'auth/auth.db')), true)
    f.deps.providers = async (config, action, options) => action === 'preflight' ? {} : original(config, action, options)
    await assert.rejects(f.apply(['workspace']), /Could not check applications/)
    assert.equal(existsSync(join(f.config.base, 'auth/auth.db')), true)
  } finally { await f.cleanup() }
})

test('stop actions require reviewed identities, separate force confirmation, and freshly derived paths', async () => {
  const f = await fixture()
  try {
    await f.put('auth/auth.db')
    const plan = await cleanupPlan(f.config, f.deps)
    const options = { selected: ['workspace'], revision: plan.revision, confirmed: true,
      reviewed: [{ pid: 123, birth: 'fixture' }], targets: [{ component: 'workspace', path: '/unrelated' }] }
    await assert.rejects(stopCleanupProcesses(f.config, { ...options, reviewed: [] }, f.deps), /Review/)
    await assert.rejects(stopCleanupProcesses(f.config, { ...options, force: true }, f.deps), /confirm/)
    assert.deepEqual(f.calls, [])
    const original = f.deps.providers
    f.deps.providers = async (config, action, passed) => {
      if (action !== 'stop-processes') return original(config, action, passed)
      assert.deepEqual(passed.reviewed, options.reviewed)
      assert.equal(passed.forceConfirmed, true)
      assert.ok(passed.targets.every(target => target.path.startsWith(f.config.base)))
      return { blockers: [], errors: [], attempted: true }
    }
    const report = await stopCleanupProcesses(f.config, { ...options, force: true, forceConfirmed: true }, f.deps)
    assert.equal(report.blocked, false)
    assert.equal(existsSync(join(f.config.base, 'auth/auth.db')), true, 'stopping a process does not erase history')
  } finally { await f.cleanup() }
})
