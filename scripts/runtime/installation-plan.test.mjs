import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { discoverInstallation, readInstallationPlan, saveInstallationPlan, standardManagers, userEnvironment } from './installation-plan.mjs'
import { configuration, stop } from './runtime.mjs'

const execute = promisify(execFile)
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aixand-install-choice-'))
  const home = join(directory, 'home'), base = join(directory, 'workspace'), root = join(directory, 'app')
  await mkdir(home); await mkdir(join(root, 'server'), { recursive: true })
  const input = { HOME: home, USERPROFILE: home, PATH: '', AIXAND_LOCAL_HOME: base }
  return { directory, home, base, root, input, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test('fresh discovery is read-only; shared setup uses native manager defaults and survives child environments', async () => {
  const f = await fixture()
  try {
    assert.equal((await discoverInstallation(f.root, f.input, f.base)).found, false)
    assert.equal(existsSync(f.base), false)
    const plan = await saveInstallationPlan(f.root, f.input, f.base, 'shared')
    assert.equal(plan.managers.AGENT_MANAGER_HOME, join(f.home, '.local/share/aixand/manager/agent/state'))
    assert.equal(plan.managers.AGENT_MANAGER_CONFIG, join(f.home, '.local/share/aixand/manager/agent/providers.toml'))
    assert.equal(plan.undercurrent.owned, false)
    const parent = configuration(f.root, f.input)
    const child = configuration(f.root, parent.env)
    assert.equal(child.env.AGENT_MANAGER_HOME, parent.env.AGENT_MANAGER_HOME)
    assert.equal(child.env.UNDERCURRENT_HOME, join(f.home, '.aixand/undercurrent'))
    assert.equal(child.env.XDG_CONFIG_HOME, join(f.home, '.config'))
    assert.equal(child.identity, parent.identity)
    assert.deepEqual(child.serviceNames, parent.serviceNames)
    assert.equal(userEnvironment(child.env).AGENT_MANAGER_HOME, undefined)
    assert.deepEqual(await saveInstallationPlan(f.root, f.input, f.base, 'shared'), plan)
    await assert.rejects(saveInstallationPlan(f.root, f.input, f.base, 'isolated'), /Changing/)
  } finally { await f.cleanup() }
})

test('shared provider preferences are optional only at the shared default path', async () => {
  const f = await fixture()
  try {
    const plan = await saveInstallationPlan(f.root, f.input, f.base, 'shared')
    const path = plan.managers.AGENT_MANAGER_CONFIG
    assert.equal(configuration(f.root, f.input).env.AGENT_MANAGER_CONFIG, undefined)
    assert.equal(configuration(f.root, configuration(f.root, f.input).env).env.AGENT_MANAGER_CONFIG, undefined)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '[providers.codex]\nlaunch_args = ["--yolo"]\n')
    assert.equal(configuration(f.root, f.input).env.AGENT_MANAGER_CONFIG, path)
    plan.managers.AGENT_MANAGER_CONFIG = join(f.home, 'custom-providers.toml')
    await writeFile(join(f.base, 'config/installation-plan.json'), JSON.stringify(plan))
    assert.equal(configuration(f.root, f.input).env.AGENT_MANAGER_CONFIG, plan.managers.AGENT_MANAGER_CONFIG)
  } finally { await f.cleanup() }
})

test('manager defaults follow XDG, common root and per-product path precedence', async () => {
  const f = await fixture()
  try {
    for (const XDG_DATA_HOME of ['', 'relative/data'])
      assert.equal(standardManagers({ ...f.input, XDG_DATA_HOME }).MCP_MANAGER_HOME, join(f.home, '.local/share/aixand/manager/mcp'))
    assert.equal(standardManagers({ ...f.input, XDG_DATA_HOME: join(f.home, 'data') }).PROMPT_MANAGER_HOME, join(f.home, 'data/aixand/manager/prompt'))
    const input = { ...f.input, AIXAND_MANAGER_ROOT: join(f.home, 'managers'), MCP_MANAGER_HOME: join(f.home, 'custom-mcp') }
    const plan = await saveInstallationPlan(f.root, input, f.base, 'shared')
    assert.equal(plan.managers.AGENT_MANAGER_HOME, join(f.home, 'managers/agent/state'))
    assert.equal(plan.managers.AGENT_MANAGER_HOMES_ROOT, join(f.home, 'managers/agent/home'))
    assert.equal(plan.managers.MCP_MANAGER_HOME, input.MCP_MANAGER_HOME)
    const config = configuration(f.root, input)
    assert.equal(config.env.AIXAND_MANAGER_ROOT, input.AIXAND_MANAGER_ROOT)
    assert.equal(configuration(f.root, config.env).identity, config.identity)
  } finally { await f.cleanup() }
})

test('unsupported plans and mode aliases are rejected without changing data', async () => {
  const f = await fixture()
  try {
    const plan = await saveInstallationPlan(f.root, f.input, f.base, 'shared')
    assert.equal(plan.schema, 2)
    const path = join(f.base, 'config/installation-plan.json')
    const marker = join(f.base, 'keep')
    await writeFile(marker, 'account data')
    for (const value of [{ ...plan, schema: 1 }, { ...plan, mode: 'standard' }, { ...plan, settings: 'legacy' }]) {
      const bytes = JSON.stringify(value)
      await writeFile(path, bytes)
      assert.throws(() => readInstallationPlan(f.base), /Invalid saved/)
      assert.equal(await readFile(path, 'utf8'), bytes)
      assert.equal(await readFile(marker, 'utf8'), 'account data')
    }
    await assert.rejects(saveInstallationPlan(f.root, f.input, f.base, 'standard'), /Choose shared/)
  } finally { await f.cleanup() }
})

test('preserved profile data is detected even without software; explicit native roots are retained', async () => {
  const f = await fixture()
  try {
    const state = join(f.home, 'my-agents'), config = join(f.home, 'providers.toml')
    await mkdir(state); await writeFile(config, '# existing user configuration\n')
    const input = { ...f.input, AGENT_MANAGER_HOME: state, AGENT_MANAGER_CONFIG: config }
    const found = await discoverInstallation(f.root, input, f.base)
    assert.equal(found.found, true)
    assert.equal(found.tools.length, 0)
    const plan = await saveInstallationPlan(f.root, input, f.base, 'shared')
    assert.equal(plan.managers.AGENT_MANAGER_HOME, state)
    assert.equal(await readFile(config, 'utf8'), '# existing user configuration\n')
  } finally { await f.cleanup() }
})

test('isolated choice ignores native manager overrides and keeps state private', async () => {
  const f = await fixture()
  try {
    await saveInstallationPlan(f.root, { ...f.input, AGENT_MANAGER_HOME: join(f.home, 'external') }, f.base, 'isolated')
    const config = configuration(f.root, f.input)
    assert.equal(config.env.AGENT_MANAGER_HOME, join(f.base, 'agents'))
    assert.equal(config.env.UNDERCURRENT_HOME, join(f.base, 'uc'))
    assert.equal(config.plan.undercurrent.owned, true)
    const other = await fixture()
    try {
      await saveInstallationPlan(other.root, other.input, other.base, 'isolated')
      assert.notDeepEqual(configuration(other.root, other.input).serviceNames, config.serviceNames)
    } finally { await other.cleanup() }
  } finally { await f.cleanup() }
})

test('isolated settings copy preserves the source and excludes accounts and live data', async () => {
  const f = await fixture()
  try {
    const source = join(f.home, 'providers.toml')
    const text = '# provider definitions\n[providers]\n'
    await writeFile(source, text)
    const input = { ...f.input, AGENT_MANAGER_CONFIG: source }
    const found = await discoverInstallation(f.root, input, f.base)
    assert.equal(found.copyableSettings.length, 1)
    const plan = await saveInstallationPlan(f.root, input, f.base, 'isolated', 'copy')
    assert.equal(plan.settings, 'copy')
    assert.equal(await readFile(source, 'utf8'), text)
    assert.equal(await readFile(join(f.base, 'config/providers.toml'), 'utf8'), text)
    assert.equal(existsSync(join(f.base, 'agents')), false)
    assert.deepEqual(readInstallationPlan(f.base), plan)
  } finally { await f.cleanup() }
})

test('settings choices cannot silently delete or share external data', async () => {
  const f = await fixture()
  try {
    await assert.rejects(saveInstallationPlan(f.root, f.input, f.base, 'isolated', 'reuse'), /fresh or copied/)
    await assert.rejects(saveInstallationPlan(f.root, f.input, f.base, 'shared', 'fresh'), /reuses shared/)
    await assert.rejects(saveInstallationPlan(f.root, f.input, f.base, 'isolated', 'copy'), /No supported/)
    assert.equal(existsSync(join(f.base, 'config/installation-plan.json')), false)
  } finally { await f.cleanup() }
})

test('corrupt setup cannot claim external state as a private daemon', async () => {
  const f = await fixture()
  try {
    const plan = await saveInstallationPlan(f.root, f.input, f.base, 'shared')
    await writeFile(join(f.base, 'config/installation-plan.json'), JSON.stringify({ ...plan, undercurrent: { ...plan.undercurrent, owned: true } }))
    assert.throws(() => readInstallationPlan(f.base), /Invalid saved/)
  } finally { await f.cleanup() }
})

const uc = process.env.AIXAND_UC_TEST_BIN || resolve(dirname(fileURLToPath(import.meta.url)), '../../../undercurrent/target/debug', process.platform === 'win32' ? 'uc.exe' : 'uc')
test('stopping Suite on a shared real UC daemon leaves unrelated sessions and the daemon running', { skip: !existsSync(uc) }, async () => {
  const f = await fixture()
  let config
  try {
    await symlink(dirname(uc), join(f.root, 'bin'), process.platform === 'win32' ? 'junction' : 'dir')
    await saveInstallationPlan(f.root, f.input, f.base, 'shared')
    config = configuration(f.root, f.input)
    const run = args => execute(uc, ['--json', ...args], { env: config.env, timeout: 30000, windowsHide: true })
    await run(['daemon', 'start'])
    const program = process.platform === 'win32' ? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : '/bin/sh'
    const args = process.platform === 'win32' ? ['-NoProfile', '-Command', 'Start-Sleep 120'] : ['-c', 'sleep 120']
    await run(['start', 'unrelated', '--', program, ...args])
    await run(['start', config.serviceNames[0], '--label', 'suite.instance=' + config.plan.instanceId, '--', program, ...args])
    await stop(config)
    const status = JSON.parse((await run(['daemon', 'status'])).stdout)
    assert.equal(status.accepting_connections, true)
    const sessions = JSON.parse((await run(['ls', '--projection', 'with-labels'])).stdout).items
    assert.equal(sessions.find(item => item.name === 'unrelated').lifecycle.state, 'running')
    assert.notEqual(sessions.find(item => item.name === config.serviceNames[0]).lifecycle.state, 'running')
  } finally {
    if (config) await execute(uc, ['daemon', 'stop'], { env: config.env, timeout: 30000 }).catch(() => {})
    await f.cleanup()
  }
})


test('shared setup pins the selected native UC profile without changing the CLI selection', { skip: !existsSync(uc) }, async () => {
  const f = await fixture()
  try {
    await symlink(dirname(uc), join(f.root, 'bin'), process.platform === 'win32' ? 'junction' : 'dir')
    const input = { ...f.input, PATH: dirname(uc) }
    const run = args => execute(uc, ['--json', ...args], { env: input, timeout: 30000, windowsHide: true })
    const selectedHome = join(f.home, 'existing-runtime')
    await run(['settings', 'profiles', 'add', 'existing', '--home', selectedHome])
    await run(['settings', 'set', 'profile', 'existing'])
    const plan = await saveInstallationPlan(f.root, input, f.base, 'shared')
    assert.equal(plan.undercurrent.home, selectedHome)
    assert.equal(plan.undercurrent.profile, 'existing')
    assert.equal(configuration(f.root, input).env.UNDERCURRENT_HOME, selectedHome)
    assert.equal(JSON.parse((await run(['settings', 'show'])).stdout).active_profile, 'existing')
    assert.equal(existsSync(join(f.base, 'uc')), false)
  } finally { await f.cleanup() }
})


test('discovery never executes Suite CLI wrappers that initialize private state', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture()
  try {
    const bin = join(f.home, 'bin')
    await mkdir(bin)
    const marker = join(f.home, 'unexpected-write')
    await writeFile(join(bin, 'uc'), '#!/bin/sh\n# Legacy launcher delegates to runtime.mjs\ntouch "' + marker + '"\n', { mode: 0o755 })
    const result = await discoverInstallation(f.root, { ...f.input, PATH: bin }, f.base)
    assert.equal(result.tools.length, 0)
    assert.equal(existsSync(marker), false)
    assert.equal(existsSync(f.base), false)
  } finally { await f.cleanup() }
})
