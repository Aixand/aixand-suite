// Native product-engine qualification in disposable homes. This does not qualify
// the GUI, HTTP API, native application installer, or real Server restart.
import assert from 'node:assert/strict'
import { constants, createReadStream, existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { parseArgs, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { installProducts, installedProductTools, productStatus, removePrivateProducts } from './products.mjs'
import { saveInstallationPlan } from './installation-plan.mjs'
import { productObjectPath, productSelectionPath } from './product-selection.mjs'
import { productUpdateAction, productUpdateState, saveProductUpdateState, currentProductUpdatePlan } from './product-updates.mjs'
import { runProductUpdateWorker } from './product-update-worker.mjs'
import { pythonPath } from './platform.mjs'

const execute = promisify(execFile), own = dirname(fileURLToPath(import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fileHash(file) {
  const digest = createHash('sha256'); for await (const block of createReadStream(file)) digest.update(block); return digest.digest('hex')
}
export async function qualifyProductEngine(options) {
  for (const name of ['runtime', 'old-artifact', 'new-archive', 'new-sha256', 'work', 'report']) assert.ok(options[name], 'Required: --' + name)
  const source = resolve(options.runtime), work = resolve(options.work), root = join(work, 'application'), base = join(work, 'workspace')
  assert.ok(!existsSync(work), 'Choose a fresh disposable qualification directory')
  await mkdir(work, { recursive: true, mode: 0o700 }); await writeFile(join(work, 'OWNED_BY_PRODUCT_UPDATE_QUALIFICATION'), 'engine-only\n')
  const home = join(work, 'home'), temporary = process.platform === 'win32' ? join(work, 'tmp') : await mkdtemp('/tmp/a3p-')
  for (const path of [home, temporary, base]) await mkdir(path, { recursive: true })
  for (const name of Object.keys(process.env)) if (/^(AGENT_MANAGER_|CONVERSATION_MANAGER_|MCP_MANAGER_|PROMPT_MANAGER_|SKILL_MANAGER_|AIXAND_MANAGER_|UNDERCURRENT_|RUNNER_|ORCHESTRATION_)/.test(name)
    || ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'GH_TOKEN', 'GITHUB_TOKEN', 'CLOUDFLARE_API_TOKEN', 'UPDATE_SIGNING_KEY'].includes(name)) delete process.env[name]
  Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'),
    AIXAND_LOCAL_HOME: base, AIXAND_SHARED_PRODUCT_PREFIX: join(work, 'unused-shared-store'), AIXAND_SKIP_PATH_REGISTRATION: '1', TMPDIR: temporary, TMP: temporary, TEMP: temporary })
  await mkdir(root)
  for (const name of ['manifest.json', 'python', 'products']) await cp(join(source, name), join(root, name), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await cp(join(own, 'product-update-artifact.py'), join(root, 'product-update-artifact.py'))
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  assert.match(manifest.build, /^[a-f0-9]{64}$/)
  const pair = generateKeyPairSync('ed25519'), trust = { schema: 1, enabled: true, origin: 'https://downloads.aixand.org',
    keys: { qualification: pair.publicKey.export({ type: 'spki', format: 'pem' }) } }
  await writeFile(join(root, 'update-config.json'), JSON.stringify(trust))
  const config = { root, base, input: { ...process.env }, env: { ...process.env } }
  const oldArtifact = resolve(options['old-artifact']), oldBytes = await readFile(join(oldArtifact, 'release-manifest.json'))
  const oldManifest = JSON.parse(oldBytes), oldDigest = hash(oldBytes)
  assert.equal(oldManifest.selection, 'runner'); assert.equal(oldManifest.target, JSON.parse(await readFile(join(root, 'products/catalog.json'), 'utf8')).target)
  const selected = productObjectPath(base, 'runner', oldDigest)
  await mkdir(dirname(selected), { recursive: true }); await cp(oldArtifact, selected, { recursive: true })
  await mkdir(join(base, 'config'))
  await writeFile(productSelectionPath(base), JSON.stringify({ schema: 1, assemblies: { runner: { manifestSha256: oldDigest, compatibleBuilds: [manifest.build] } } }))
  await saveInstallationPlan(root, config.input, base, 'isolated')
  const { productCatalog } = await import('./products.mjs')
  const acceptedLicenses = productCatalog(root).assemblies.flatMap(row => row.licenses).map(row => row.sha256)
  console.log('Installing nine real products in the disposable private store.')
  await installProducts(root, config.input, base, { acceptedLicenses })
  const commandVersion = async () => (await execute(installedProductTools(root, config.input, base).runner, ['--version'], { env: config.input, windowsHide: true })).stdout.trim()
  assert.ok((await commandVersion()).includes(oldManifest.products.runner.version))
  const before = JSON.parse(await readFile(join(base, 'software/products/installation-receipt.json'), 'utf8'))
  await writeFile(join(base, 'history-marker'), 'keep history, settings and account state')
  const archive = resolve(options['new-archive']); assert.equal(await fileHash(archive), options['new-sha256'])
  const candidateBytes = await readFile(join(root, 'products/artifacts/runner/release-manifest.json')), nextManifest = JSON.parse(candidateBytes)
  const catalog = JSON.parse(await readFile(join(root, 'products/catalog.json'), 'utf8')), row = catalog.assemblies.find(row => row.id === 'runner')
  assert.notEqual(oldManifest.products.runner.version, nextManifest.products.runner.version)
  const payload = JSON.stringify({ schema: 1, product: 'aixand-suite-products', target: catalog.target, sequence: 1,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), products: { runner: {
      selection: 'runner', version: nextManifest.products.runner.version, release: nextManifest.products.runner.release, compatibleBuilds: [manifest.build], requires: {},
      licenses: row.licenses, artifact: { url: trust.origin + '/aixand-suite-products/' + catalog.target + '/runner/candidate.archive',
        sha256: options['new-sha256'], size: (await stat(archive)).size, manifestSha256: hash(candidateBytes) } } } })
  const envelope = { schema: 1, keyId: 'qualification', payload, signature: sign(null, Buffer.from(payload), pair.privateKey).toString('base64') }
  const events = []; let running = true, jobFile
  const dependencies = { fetch: async url => url.endsWith('/latest.json') ? new Response(JSON.stringify(envelope)) : new Response(Readable.toWeb(createReadStream(archive))),
    lifecycle: { status: async () => ({ services: [{ state: running ? 'running' : 'stopped' }] }), updateBlockers: async () => [],
      prepareUpdate: async () => { events.push('prepare') }, stop: async () => { running = false; events.push('stop') },
      start: async () => { assert.ok((await commandVersion()).includes(nextManifest.products.runner.version)); running = true; events.push('restart-fixture') } },
    launchWorker: async ({ job }) => { jobFile = job; return { outsideLifecycle: true, pid: process.pid } } }
  await productUpdateAction(config, 'check', {}, dependencies)
  assert.deepEqual(Object.keys((await productUpdateAction(config, 'status')).candidates), ['runner'])
  await productUpdateAction(config, 'download', { products: ['runner'] }, dependencies)
  const plan = await currentProductUpdatePlan(config, productUpdateState(config), dependencies)
  assert.equal(plan.ready, true); assert.deepEqual(plan.blockers, [])
  console.log('Applying the signed Runner update through the real native installation engine.')
  await productUpdateAction(config, 'install', { confirmed: true, revision: plan.revision, acceptedLicenses, restartConsent: true }, dependencies)
  const job = JSON.parse(await readFile(jobFile, 'utf8'))
  await runProductUpdateWorker(config, { ...job, path: jobFile }, { ...dependencies, outsideLifecycle: true })
  assert.equal(productStatus(root, config.input, base).ready, true)
  assert.deepEqual(events, ['prepare', 'stop', 'restart-fixture'])
  assert.equal(await readFile(join(base, 'history-marker'), 'utf8'), 'keep history, settings and account state')
  const after = JSON.parse(await readFile(join(base, 'software/products/installation-receipt.json'), 'utf8'))
  for (const id of Object.keys(before.products)) if (id !== 'runner') assert.equal(after.products[id].payload, before.products[id].payload)
  assert.equal((await productUpdateAction(config, 'status')).updateAvailable, false)
  console.log('Repairing the selected catalog without reverting the independent update.')
  await installProducts(root, config.input, base, { acceptedLicenses, repair: true })
  assert.ok((await commandVersion()).includes(nextManifest.products.runner.version))
  await removePrivateProducts(root, config.input, base)
  assert.equal(await readFile(join(base, 'history-marker'), 'utf8'), 'keep history, settings and account state')
  const report = { schema: 1, kind: 'product-update-engine-qualification', verified: true, target: catalog.target, product: 'runner',
    previousVersion: oldManifest.products.runner.version, version: nextManifest.products.runner.version, release: nextManifest.products.runner.release,
    manifestSha256: hash(candidateBytes), archiveSha256: options['new-sha256'], checks: { signedCheck: true, realEngineUpgrade: true,
      otherProductsUnchanged: true, selectedRepair: true, dataRetained: true, softwareRemoved: true },
    scope: 'Real native products and engine; application lifecycle fixture. No native GUI, HTTP API or real Server restart qualification.' }
  await mkdir(dirname(resolve(options.report)), { recursive: true }); await writeFile(resolve(options.report), JSON.stringify(report, null, 2) + '\n')
  if (process.platform !== 'win32') await rm(temporary, { recursive: true, force: true })
  console.log(JSON.stringify(report))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const names = ['runtime', 'old-artifact', 'new-archive', 'new-sha256', 'work', 'report']
  try { const { values } = parseArgs({ options: Object.fromEntries(names.map(name => [name, { type: 'string' }])) }); await qualifyProductEngine(values) }
  catch (error) { console.error(error.stack); process.exitCode = 1 }
}
