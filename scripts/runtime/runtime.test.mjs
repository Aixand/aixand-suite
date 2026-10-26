import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from './runtime.mjs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { options, saveSelection, installTools } from './setup.mjs'

test('macOS GUI launches retain the OS identity used by provider Keychain accounts', { skip: process.platform !== 'darwin' }, () => {
  const config = configuration('/runtime', { HOME: '/Users/example', USER: '', LOGNAME: '' })
  assert.equal(config.env.USER, userInfo().username)
  assert.equal(config.env.LOGNAME, userInfo().username)
  const inherited = configuration('/runtime', { HOME: '/Users/example', USER: 'existing-user', LOGNAME: 'existing-login' })
  assert.equal(inherited.env.USER, 'existing-user')
  assert.equal(inherited.env.LOGNAME, 'existing-login')
})

test('bundled paths and state do not inherit development runtime configuration or credentials', () => {
  const config = configuration('/installed suite/runtime', {
    HOME: '/users/alice', PATH: '/developer/bin', PYTHONPATH: '/developer/packages',
    AGENTS_PYTHON: '/developer/.venv/python', UNDERCURRENT_HOME: '/developer/uc',
    CARRIER_DATABASE: '/developer/carrier.db', AIXAND_PRODUCTION_PORT: '3001', API_KEY: 'private',
  })
  assert.equal(config.address, 'http://127.0.0.1:8753/')
  assert.equal(config.env.AGENTS_PYTHON, '/installed suite/runtime/python/bin/python3')
  assert.equal(config.env.UNDERCURRENT_HOME, '/users/alice/.local/share/aixand/local/uc')
  assert.equal(config.env.PYTHONPATH, undefined)
  assert.equal(config.env.API_KEY, undefined)
  assert.ok(!config.env.PATH.includes('/developer'))
  assert.equal(config.env.CARRIER_DATABASE, '/users/alice/.local/share/aixand/local/carrier/carrier.db')
})

test('headless packages configure API-only production without inheriting ambient development settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aixand-headless-config-'))
  try {
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ role: 'server' }))
    const config = configuration(root, { HOME: '/users/alice', AIXAND_PRODUCTION_MODE: 'web',
      AIXAND_PRODUCTION_TRANSPORT: 'https-proxy', AIXAND_PRODUCTION_ORIGINS: 'https://suite.example',
      AIXAND_PRODUCTION_TRUST_PROXY: '127.0.0.1' })
    assert.equal(config.model.headless, true)
    assert.equal(config.env.AIXAND_PRODUCTION_MODE, 'headless')
    assert.equal(config.env.AIXAND_PRODUCTION_ORIGINS, 'https://suite.example')
    assert.equal(config.env.AIXAND_PRODUCTION_TRANSPORT, 'https-proxy')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('supports a separate state directory and explicit unused test ports', () => {
  const config = configuration('/runtime', { HOME: '/users/alice', AIXAND_LOCAL_HOME: '/isolated/state', AIXAND_LOCAL_PORT: '18753', AIXAND_LOCAL_CARRIER_PORT: '18765' })
  assert.equal(config.address, 'http://127.0.0.1:18753/')
  assert.equal(config.env.AIXAND_PRODUCTION_ORIGINS, 'http://127.0.0.1:18753,http://localhost:18753')
  assert.equal(config.env.CARRIER_URL, 'http://127.0.0.1:18765')
  assert.equal(config.env.WORKFLOW_RUNNER_HOME, '/isolated/state/runner')
})

test('rejects ambiguous state paths and invalid or conflicting ports', () => {
  for (const env of [{ AIXAND_LOCAL_HOME: 'relative' }, { AIXAND_LOCAL_PORT: '87532' },
    { AIXAND_LOCAL_PORT: '80' }, { AIXAND_LOCAL_PORT: '8765' }, { AIXAND_LOCAL_CARRIER_PORT: 'invalid' }])
    assert.throws(() => configuration('/runtime', env))
})

test('system selection uses external Python and native tools without adding bundled tool paths', async () => {
  const base = await mkdtemp(join(tmpdir(), 'aixand-system-settings-'))
  try {
    const tools = { uc: '/system/bin/uc', runner: '/system/bin/runner', python: '/environment/bin/python3',
      pythonHome: '/base/python', pythonPaths: ['/environment/lib/python3.12/site-packages'],
      bridge: '/system/bin/uc-python-bridge', voicePython: '/voice/bin/python3', commands: { agent: '/system/bin/agent' } }
    await saveSelection(base, { mode: 'system' }, tools)
    const config = configuration('/app/runtime', { HOME: '/users/alice', AIXAND_LOCAL_HOME: base, PATH: '/user/bin:/app/runtime/bin:/usr/bin' })
    assert.equal(config.env.AGENTS_PYTHON, tools.python)
    assert.equal(config.env.WORKFLOW_PYTHON_HOME, '/base/python')
    assert.equal(config.env.UNDERCURRENT_PYTHON_BRIDGE, tools.bridge)
    assert.ok(!config.env.PATH.split(':').includes('/app/runtime/bin'))
    assert.equal(config.env.PROMPT_MANAGER_HOME, join(base, 'prompts'))
    assert.equal(config.selection.reuseConfig, false)
    await saveSelection(base, { mode: 'system', reuseConfig: true }, tools, { PROMPT_MANAGER_HOME: '/existing/prompts' })
    const reused = configuration('/app/runtime', { HOME: '/users/alice', AIXAND_LOCAL_HOME: base })
    assert.equal(reused.env.PROMPT_MANAGER_HOME, '/existing/prompts')
    assert.equal(reused.env.AGENT_MANAGER_CONFIG, undefined)
    assert.equal(reused.env.UNDERCURRENT_HOME, join(base, 'uc'))
    assert.notEqual(reused.identity, config.identity)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('setup rejects relative executable paths and unintended configuration reuse', () => {
  assert.throws(() => options({ mode: 'other' }))
  assert.throws(() => options({ mode: 'system', python: 'python3' }))
  assert.throws(() => options({ mode: 'bundled', reuseConfig: true }))
})

test('default CLI installation directory must stay outside the application', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'aixand-cli-default-'))
  try {
    const root = join(home, '.local/bin')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ build: 'fixture' }))
    await assert.rejects(installTools(root, { HOME: home }, { mode: 'system' }), /outside the Aixand application/)
  } finally { await rm(home, { recursive: true, force: true }) }
})
