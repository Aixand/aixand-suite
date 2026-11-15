import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configuration, retainRuntimeReceipt, deploymentArguments, doctor, uninstallProducts } from './runtime.mjs'
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { options } from './setup.mjs'

test('first-run doctor initializes default configuration and preserves existing preferences', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aixand-doctor-first-run-'))
  try {
    const root = join(directory, 'runtime'), base = join(directory, 'workspace')
    await mkdir(root)
    await mkdir(join(root, 'server/agent-bridge'), { recursive: true })
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ features: { voice: false } }))
    await writeFile(join(root, 'providers.toml'), '# packaged provider defaults\n')
    const probe = join(directory, 'python-probe')
    await writeFile(probe, '#!' + process.execPath + '\n' +
      'const fs=require("node:fs"); if(!fs.existsSync(process.env.AGENT_MANAGER_CONFIG)) process.exit(2);\n', { mode: 0o700 })
    const config = configuration(root, { HOME: directory, AIXAND_LOCAL_HOME: base })
    config.tools.python = probe
    config.tools.pythonPrefix = join(directory, 'selected-venv')
    config.tools.pythonExecutable = join(config.tools.pythonPrefix, 'bin/python3')
    config.tools.pythonBaseExecutable = join(directory, 'base-python')
    config.env.AGENTS_PYTHON = probe
    assert.equal((await doctor(config)).ready, true)
    const sdk = JSON.parse(await readFile(config.env.WORKFLOW_SDK_CONFIG, 'utf8'))
    assert.deepEqual(sdk.python_interpreter, { executable: config.tools.pythonExecutable, home: config.tools.pythonHome,
      prefix: config.tools.pythonPrefix, base_executable: config.tools.pythonBaseExecutable })
    const preferences = join(base, 'config/providers.toml')
    assert.equal(await readFile(preferences, 'utf8'), '# packaged provider defaults\n')
    await writeFile(preferences, '# retained preferences\n')
    assert.equal((await doctor(config)).ready, true)
    assert.equal(await readFile(preferences, 'utf8'), '# retained preferences\n')
    config.selection.reuseConfig = true
    config.env.AGENT_MANAGER_CONFIG = join(directory, 'missing-custom.toml')
    await assert.rejects(doctor(config), /Agent Manager configuration does not exist/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

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

test('explicit enterprise CA certificates survive packaged service launches without accepting TLS bypasses', () => {
  const config = configuration('/runtime', { HOME: '/users/alice', NODE_EXTRA_CA_CERTS: '/certificates/company-ca.pem', NODE_TLS_REJECT_UNAUTHORIZED: '0' })
  assert.equal(config.env.NODE_EXTRA_CA_CERTS, '/certificates/company-ca.pem')
  assert.equal(config.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined)
  assert.throws(() => configuration('/runtime', { HOME: '/users/alice', NODE_EXTRA_CA_CERTS: 'relative.pem' }), /absolute certificate/)
})

test('rejects ambiguous state paths and invalid or conflicting ports', () => {
  for (const env of [{ AIXAND_LOCAL_HOME: 'relative' }, { AIXAND_LOCAL_PORT: '87532' },
    { AIXAND_LOCAL_PORT: '80' }, { AIXAND_LOCAL_PORT: '8765' }, { AIXAND_LOCAL_CARRIER_PORT: 'invalid' }])
    assert.throws(() => configuration('/runtime', env))
})

test('unsupported saved tool selections are rejected without altering their contents', async () => {
  const base = await mkdtemp(join(tmpdir(), 'aixand-unsupported-setup-'))
  try {
    await mkdir(join(base, 'config'))
    const path = join(base, 'config/setup.json'), content = JSON.stringify({ schema: 1, mode: 'system' })
    await writeFile(path, content)
    assert.throws(() => configuration('/runtime', { HOME: base, AIXAND_LOCAL_HOME: base }), /Unsupported saved tool selection/)
    assert.equal(await readFile(path, 'utf8'), content)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('setup rejects relative executable paths and unintended configuration reuse', () => {
  assert.throws(() => options({ mode: 'other' }))
  assert.throws(() => options({ mode: 'system', python: 'python3' }))
  assert.throws(() => options({ mode: 'bundled', reuseConfig: true }))
})

test('tool activation permits a shared daemon without a workspace receipt and preserves ownership checks', { skip: process.platform === 'win32' }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'aixand-activation-'))
  try {
    const uc = join(base, 'uc')
    await writeFile(uc, '#!' + process.execPath + '\nconsole.log(process.env.TEST_SESSIONS)\n')
    await chmod(uc, 0o700)
    const config = { base, root: '/runtime', identity: 'old', server: base, tools: { uc },
      plan: { instanceId: 'workspace', undercurrent: { owned: false } },
      env: { TEST_SESSIONS: JSON.stringify({ items: [
        { labels: { 'suite.instance': 'other' }, lifecycle: { state: 'running' } },
      ] }) } }
    const next = { identity: 'new' }
    const path = join(base, 'runtime.json')
    await retainRuntimeReceipt(config, next)
    await assert.rejects(readFile(path), { code: 'ENOENT' })
    for (const state of ['running', 'starting', 'stopping']) {
      config.env.TEST_SESSIONS = JSON.stringify({ items: [
        { labels: { 'suite.instance': 'workspace' }, lifecycle: { state } },
      ] })
      await assert.rejects(retainRuntimeReceipt(config, next), /active without runtime ownership data/)
    }
    await writeFile(path, '{invalid')
    await assert.rejects(retainRuntimeReceipt(config, next), SyntaxError)
    await writeFile(path, JSON.stringify({ root: '/other', identity: 'old' }))
    await assert.rejects(retainRuntimeReceipt(config, next), /Another runtime owns/)
    config.env.TEST_SESSIONS = JSON.stringify({ items: [] })
    await retainRuntimeReceipt(config, next)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).root, '/other')
    const receipt = { schema: 1, root: config.root, identity: config.identity, build: 'test' }
    await writeFile(path, JSON.stringify(receipt))
    await retainRuntimeReceipt(config, next)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ...receipt, identity: 'new' })
  } finally { await rm(base, { recursive: true, force: true }) }
})


test('managed service deployment survives a daemon with an older environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aixand-deployment-'))
  try {
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ role: 'server' }))
    for (const transport of ['loopback', 'https-proxy']) {
      const origin = transport === 'loopback' ? 'http://127.0.0.1:18753' : 'https://suite.example'
      const parent = configuration(root, { HOME: '/users/alice', AIXAND_PRODUCTION_TRANSPORT: transport,
        AIXAND_PRODUCTION_ORIGINS: origin, AIXAND_PRODUCTION_TRUST_PROXY: transport === 'loopback' ? '' : '127.0.0.1' })
      const args = deploymentArguments(parent)
      const daemon = { HOME: '/users/alice', AIXAND_PRODUCTION_TRANSPORT: 'loopback', AIXAND_PRODUCTION_ORIGINS: 'http://localhost:8753' }
      for (let i = 0; i < args.length; i += 2) {
        assert.equal(args[i], '--env')
        const index = args[i + 1].indexOf('=')
        daemon[args[i + 1].slice(0, index)] = args[i + 1].slice(index + 1)
      }
      const child = configuration(root, daemon)
      assert.equal(child.env.AIXAND_PRODUCTION_ORIGINS, origin)
      assert.equal(child.env.AIXAND_PRODUCTION_TRANSPORT, transport)
      assert.equal(child.env.AIXAND_PRODUCTION_TRUST_PROXY, parent.env.AIXAND_PRODUCTION_TRUST_PROXY)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('voice inclusion follows the package manifest, overriding inherited flags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'suite-voice-capability-'))
  try {
    for (const voice of [false, true]) {
      await writeFile(join(root, 'manifest.json'), JSON.stringify({ features: { voice } }))
      const config = configuration(root, { HOME: root, AIXAND_VOICE_ENABLED: voice ? '0' : '1' })
      assert.equal(config.env.AIXAND_VOICE_ENABLED, voice ? '1' : '0')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('application-only cleanup preserves a shared daemon but blocks active private-product removal', { skip: process.platform === 'win32' }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'aixand-remove-products-'))
  try {
    const uc = join(base, 'uc'), calls = join(base, 'calls')
    await writeFile(uc, '#!' + process.execPath + '\nrequire("node:fs").appendFileSync(process.env.TEST_CALLS, "called\\n"); console.log(JSON.stringify({accepting_connections:true}))\n', { mode: 0o700 })
    const config = { root: join(base, 'no-application'), base, input: { HOME: base }, tools: { uc }, env: { TEST_CALLS: calls } }
    assert.deepEqual(await uninstallProducts(config), { sharedProductsPreserved: true })
    await assert.rejects(readFile(calls), { code: 'ENOENT' })
    await mkdir(join(base, 'software/products'), { recursive: true })
    await assert.rejects(uninstallProducts(config), /Stop local services/)
    assert.equal(await readFile(calls, 'utf8'), 'called\n')
  } finally { await rm(base, { recursive: true, force: true }) }
})
