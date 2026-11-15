import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { productCatalog, productLocation, productStatus, installedProductTools, installProducts, validateInstalledProducts } from './products.mjs'
import { saveInstallationPlan } from './installation-plan.mjs'
import { configuration, setup } from './runtime.mjs'
import { reserveActivation } from './activation.mjs'
import { productObjectPath, productSelectionPath } from './product-selection.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

async function selectUpdatedProduct(f, id = 'agent-manager') {
  const original = f.catalog.assemblies.find(row => row.id === id)
  const product = { id, version: '2', release: hash('updated:' + id), commands: Object.fromEntries(original.products[id].commands.map(name => [name, {}])) }
  const bytes = JSON.stringify({ schema: 2, kind: 'product', target: f.catalog.target, baseline: {}, products: { [id]: product } })
  const digest = hash(bytes), artifact = productObjectPath(f.base, id, digest)
  await mkdir(artifact, { recursive: true })
  await writeFile(join(artifact, 'release-manifest.json'), bytes)
  await mkdir(join(f.base, 'config'), { recursive: true })
  await writeFile(productSelectionPath(f.base), JSON.stringify({ schema: 1, assemblies: { [id]: { manifestSha256: digest } } }))
  return { id, product, artifact }
}

test('independent product selection survives a new application baseline and preserves other tools', async () => {
  const f = await fixture('isolated')
  try {
    const selected = await selectUpdatedProduct(f)
    const { prefix } = productLocation(f.root, f.input, f.base)
    await mkdir(prefix, { recursive: true })
    const products = Object.fromEntries(f.catalog.assemblies.flatMap(row => Object.entries(row.products).map(([id, product]) => [id, { product }])))
    products[selected.id] = { product: selected.product }
    await writeFile(join(prefix, 'installation-receipt.json'), JSON.stringify({ schema: 2, scope: 'private', owner: 'aixand-suite', products }))
    assert.equal(productStatus(f.root, f.input, f.base).ready, true)
    assert.deepEqual(productStatus(f.root, f.input, f.base).assemblies.find(row => row.id === selected.id).currentVersions, ['2'])
    assert.equal(productLocation(f.root, f.input, f.base).catalog.assemblies.find(row => row.id === selected.id).artifact, selected.artifact)
    f.catalog.assemblies.find(row => row.id === selected.id).products[selected.id].release = hash('new-app-baseline')
    const bytes = JSON.stringify(f.catalog)
    await writeFile(join(f.root, 'products/catalog.json'), bytes)
    await writeFile(join(f.root, 'manifest.json'), JSON.stringify({ installation: { schema: 1, edition: 'distributed', catalogSha256: hash(bytes) } }))
    assert.equal(productStatus(f.root, f.input, f.base).ready, true)
    assert.equal(productLocation(f.root, f.input, f.base).catalog.assemblies.find(row => row.id === 'runner').products.runner.release, hash('runner'))
    await writeFile(join(selected.artifact, 'release-manifest.json'), '{}')
    assert.throws(() => productStatus(f.root, f.input, f.base), /manifest changed/)
  } finally { await f.cleanup() }
})

test('product selections reject unknown products and redirected immutable objects', async () => {
  const f = await fixture('isolated')
  try {
    const selected = await selectUpdatedProduct(f)
    await rm(join(selected.artifact, 'release-manifest.json'))
    await symlink(join(f.root, 'products/catalog.json'), join(selected.artifact, 'release-manifest.json'))
    assert.throws(() => productLocation(f.root, f.input, f.base), /redirected/)
    await writeFile(productSelectionPath(f.base), JSON.stringify({ schema: 1, assemblies: { unknown: { manifestSha256: hash('unknown') } } }))
    assert.throws(() => productLocation(f.root, f.input, f.base), /not included/)
  } finally { await f.cleanup() }
})
async function fixture(mode = 'shared') {
  const temporary = await mkdtemp(join(tmpdir(), 'product-state-'))
  const root = join(temporary, 'app'), base = join(temporary, 'state'), home = join(temporary, 'home')
  const target = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform] + '-' +
    ({ x64: 'x86_64', arm64: 'arm64' }[process.arch]) +
    (process.platform === 'linux' ? '-gnu' : process.platform === 'win32' ? '-msvc' : '')
  await mkdir(join(root, 'products/consumer'), { recursive: true })
  await writeFile(join(root, 'products/consumer/consumer.py'), '# fixture')
  const names = ['undercurrent', 'runner', 'carrier', 'agent-manager', 'conversation-manager', 'mcp-manager', 'prompt-manager', 'skill-manager', 'orchestration-mcp']
  const catalog = { schema: 1, target, consumer: { 'consumer/consumer.py': hash('# fixture') },
    assemblies: names.map(id => ({ id, artifact: 'artifacts/' + id, licenses: [],
      products: { [id]: { version: '1', release: hash(id), commands: [id === 'undercurrent' ? 'uc' : id] } } })) }
  const text = JSON.stringify(catalog)
  await writeFile(join(root, 'products/catalog.json'), text)
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ installation: { schema: 1, edition: 'distributed', catalogSha256: hash(text) } }))
  const input = { HOME: home, LOCALAPPDATA: join(home, 'AppData/Local') }
  await saveInstallationPlan(root, input, base, mode)
  return { root, base, input, catalog, cleanup: () => rm(temporary, { recursive: true, force: true }) }
}

// A disposable consumer enforces the engine's request fingerprint contract,
// without provisioning real products or registering commands in the user's PATH.
const testConsumer = `import argparse, hashlib, json, sys
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('operation')
for flag in ('artifact', 'expected-sha256', 'prefix', 'scope', 'owner', 'request-id', 'events'):
    parser.add_argument('--' + flag)
args = parser.parse_args()
prefix = Path(args.prefix)
receipt = prefix / 'installation-receipt.json'
if args.operation == 'inspect':
    assert json.loads(receipt.read_text())['schema'] == 2
    sys.exit(0)
catalog = json.loads((Path(__file__).parents[1] / 'catalog.json').read_text())
row = next(row for row in catalog['assemblies'] if row['id'] == Path(args.artifact).name)
assert args.expected_sha256 == row['manifest_sha256']
inputs = dict(manifest=args.expected_sha256, selection=row['id'], operation=args.operation, origin='artifact')
fingerprint = hashlib.sha256((json.dumps(inputs, indent=2, sort_keys=True) + '\\n').encode()).hexdigest()
state = json.loads(receipt.read_text()) if receipt.exists() else dict(
    schema=2, scope=args.scope, owner=args.owner, products={}, requests={})
previous = state['requests'].get(args.request_id)
if previous and previous['input'] != fingerprint:
    sys.exit('Request ID was already used with different inputs')
with (prefix / 'calls.jsonl').open('a') as log:
    log.write(json.dumps(dict(assembly=row['id'], operation=args.operation, request=args.request_id)) + '\\n')
state['requests'][args.request_id] = dict(input=fingerprint, status='running')
receipt.write_text(json.dumps(state))
fail_once = prefix / 'fail-once'
if fail_once.exists() and fail_once.read_text() == row['id']:
    fail_once.unlink()
    sys.exit('Installation interrupted for test')
for name, product in row['products'].items():
    state['products'][name] = dict(product=product)
state['requests'][args.request_id]['status'] = 'complete'
receipt.write_text(json.dumps(state))
`

async function installationFixture(mode = 'isolated') {
  const f = await fixture(mode)
  try {
    // Windows qualification supplies the packaged Python home, which also has
    // aixand_local_runtime for the production process identity check.
    const pythonHome = process.env.AIXAND_TEST_PYTHON_HOME || execFileSync('python3',
      ['-I', '-c', 'import sys; print(sys.base_prefix)'], { encoding: 'utf8' }).trim()
    await symlink(pythonHome, join(f.root, 'python'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(f.root, 'products/consumer/consumer.py'), testConsumer)
    f.catalog.consumer['consumer/consumer.py'] = hash(testConsumer)
    for (const row of f.catalog.assemblies) row.manifest_sha256 = hash('manifest:' + row.id)
    const text = JSON.stringify(f.catalog)
    await writeFile(join(f.root, 'products/catalog.json'), text)
    await writeFile(join(f.root, 'manifest.json'), JSON.stringify({ installation: {
      schema: 1, edition: 'distributed', catalogSha256: hash(text),
    } }))
    const { prefix } = productLocation(f.root, f.input, f.base)
    await mkdir(prefix, { recursive: true })
    return { ...f, prefix, digest: hash(text),
      receipt: join(prefix, 'installation-receipt.json'),
      calls: async () => (await readFile(join(prefix, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
  } catch (error) { await f.cleanup(); throw error }
}

test('shared setup reuses a compatible external tool and installs only missing products', { skip: process.platform === 'win32' }, async () => {
  const f = await installationFixture('shared')
  await rm(join(f.base, 'config/installation-plan.json'))
  try {
    const bin = join(f.input.HOME, 'external-bin')
    await mkdir(bin, { recursive: true })
    const runner = join(bin, 'runner')
    await writeFile(runner, '#!' + process.execPath + '\nconsole.log("runner 1")\n', { mode: 0o755 })
    const prefix = join(f.input.HOME, 'shared-products')
    await mkdir(prefix, { recursive: true })
    const input = { ...f.input, PATH: bin, AIXAND_LOCAL_HOME: f.base, AIXAND_SHARED_PRODUCT_PREFIX: prefix }
    const plan = await saveInstallationPlan(f.root, input, f.base, 'shared')
    assert.equal(plan.reusedProducts.runner.commands.runner, runner)
    const result = await installProducts(f.root, input, f.base)
    assert.equal(result.ready, true)
    const calls = (await readFile(join(prefix, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(!calls.some(call => call.assembly === 'runner'))
    assert.equal(installedProductTools(f.root, input, f.base).runner, runner)
    await writeFile(runner, '#!' + process.execPath + '\nconsole.log("runner 2")\n', { mode: 0o755 })
    await assert.rejects(validateInstalledProducts(f.root, input, f.base), /changed version/)
  } finally { await f.cleanup() }
})

test('explicit repair re-executes installed releases and distinct repairs use distinct requests', async () => {
  const f = await installationFixture()
  try {
    await installProducts(f.root, f.input, f.base)
    await installProducts(f.root, f.input, f.base, { repair: true })
    const first = await f.calls()
    assert.equal(first.length, 18)
    assert.ok(first.slice(9).every(call => call.operation === 'reinstall'))
    await installProducts(f.root, f.input, f.base, { repair: true })
    const second = (await f.calls()).slice(18)
    assert.equal(second.length, 9)
    assert.ok(second.every(call => !first.some(old => old.request === call.request)))
  } finally { await f.cleanup() }
})
test('setup and repair cannot mutate products while an update owns activation', async () => {
  const f = await installationFixture()
  try {
    await installProducts(f.root, f.input, f.base)
    const before = await readFile(f.receipt, 'utf8'), calls = await f.calls()
    await reserveActivation(f.base, 'another-update', 'product')
    const config = configuration(f.root, { ...f.input, AIXAND_LOCAL_HOME: f.base })
    await assert.rejects(setup(config, 'install', JSON.stringify({ repair: true })), /activation is reserved/)
    assert.equal(await readFile(f.receipt, 'utf8'), before)
    assert.deepEqual(await f.calls(), calls)
  } finally { await f.cleanup() }
})

test('setup can install removed products while retaining earlier upgrade request history', async () => {
  const f = await installationFixture()
  try {
    const requests = Object.fromEntries(f.catalog.assemblies.slice(1).map(row => [
      'suite-' + f.digest.slice(0, 20) + '-' + row.id,
      { input: hash(JSON.stringify({ manifest: row.manifest_sha256, operation: 'upgrade', origin: 'artifact', selection: row.id }, null, 2) + '\n'),
        status: 'complete' },
    ]))
    await writeFile(f.receipt, JSON.stringify({ schema: 2, scope: 'private', owner: 'aixand-suite', requests,
      products: { undercurrent: { product: f.catalog.assemblies[0].products.undercurrent } } }))
    await writeFile(join(f.prefix, 'history.txt'), 'existing user history')
    const result = await installProducts(f.root, f.input, f.base)
    assert.equal(result.status, 'complete')
    assert.equal(result.ready, true)
    const receipt = JSON.parse(await readFile(f.receipt, 'utf8'))
    for (const [id, previous] of Object.entries(requests)) assert.deepEqual(receipt.requests[id], previous)
    assert.equal(await readFile(join(f.prefix, 'history.txt'), 'utf8'), 'existing user history')
    const calls = await f.calls()
    assert.deepEqual(calls.map(call => call.assembly), f.catalog.assemblies.slice(1).map(row => row.id))
    assert.ok(calls.every(call => call.operation === 'install' && !requests[call.request]))
  } finally { await f.cleanup() }
})

test('setup retries reuse a request but installing after removal does not reuse an upgrade request', async () => {
  const f = await installationFixture()
  try {
    await writeFile(f.receipt, JSON.stringify({ schema: 2, scope: 'private', owner: 'aixand-suite', requests: {},
      products: { undercurrent: { product: { release: 'older-release' } } } }))
    await writeFile(join(f.prefix, 'fail-once'), 'undercurrent')
    await assert.rejects(installProducts(f.root, f.input, f.base), /Installation interrupted for test/)
    assert.equal(productStatus(f.root, f.input, f.base).job.status, 'error')
    assert.equal((await installProducts(f.root, f.input, f.base)).ready, true)
    const receipt = JSON.parse(await readFile(f.receipt, 'utf8'))
    delete receipt.products.undercurrent // Uninstall retains the request history.
    await writeFile(f.receipt, JSON.stringify(receipt))
    assert.equal((await installProducts(f.root, f.input, f.base)).ready, true)
    const calls = (await f.calls()).filter(call => call.assembly === 'undercurrent')
    assert.deepEqual(calls.map(call => call.operation), ['upgrade', 'upgrade', 'install'])
    assert.equal(calls[0].request, calls[1].request)
    assert.notEqual(calls[1].request, calls[2].request)
    assert.ok(calls.every(call => /^[A-Za-z0-9_-]{1,128}$/.test(call.request)))
  } finally { await f.cleanup() }
})

test('setup mode controls ownership and never adopts another owner', async () => {
  for (const mode of ['isolated', 'shared']) {
    const f = await fixture(mode)
    try {
      const location = productLocation(f.root, f.input, f.base)
      assert.equal(location.scope, mode === 'isolated' ? 'private' : 'shared')
      assert.equal(productStatus(f.root, f.input, f.base).ready, false)
      await mkdir(location.prefix, { recursive: true })
      await writeFile(join(location.prefix, 'installation-receipt.json'), JSON.stringify({
        schema: 2, scope: location.scope, owner: 'another-app', products: {},
      }))
      assert.throws(() => productStatus(f.root, f.input, f.base), /different owner/)
    } finally { await f.cleanup() }
  }
})

test('catalog and engine changes fail before installer execution', async () => {
  const f = await fixture('shared')
  try {
    assert.equal(productCatalog(f.root).assemblies.length, 9)
    await writeFile(join(f.root, 'products/consumer/consumer.py'), '# changed')
    assert.throws(() => productCatalog(f.root), /engine integrity/)
    await writeFile(join(f.root, 'products/catalog.json'), '{}')
    assert.throws(() => productCatalog(f.root), /catalog integrity/)
  } finally { await f.cleanup() }
})

test('an interrupted job cannot claim a live process that reused its PID', async () => {
  const f = await fixture('shared')
  try {
    await mkdir(join(f.base, 'config'), { recursive: true })
    await writeFile(join(f.base, 'config/product-installation.json'), JSON.stringify({
      catalog: productCatalog(f.root).digest, pid: process.pid, birth: 'previous-process',
      status: 'running',
    }))
    assert.equal(productStatus(f.root, f.input, f.base).job.status, 'interrupted')
  } finally { await f.cleanup() }
})

test('service children retain the normal shared prefix while using private Suite data homes', async () => {
  const f = await fixture('shared')
  try {
    const config = configuration(f.root, { ...f.input, XDG_DATA_HOME: join(f.input.HOME, 'user-data'),
      AIXAND_LOCAL_HOME: f.base, AIXAND_SKIP_PATH_REGISTRATION: '1' })
    const child = configuration(f.root, config.env)
    assert.equal(child.products.prefix, config.products.prefix)
    assert.equal(config.env.AIXAND_SKIP_PATH_REGISTRATION, '1')
    assert.equal(child.input.AIXAND_SKIP_PATH_REGISTRATION, '1')
    assert.ok(!child.products.prefix.startsWith(f.base))
    if (process.platform === 'linux') assert.equal(child.products.prefix, join(f.input.HOME, 'user-data/aixand/products'))
  } finally { await f.cleanup() }
})

test('separate product environments do not replace the Suite API environment', async () => {
  const f = await fixture('shared')
  try {
    const location = productLocation(f.root, f.input, f.base)
    await mkdir(location.prefix, { recursive: true })
    const products = Object.fromEntries(f.catalog.assemblies.map(row => [row.id, {
      python: join(location.prefix, row.id, 'python'),
      product: { release: row.products[row.id].release, commands: Object.fromEntries(row.products[row.id].commands.map(name => [name, {}])) },
    }]))
    await writeFile(join(location.prefix, 'installation-receipt.json'), JSON.stringify({
      schema: 2, scope: 'shared', owner: 'user', products,
    }))
    assert.equal(productStatus(f.root, f.input, f.base).ready, true)
    const tools = installedProductTools(f.root, f.input, f.base)
    assert.ok(tools.python.startsWith(join(f.root, 'python')))
    assert.equal(tools.pythonPrefix, tools.pythonHome)
    assert.equal(tools.pythonExecutable, tools.python)
    assert.equal(tools.pythonBaseExecutable, tools.python)
    assert.ok(tools.carrierPython.startsWith(location.prefix))
    assert.ok(tools.runner.startsWith(location.prefix))
    assert.ok(tools.workflowRunner.startsWith(f.root))
    const config = configuration(f.root, { ...f.input, AIXAND_LOCAL_HOME: f.base })
    assert.equal(config.env.CARRIER_PYTHON, tools.python)
    assert.notEqual(config.env.CARRIER_PYTHON, tools.carrierPython)
    const child = configuration(f.root, config.env)
    assert.equal(child.env.CARRIER_PYTHON, tools.python)
    assert.equal(child.tools.carrierPython, tools.carrierPython)
    products.runner.product.release = 'another-release'
    await writeFile(join(location.prefix, 'installation-receipt.json'), JSON.stringify({
      schema: 2, scope: 'shared', owner: 'user', products,
    }))
    assert.equal(productStatus(f.root, f.input, f.base).ready, false)
  } finally { await f.cleanup() }
})


test('one package supports private software ownership when isolated setup is selected', async () => {
  const f = await fixture('isolated')
  try {
    await saveInstallationPlan(f.root, f.input, f.base, 'isolated')
    const location = productLocation(f.root, f.input, f.base)
    assert.equal(location.scope, 'private')
    assert.equal(location.owner, 'aixand-suite')
    assert.equal(location.prefix, join(f.base, 'software/products'))
    const config = configuration(f.root, { ...f.input, AIXAND_LOCAL_HOME: f.base })
    assert.equal(config.env.AGENT_MANAGER_HOME, join(f.base, 'agents'))
    assert.equal(productStatus(f.root, f.input, f.base).edition, 'distributed')
  } finally { await f.cleanup() }
})

test('shared setup reuses native manager state without requiring a private UC connection registration', async () => {
  const f = await fixture('shared')
  try {
    await saveInstallationPlan(f.root, f.input, f.base, 'shared')
    const config = configuration(f.root, { ...f.input, AIXAND_LOCAL_HOME: f.base })
    assert.equal(config.env.AGENT_MANAGER_HOME, join(f.input.HOME, '.local/share/aixand/manager/agent/state'))
    assert.equal(productStatus(f.root, f.input, f.base).connectionSetupRequired, false)
    assert.equal(productLocation(f.root, f.input, f.base).scope, 'shared')
  } finally { await f.cleanup() }
})

test('individual published managers and Suite-owned MCP retain distinct release identities', async () => {
  const f = await fixture('shared')
  try {
    const managers = ['agent-manager', 'conversation-manager', 'mcp-manager', 'prompt-manager', 'skill-manager']
    const names = ['undercurrent', 'runner', 'carrier', ...managers, 'orchestration-mcp']
    f.catalog.assemblies = names.map(id => ({ id, artifact: 'artifacts/' + id, licenses: [],
      products: { [managers.includes(id) || id === 'orchestration-mcp' ? 'manager-suite/' + id : id]: {
        version: '0.1.0-beta', release: hash('published-' + id), commands: [id],
      } } }))
    const save = async () => {
      const text = JSON.stringify(f.catalog)
      await writeFile(join(f.root, 'products/catalog.json'), text)
      await writeFile(join(f.root, 'manifest.json'), JSON.stringify({ installation: {
        schema: 1, edition: 'distributed', catalogSha256: hash(text),
      } }))
    }
    await save()
    const catalog = productCatalog(f.root)
    assert.equal(catalog.assemblies.length, 9)
    assert.equal(catalog.assemblies.find(row => row.id === 'agent-manager').products['manager-suite/agent-manager'].release,
      hash('published-agent-manager'))
    f.catalog.assemblies[8] = { ...f.catalog.assemblies[8], id: 'manager-suite', artifact: 'artifacts/manager-suite' }
    await save()
    assert.throws(() => productCatalog(f.root), /does not match|incomplete/)
  } finally { await f.cleanup() }
})
