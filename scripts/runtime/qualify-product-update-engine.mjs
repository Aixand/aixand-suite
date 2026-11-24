// Exercise the packaged HTTP API and external worker with --native-feed
// (embedded trust), --hosted-feed (real downloads), or --local-native (ephemeral trust).
// GUI and native installer verification are separate.
import assert from 'node:assert/strict'
import { constants, createReadStream, existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile, mkdtemp, rm, stat, realpath } from 'node:fs/promises'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { parseArgs, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { installProducts, installedProductTools, productStatus, productLocation, removePrivateProducts, removeSharedProducts } from './products.mjs'
import { saveInstallationPlan } from './installation-plan.mjs'
import { productObjectPath, productSelectionPath } from './product-selection.mjs'
import { productDefinitions } from './product-feed.mjs'
import { runProductUpdateWorker } from './product-update-worker.mjs'

const execute = promisify(execFile), own = dirname(fileURLToPath(import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fileHash(file) {
  const digest = createHash('sha256'); for await (const block of createReadStream(file)) digest.update(block); return digest.digest('hex')
}
const carrierProbe = String.raw`
import asyncio
from pathlib import Path
import sys
import carrier

phase, url, database, workspace = sys.argv[1:]
state = Path(workspace) / "carrier-qualification"
state.mkdir(exist_ok=True)
sender_path, receiver_path = (state / name for name in ("sender.json", "receiver.json"))
sender_address, receiver_address = "qualification/sender", "qualification/receiver"
if phase == "before":
    carrier.ensure_session(database=database, credentials=sender_path, address=sender_address)
    carrier.ensure_session(database=database, credentials=receiver_path, address=receiver_address)

async def exchange():
    async with (
        carrier.Client(url=url, credentials=sender_path) as sender,
        carrier.Client(url=url, credentials=receiver_path) as receiver,
    ):
        if phase == "before":
            message = await sender.send("queued before update", to=receiver_address, idempotency_key="pre-update")
            (state / "pending-id").write_text(str(message.id))
            return
        pending = (state / "pending-id").read_text()
        messages = (await receiver.receive_pending()).messages
        assert any(str(m.id) == pending and m.content == "queued before update" for m in messages)
        sent = await sender.send("sent after update", to=receiver_address, idempotency_key="post-update")
        message = next(m for m in (await receiver.receive_pending()).messages if m.id == sent.id)
        assert message.content == "sent after update"
        await message.reply("received after update")
        await message.ack()
        reply = await sender.wait_for_reply(sent, timeout=5)
        assert reply.content == "received after update"

asyncio.run(exchange())
`

const conversationProbe = String.raw`
import asyncio
import json
from pathlib import Path
import sys
from conversation_manager import Client
from conversation_manager.demo import demo

phase, workspace = sys.argv[1:]
state = Path(workspace) / "conversation-qualification"
state.mkdir(exist_ok=True)
home = state / "store"
home.mkdir(exist_ok=True)
evidence = state / "retained.json"

async def exercise():
    if phase == "before":
        result = await demo(home=str(home))
        assert result["status"] == "completed", result
        evidence.write_text(json.dumps({
            "conversation": result["conversation_ref"],
            "turn": result["send_receipt"]["result"]["turn_id"],
        }))
    saved = json.loads(evidence.read_text())
    client = Client(str(home))
    history = await client.history(saved["conversation"])
    assert history["entries"]
    assert (await client.turn_result(saved["conversation"], saved["turn"]))["status"] == "completed"
    if phase == "after":
        fresh = state / "new-store"
        fresh.mkdir()
        assert (await demo(home=str(fresh)))["status"] == "completed"

asyncio.run(asyncio.wait_for(exercise(), timeout=45))
`

export async function qualifyProductEngine(options) {
  const id = options.product ?? 'runner'
  assert.ok(['runner', 'carrier', 'agent-manager', 'conversation-manager'].includes(id),
    'No integrated qualification probe is defined for this product')
  const selection = productDefinitions[id].product
  const nativeModes = ['native-feed', 'hosted-feed', 'local-native'].filter(mode => options[mode])
  const native = nativeModes.length > 0
  const diagnostic = !options['native-feed'] && !options['hosted-feed']
  assert.ok(nativeModes.length <= 1, 'Choose one native feed source')
  assert.ok(!options['local-catalog'] || diagnostic, 'The qualification feed defines its own schema')
  assert.ok(id === 'runner' || native, 'This product qualification requires a running Suite lifecycle')
  for (const name of ['runtime', 'old-artifact', 'new-archive', 'new-sha256', 'work', 'report']) assert.ok(options[name], 'Required: --' + name)
  assert.ok(!options.scope || ['private', 'shared'].includes(options.scope), 'Choose private or shared scope')
  const shared = options.scope === 'shared'
  const source = await realpath(resolve(options.runtime))
  let work = resolve(options.work)
  assert.ok(!existsSync(work), 'Choose a fresh disposable qualification directory')
  await mkdir(work, { recursive: true, mode: 0o700 }); work = await realpath(work)
  await writeFile(join(work, 'OWNED_BY_PRODUCT_UPDATE_QUALIFICATION'), 'disposable qualification\n')
  const root = join(work, 'application'), base = join(work, 'workspace')
  const home = join(work, 'home'), temporary = process.platform === 'win32' ? join(work, 'tmp') : await realpath(await mkdtemp('/tmp/a3p-'))
  for (const path of [home, temporary, base]) await mkdir(path, { recursive: true })
  for (const name of Object.keys(process.env)) if (/^(AGENT_MANAGER_|CONVERSATION_MANAGER_|MCP_MANAGER_|PROMPT_MANAGER_|SKILL_MANAGER_|AIXAND_MANAGER_|CARRIER_|UNDERCURRENT_|RUNNER_|ORCHESTRATION_)/.test(name)
    || ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'GH_TOKEN', 'GITHUB_TOKEN', 'CLOUDFLARE_API_TOKEN', 'UPDATE_SIGNING_KEY'].includes(name)) delete process.env[name]
  Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming'),
    PATH: process.platform === 'win32' ? join(process.env.SystemRoot || 'C:/Windows', 'System32') : '/usr/bin:/bin',
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'),
    AIXAND_LOCAL_HOME: base, AIXAND_SHARED_PRODUCT_PREFIX: join(work, 'unused-shared-store'), AIXAND_SKIP_PATH_REGISTRATION: '1', TMPDIR: temporary, TMP: temporary, TEMP: temporary })
  if (shared) {
    process.env.UNDERCURRENT_HOME = join(work, 'shared-uc')
    for (const name of ['AGENT', 'CONVERSATION', 'MCP', 'PROMPT', 'SKILL']) process.env[name + '_MANAGER_HOME'] = join(work, 'shared-settings', name.toLowerCase())
  }
  await mkdir(root)
  if (native) await cp(source, root, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  else for (const name of ['manifest.json', 'python', 'products']) await cp(join(source, name), join(root, name), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  if (!native) await cp(join(own, 'product-update-artifact.py'), join(root, 'product-update-artifact.py'))
  const coordinator = await import(pathToFileURL(join(native ? root : own, 'product-updates.mjs')).href)
  const { productUpdateAction, productUpdateState, currentProductUpdatePlan } = coordinator
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  assert.match(manifest.build, /^[a-f0-9]{64}$/)
  const pair = generateKeyPairSync('ed25519'), trust = { schema: 1, enabled: true, origin: 'https://downloads.aixand.org',
    keys: { qualification: pair.publicKey.export({ type: 'spki', format: 'pem' }) } }
  if (diagnostic) await writeFile(join(root, 'update-config.json'), JSON.stringify(trust))
  let config = { root, base, input: { ...process.env }, env: { ...process.env } }
  const oldArtifact = resolve(options['old-artifact']), oldBytes = await readFile(join(oldArtifact, 'release-manifest.json'))
  const oldManifest = JSON.parse(oldBytes), oldDigest = hash(oldBytes)
  const catalog = JSON.parse(await readFile(join(root, 'products/catalog.json'), 'utf8'))
  assert.equal(oldManifest.selection, selection)
  assert.equal(oldManifest.target, catalog.target)
  const selected = productObjectPath(base, id, oldDigest)
  await mkdir(dirname(selected), { recursive: true }); await cp(oldArtifact, selected, { recursive: true })
  await mkdir(join(base, 'config'))
  await writeFile(productSelectionPath(base), JSON.stringify({ schema: 1, assemblies: { [id]: { manifestSha256: oldDigest, compatibleBuilds: [manifest.build] } } }))
  await saveInstallationPlan(root, config.input, base, shared ? 'shared' : 'isolated')
  const prefix = productLocation(root, config.input, base).prefix
  const { productCatalog } = await import('./products.mjs')
  const acceptedLicenses = productCatalog(root).assemblies.flatMap(row => row.licenses).map(row => row.sha256)
  console.log('Installing packaged products in a disposable workspace.')
  await installProducts(root, config.input, base, { acceptedLicenses })
  const receipt = () => readFile(join(prefix, 'installation-receipt.json'), 'utf8').then(JSON.parse)
  assert.equal((await receipt()).products[selection].product.release, oldManifest.products[selection].release)
  const before = await receipt()
  await writeFile(join(base, 'history-marker'), 'keep history, settings and account state')
  const archive = resolve(options['new-archive']); assert.equal(await fileHash(archive), options['new-sha256'])
  const candidateBytes = await readFile(options['new-manifest'] ?? join(root, 'products/artifacts', id, 'release-manifest.json'))
  const nextManifest = JSON.parse(candidateBytes)
  assert.equal(nextManifest.target, catalog.target)
  assert.equal(nextManifest.selection, selection)
  const next = nextManifest.products[selection]
  assert.notEqual(oldManifest.products[selection].version, next.version)
  const row = catalog.assemblies.find(row => row.id === id)
  const envelope = options['native-feed'] ? JSON.parse(await readFile(resolve(options['native-feed']), 'utf8')) : null
  const schema = envelope ? JSON.parse(envelope.payload).schema : options['local-catalog'] ? 2 : 1
  const artifactUrl = `${trust.origin}/aixand-suite-products/${catalog.target}/${id}/candidate.archive`
  const archiveSize = (await stat(archive)).size
  const unsignedFeed = build => {
    const candidate = {
      selection, version: next.version, release: next.release, compatibleBuilds: [build], requires: {},
      licenses: row.licenses, artifact: { url: artifactUrl,
        sha256: options['new-sha256'], size: archiveSize, manifestSha256: hash(candidateBytes) },
    }
    return JSON.stringify({ schema, product: 'aixand-suite-products', target: catalog.target,
      sequence: build === manifest.build ? 2 : 1, issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(), products: { [id]: schema === 2 ? [candidate] : candidate } })
  }
  let compatible = true
  const feedEnvelope = () => {
    if (envelope) return envelope
    const payload = unsignedFeed(compatible ? manifest.build : '0'.repeat(64))
    return { schema: 1, keyId: 'qualification', payload, signature: sign(null, Buffer.from(payload), pair.privateKey).toString('base64') }
  }
  const assertInstalled = async () => assert.equal((await receipt()).products[selection].product.release, next.release)
  const events = []; let running = true, jobFile
  const dependencies = { fetch: async url => {
    if (url.endsWith('/latest.json') || url.endsWith('/catalog.json')) {
      const expected = schema === 2 ? '/catalog.json' : '/latest.json'
      return url.endsWith(expected) ? new Response(JSON.stringify(feedEnvelope())) : new Response(null, { status: 404 })
    }
    return new Response(Readable.toWeb(createReadStream(archive)))
  },
    lifecycle: { status: async () => ({ services: [{ state: running ? 'running' : 'stopped' }] }), updateBlockers: async () => [],
      prepareUpdate: async () => { events.push('prepare') }, stop: async () => { running = false; events.push('stop') },
      start: async () => { await assertInstalled(); running = true; events.push('restart-fixture') } },
    launchWorker: async ({ job }) => { jobFile = job; return { outsideLifecycle: true, pid: process.pid } } }
  let nativeLifecycle, nativeRunning = false, cookie, csrf
  const password = 'Disposable native updater qualification 9274!'
  const request = async (path, body) => {
    const origin = new URL(config.address).origin
    const response = await fetch(new URL(path, origin), { method: body ? 'POST' : 'GET',
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(csrf && body ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) })
    assert.ok([200, 201].includes(response.status), `${path}: ${response.status} ${await response.clone().text()}`)
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]
    return response.json()
  }
  const carrierData = async phase => {
    if (id !== 'carrier') return
    const { carrierPython } = installedProductTools(root, config.input, base)
    await execute(carrierPython, ['-B', '-c', carrierProbe, phase, config.env.CARRIER_URL, config.env.CARRIER_DATABASE, base],
      { env: config.input, timeout: 30000, windowsHide: true })
  }
  const agentManagerData = async phase => {
    if (id !== 'agent-manager') return
    const { commands } = installedProductTools(root, config.input, base)
    const agent = async (...args) => JSON.parse((await execute(commands.agent, ['codex', 'profile', ...args, '--json'],
      { env: config.env, timeout: 30000, windowsHide: true })).stdout)
    if (phase === 'before') await agent('new', 'updater-qualification')
    await agent('show', 'updater-qualification')
    if (phase === 'after') await agent('new', 'created-after-update')
  }
  const conversationManagerData = async phase => {
    if (id !== 'conversation-manager') return
    const python = (await receipt()).products[selection].python
    await execute(python, ['-B', '-c', conversationProbe, phase, base],
      { env: config.env, timeout: 60000, windowsHide: true })
  }
  try {
    if (native) {
      nativeLifecycle = await import(pathToFileURL(join(root, 'runtime.mjs')).href)
      const freePort = async () => {
        const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        const port = server.address().port; await new Promise(resolve => server.close(resolve)); return String(port)
      }
      process.env.AIXAND_LOCAL_PORT = await freePort(); process.env.AIXAND_LOCAL_CARRIER_PORT = await freePort()
      config = nativeLifecycle.configuration(root, { ...process.env })
      const components = await import(pathToFileURL(join(root, 'component-updates.mjs')).href)
      await components.saveComponentState(config, { ...components.componentState(config), daily: false })
      await coordinator.saveProductUpdateState(config, { ...productUpdateState(config), daily: false })
      if (manifest.releaseSequence > 0) {
        await (await import(pathToFileURL(join(root, 'updates.mjs')).href)).updateSettings(config, { daily: false })
      } else {
        assert.ok(diagnostic, 'Native release qualification requires a positive application release sequence')
      }
      delete dependencies.lifecycle
      dependencies.launchWorker = (await import(pathToFileURL(join(root, 'component-launcher.mjs')).href)).launchComponentWorker
      dependencies.lifecycle = nativeLifecycle
      if (options['hosted-feed']) delete dependencies.fetch
      nativeRunning = true
      await nativeLifecycle.start(config)
      await request('/api/auth/setup', { password, confirmation: password })
      csrf = (await request('/api/auth/session')).csrfToken
      assert.equal(typeof csrf, 'string')
      const inventory = await request('/api/updates/products')
      assert.ok(inventory.available, 'Packaged authenticated product update API must be enabled')
      await carrierData('before')
      await agentManagerData('before')
      await conversationManagerData('before')
    }
    if (diagnostic) {
      compatible = false
      await productUpdateAction(config, 'check', {}, dependencies)
      assert.equal(Object.hasOwn((await productUpdateAction(config, 'status')).candidates, id), false)
      compatible = true
    }
    await productUpdateAction(config, 'check', {}, dependencies)
    const state = productUpdateState(config)
    const status = await productUpdateAction(config, 'status')
    const useCatalog = (state.feedSchema ?? schema) === 2
    const candidates = useCatalog ? (status.versions[id] ?? []).filter(item => item.selectable)
      : [status.candidates[id]].filter(Boolean)
    assert.ok(candidates.some(item => item.release === next.release), 'The qualified product must be offered to this runtime')
    const choice = useCatalog ? { releases: { [id]: next.release } } : { products: [id] }
    await productUpdateAction(config, 'download', choice, dependencies)
    const plan = await currentProductUpdatePlan(config, productUpdateState(config), dependencies)
    assert.equal(plan.ready, true); assert.deepEqual(plan.blockers, [])
    assert.equal(plan.candidates[id].artifact.sha256, options['new-sha256'])
    assert.equal(plan.candidates[id].artifact.manifestSha256, hash(candidateBytes))
    if (nativeLifecycle) { assert.equal(plan.running, true); assert.equal(plan.restartRequired, true) }
    console.log('Applying the signed product update through the real native installation engine.')
    const consent = { confirmed: true, revision: plan.revision, acceptedLicenses, restartConsent: true }
    if (nativeLifecycle) {
      const reviewed = await request('/api/updates/products', { action: 'plan', ...choice })
      assert.equal(reviewed.revision, plan.revision)
      assert.equal((await request('/api/updates/products', { action: 'install', ...consent })).started, true)
    } else await productUpdateAction(config, 'install', consent, dependencies)
    if (nativeLifecycle) {
      const deadline = Date.now() + 20 * 60_000
      while (Date.now() < deadline) {
        const state = productUpdateState(config)
        if (state.phase === 'completed') break
        assert.notEqual(state.phase, 'failed', state.error || state.message)
        await delay(1000)
      }
      assert.equal(productUpdateState(config).phase, 'completed', 'External worker must finish the real restart')
      assert.equal(productUpdateState(config).recovery.stopAttempted, true, 'Worker must stop the original service lifecycle')
      config = nativeLifecycle.configuration(root, { ...process.env })
      await request('/api/auth/login', { password })
      assert.ok((await request('/api/updates/products')).inventory)
      await carrierData('after')
      await agentManagerData('after')
      await conversationManagerData('after')
    } else {
      const job = JSON.parse(await readFile(jobFile, 'utf8'))
      await runProductUpdateWorker(config, { ...job, path: jobFile }, { ...dependencies, outsideLifecycle: true })
    }
    assert.equal(productStatus(root, config.input, base).ready, true)
    if (!nativeLifecycle) assert.deepEqual(events, ['prepare', 'stop', 'restart-fixture'])
    assert.equal(await readFile(join(base, 'history-marker'), 'utf8'), 'keep history, settings and account state')
    const after = await receipt()
    await assertInstalled()
    for (const product of Object.keys(before.products)) {
      if (product !== selection) assert.equal(after.products[product].payload, before.products[product].payload)
    }
    const updated = (await productUpdateAction(config, 'status')).candidates[id]
    assert.ok(updated?.release !== next.release, 'The installed product must no longer be offered for upgrade')
    console.log('Repairing the selected catalog without reverting the independent update.')
    await installProducts(root, config.input, base, { acceptedLicenses, repair: true })
    await assertInstalled()
    if (nativeLifecycle) {
      await nativeLifecycle.stop(config)
      nativeRunning = false
    }
    if (shared) {
      if (nativeLifecycle) await execute(config.tools.uc, ['daemon', 'stop'], { env: config.env, windowsHide: true, timeout: 60000 })
      await removeSharedProducts(root, config.input, base, Object.keys(after.products))
    } else await removePrivateProducts(root, config.input, base)
    assert.equal(await readFile(join(base, 'history-marker'), 'utf8'), 'keep history, settings and account state')
    const report = { schema: 1, kind: diagnostic ? 'product-update-engine-qualification' : 'product-update-qualification',
      verified: true, target: catalog.target, product: id, installationScope: shared ? 'shared' : 'private', runtimeRole: manifest.installation?.role,
      runtimeVersion: manifest.version, previousVersion: oldManifest.products[selection].version, version: next.version, release: next.release,
      compatibleBuilds: [manifest.build], manifestSha256: hash(candidateBytes), archiveSha256: options['new-sha256'], checks: { httpPlanAndInstall: Boolean(nativeLifecycle), upgrade: true, restart: Boolean(nativeLifecycle), signedCheck: true, realEngineUpgrade: true,
        otherProductsUnchanged: true,
        ...(id === 'carrier' ? { carrierMessagesRetained: true, carrierDelivery: true } : {}),
        ...(id === 'agent-manager' ? { agentProfilesRetained: true, agentProfileCreation: true } : {}),
        ...(id === 'conversation-manager' ? { conversationHistoryRetained: true, offlineConversation: true } : {}),
        selectedRepair: true, dataRetained: true, softwareRemoved: true },
      scope: nativeLifecycle ? 'Packaged native runtime, authenticated HTTP API, external worker and actual Server restart. '
        + (options['hosted-feed'] ? 'Hosted signed feed and archive.' : 'Local feed and archive transport.')
        : 'Real native products and engine; application lifecycle fixture. No native GUI, HTTP API or real Server restart qualification.' }
    await mkdir(dirname(resolve(options.report)), { recursive: true }); await writeFile(resolve(options.report), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
  } finally {
    if (nativeRunning) await nativeLifecycle.stop(config)
    if (process.platform !== 'win32') await rm(temporary, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const names = ['runtime', 'old-artifact', 'new-archive', 'new-sha256', 'work', 'report', 'native-feed', 'scope', 'product', 'new-manifest']
  const flags = ['local-native', 'local-catalog', 'hosted-feed']
  try {
    const { values } = parseArgs({ options: {
      ...Object.fromEntries(names.map(name => [name, { type: 'string' }])),
      ...Object.fromEntries(flags.map(name => [name, { type: 'boolean' }])),
    } })
    await qualifyProductEngine(values)
  }
  catch (error) { console.error(error.stack); process.exitCode = 1 }
}
