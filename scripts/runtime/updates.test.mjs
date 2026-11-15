import { reserveActivation } from './activation.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyRelease, artifactTarget, checkUpdates, updateSettings, updateStatus, downloadArtifact, downloadUpdate, verifyArtifact, launchUpdate, componentSelectionSnapshot, productSelectionSnapshot } from './updates.mjs'
import { prepareRelease } from '../prepare-update-release.mjs'
import { runUpdate, snapshotDatabases, nsisLaunch, desktopLaunch, sameInstallationPath, runtimeCommandTimeout } from './update-worker.mjs'
import { chmod } from 'node:fs/promises'
import { createServer } from 'node:net'
import { updateBlockers } from './runtime.mjs'
import { initializeSigning } from '../update-signing.mjs'

const pair = generateKeyPairSync('ed25519'), pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const keyId = createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
const trust = { schema: 1, enabled: true, origin: 'https://downloads.example.test', keys: { [keyId]: pem } }
const digest = value => createHash('sha256').update(value).digest('hex')
const packageBytes = Buffer.from('a verified update fixture')
function release(patch = {}) {
  return { schema: 1, apiProtocol: 1, product: 'aixand-server', version: '0.1.0-beta', sequence: 2, pathVersion: '0.1.0-beta.r2', notes: 'A tested update.',
    publishedAt: new Date(Date.now() - 1000).toISOString(), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    artifacts: { [artifactTarget()]: { url: trust.origin + '/aixand-server/0.1.0-beta.r2/setup', size: packageBytes.length,
      sha256: digest(packageBytes), build: digest('new-runtime'), kind: 'server-setup', products: [], licenses: [] } }, ...patch }
}
function envelope(value = release()) {
  const payload = JSON.stringify(value)
  return { schema: 1, keyId, payload, signature: sign(null, Buffer.from(payload), pair.privateKey).toString('base64') }
}
async function fixture(callback, configured = true) {
  const directory = await mkdtemp(join(tmpdir(), 'aixand-updates-'))
  const root = join(directory, 'runtime'), base = join(directory, 'workspace')
  await mkdir(root); await mkdir(base)
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: '0.1.0-beta', releaseSequence: 1, build: digest('old-runtime'), installation: { role: 'server', edition: 'distributed' } }))
  await writeFile(join(root, 'update-config.json'), JSON.stringify({ ...trust, enabled: configured }))
  const config = { root, base }
  try { await callback(config, directory) } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5 }) }
}
const feed = value => new Response(JSON.stringify(value), { headers: { etag: '"fixture-release"' } })

test('release signatures bind content, key, role, revision and protocol', () => {
  const valid = envelope()
  assert.equal(verifyRelease(valid, trust, { product: 'aixand-server' }).sequence, 2)
  assert.throws(() => verifyRelease({ ...valid, payload: valid.payload.replace('A tested', 'An unsafe') }, trust, { product: 'aixand-server' }), /signature/)
  assert.throws(() => verifyRelease({ ...valid, keyId: 'unknown' }, trust, { product: 'aixand-server' }), /unknown key/)
  assert.throws(() => verifyRelease(valid, trust, { product: 'aixand-desktop' }), /identity/)
  assert.throws(() => verifyRelease(valid, trust, { product: 'aixand-server', floor: 3 }), /older release/)
  assert.throws(() => verifyRelease(envelope(release({ apiProtocol: 2 })), trust, { product: 'aixand-server' }), /identity/)
})

test('renewing feed metadata does not offer the same installed package again', async () => {
  await fixture(async config => {
    const renewed = release({ sequence: 20, pathVersion: '0.1.0-beta.r20' })
    Object.assign(renewed.artifacts[artifactTarget()], { releaseSequence: 1, build: digest('old-runtime'),
      url: trust.origin + '/aixand-server/0.1.0-beta.r20/setup' })
    let status = await checkUpdates(config, {}, { fetch: async () => feed(envelope(renewed)) })
    assert.equal(status.updateAvailable, false); assert.equal(status.phase, 'idle')
    renewed.sequence = 21; renewed.pathVersion = '0.1.0-beta.r21'
    Object.assign(renewed.artifacts[artifactTarget()], { releaseSequence: 2, build: digest('new-runtime'), url: trust.origin + '/aixand-server/0.1.0-beta.r21/setup' })
    status = await checkUpdates(config, {}, { fetch: async () => feed(envelope(renewed)) })
    assert.equal(status.updateAvailable, true)
    const invalid = release(); invalid.artifacts[artifactTarget()].releaseSequence = 99
    assert.throws(() => verifyRelease(envelope(invalid), trust, { product: 'aixand-server' }), /package sequence/)
  })
})

test('signing initialization preserves an existing key and exports only public verification settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aixand-signing-'))
  try {
    const first = await initializeSigning(directory, trust.origin), before = await readFile(first.privateKeyFile)
    const second = await initializeSigning(directory, trust.origin)
    assert.equal(first.keyId, second.keyId); assert.deepEqual(await readFile(second.privateKeyFile), before)
    const configuration = JSON.parse(await readFile(second.publicConfiguration, 'utf8'))
    assert.equal(configuration.enabled, true); assert.match(configuration.keys[first.keyId], /^-----BEGIN PUBLIC KEY-----/)
    assert.equal(JSON.stringify(configuration).includes('PRIVATE KEY'), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Windows setup receives a final unquoted NSIS destination, including spaces and Unicode', () => {
  const plan = nsisLaunch('C:\\Users\\Test User\\update.exe', 'C:\\Users\\Test User\\Aixand 世界')
  assert.equal(plan.args.at(-1), '/D=C:\\Users\\Test User\\Aixand 世界')
  assert.equal(plan.options.argv0, '"C:\\Users\\Test User\\update.exe"')
  assert.equal(plan.options.windowsVerbatimArguments, true)
  assert.throws(() => nsisLaunch('setup.exe', 'bad\npath'), /unsupported/)
})

test('Desktop relaunch retains custom workspace, ports, identity and certificate settings on every OS', () => {
  const launch = desktopLaunch({ application: '/Apps/Aixand.app/Contents/MacOS/aixand-desktop', workspace: '/private/workspace', port: 18753, carrierPort: 18765,
    env: { HOME: '/private/user', NODE_EXTRA_CA_CERTS: '/private/company-ca.pem' } })
  assert.equal(launch.program, '/Apps/Aixand.app/Contents/MacOS/aixand-desktop')
  assert.equal(launch.options.env.HOME, '/private/user')
  assert.equal(launch.options.env.AIXAND_LOCAL_HOME, '/private/workspace')
  assert.equal(launch.options.env.AIXAND_LOCAL_PORT, '18753')
  assert.equal(launch.options.env.AIXAND_LOCAL_CARRIER_PORT, '18765')
  assert.equal(launch.options.env.NODE_EXTRA_CA_CERTS, '/private/company-ca.pem')
})

test('Windows installation identity accepts canonical resource paths without conflating sibling installations', () => {
  assert.equal(sameInstallationPath('\\\\?\\C:\\Users\\User\\Aixand\\runtime', 'c:\\users\\user\\aixand\\runtime', 'win32'), true)
  assert.equal(sameInstallationPath('C:\\Users\\User\\Aixand\\runtime', 'C:\\Users\\User\\Other\\runtime', 'win32'), false)
})
test('Windows product-kit repair has time to finish without extending service-control deadlines', () => {
  assert.equal(runtimeCommandTimeout(['setup', 'install'], 'win32'), 60 * 60_000)
  for (const args of [['start'], ['stop'], ['setup', 'products']])
    assert.equal(runtimeCommandTimeout(args, 'win32'), 20 * 60_000)
  for (const platform of ['darwin', 'linux'])
    assert.equal(runtimeCommandTimeout(['setup', 'install'], platform), 20 * 60_000)
})
test('expired, future-dated and mutable-path release metadata is refused', () => {
  for (const patch of [{ expiresAt: '2020-01-01' }, { publishedAt: '2999-01-01' }, { pathVersion: '0.1.0-beta' }])
    assert.throws(() => verifyRelease(envelope(release(patch)), trust, { product: 'aixand-server' }))
})
test('signed artifact metadata still rejects foreign origins, credentials, formats and forged licenses', () => {
  for (const patch of [{ url: 'https://attacker.example/setup' }, { url: trust.origin + '/aixand-server/0.1.0-beta.r2/setup?x=1' },
    { size: -1 }, { licenses: [{ product: 'test', sha256: digest('different'), text: 'actual' }] }, { kind: 'nsis' }]) {
    const value = release(); Object.assign(value.artifacts[artifactTarget()], patch)
    assert.throws(() => verifyRelease(envelope(value), trust, { product: 'aixand-server' }))
  }
})
test('development and unconfigured installs never contact a release service', async () => {
  await fixture(async config => {
    const value = await checkUpdates(config, {}, { fetch() { throw new Error('must not fetch') } })
    assert.equal(value.available, false)
    await rm(join(config.root, 'manifest.json'))
    assert.match((await updateStatus(config)).message, /source development/)
  }, false)
})
test('daily checks persist, support conditional responses, and respect the opt-out', async () => {
  await fixture(async config => {
    let calls = 0
    const fetcher = async () => { calls++; return feed(envelope()) }
    const value = await checkUpdates(config, { due: true }, { fetch: fetcher })
    assert.equal(value.updateAvailable, true); assert.equal(value.installed.version, '0.1.0-beta')
    assert.equal(value.envelope, undefined); assert.equal(value.job, undefined)
    await checkUpdates(config, { due: true }, { fetch: fetcher }); assert.equal(calls, 1)
    await updateSettings(config, { daily: false })
    await checkUpdates(config, { due: true }, { fetch: fetcher, now: () => Date.now() + 2 * 86400_000 }); assert.equal(calls, 1)
    await checkUpdates(config, {}, { fetch: async (_url, options) => {
      assert.equal(options.headers['If-None-Match'], '"fixture-release"'); return new Response(null, { status: 304 })
    } })
    assert.equal((await updateStatus(config)).error, null)
  })
})
test('an unsuccessful check is retried later and never reports success', async () => {
  await fixture(async config => {
    const value = await checkUpdates(config, {}, { fetch: async () => new Response('offline', { status: 503 }) })
    assert.equal(value.checkedAt, null); assert.match(value.error, /503/)
    let called = false
    await checkUpdates(config, { due: true }, { fetch: async () => { called = true; return feed(envelope()) } })
    assert.equal(called, false)
  })
})
test('the highest observed revision cannot roll back or change its content', async () => {
  await fixture(async config => {
    await checkUpdates(config, {}, { fetch: async () => feed(envelope()) })
    const older = release({ sequence: 1, pathVersion: '0.1.0-beta.r1' })
    assert.match((await checkUpdates(config, {}, { fetch: async () => feed(envelope(older)) })).error, /older release/)
    assert.match((await checkUpdates(config, {}, { fetch: async () => feed(envelope(release({ notes: 'mutated' }))) })).error, /revision changed/)
  })
})

test('signed feed freshness can be renewed without reinstalling an unchanged release', async () => {
  await fixture(async config => {
    const original = release()
    await checkUpdates(config, {}, { fetch: async () => feed(envelope(original)) })
    const renewed = { ...original, issuedAt: new Date(Date.now() + 1000).toISOString(), expiresAt: new Date(Date.now() + 2 * 86400_000).toISOString() }
    const result = await checkUpdates(config, {}, { fetch: async () => feed(envelope(renewed)) })
    assert.equal(result.error, null)
    assert.equal(result.release.digest, verifyRelease(envelope(original), trust, { product: 'aixand-server' }).digest)
  })
})
test('interrupted downloads resume with the exact signed range and verify all bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aixand-resume-'))
  try {
    const file = join(directory, 'setup'), artifact = release().artifacts[artifactTarget()]
    await assert.rejects(downloadArtifact(artifact, file, undefined, async () => new Response(packageBytes.subarray(0, 8))), /interrupted/)
    await downloadArtifact(artifact, file, undefined, async (_url, options) => {
      assert.equal(options.headers.Range, 'bytes=8-')
      return new Response(packageBytes.subarray(8), { status: 206, headers: { 'content-range': `bytes 8-${packageBytes.length - 1}/${packageBytes.length}` } })
    })
    assert.deepEqual(await readFile(file), packageBytes)
    await verifyArtifact(file, artifact)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('servers ignoring Range restart the file, and corrupt complete downloads can be retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aixand-download-'))
  try {
    const file = join(directory, 'setup'), artifact = release().artifacts[artifactTarget()]
    await writeFile(file + '.partial', 'partial')
    await downloadArtifact(artifact, file, undefined, async () => new Response(packageBytes))
    assert.deepEqual(await readFile(file), packageBytes)
    await assert.rejects(downloadArtifact(artifact, file, undefined, async () => new Response(Buffer.alloc(packageBytes.length))), /checksum/)
    await downloadArtifact(artifact, file, undefined, async (_url, options) => { assert.equal(options.headers.Range, undefined); return new Response(packageBytes) })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('redirected download files never overwrite user data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aixand-download-path-'))
  try {
    const original = join(directory, 'personal'), file = join(directory, 'setup')
    await writeFile(original, 'keep me'); await symlink(original, file + '.partial')
    await assert.rejects(downloadArtifact(release().artifacts[artifactTarget()], file), /redirected/)
    assert.equal(await readFile(original, 'utf8'), 'keep me')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('downloaded state survives requests and installation cannot bypass confirmation', async () => {
  await fixture(async config => {
    await checkUpdates(config, {}, { fetch: async () => feed(envelope()) })
    const result = await downloadUpdate(config, { fetch: async () => new Response(packageBytes) })
    assert.equal(result.phase, 'downloaded'); assert.equal((await updateStatus(config)).transferred, packageBytes.length)
    await assert.rejects(launchUpdate(config, { confirmed: false }), /confirm/)
    assert.equal((await updateStatus(config)).phase, 'downloaded')
  })
})
test('offline publication emits an immutable signed candidate and refuses untrusted builds', async () => {
  await fixture(async (config, directory) => {
    const value = release(), artifact = value.artifacts[artifactTarget()]
    const manifestFile = join(config.root, 'manifest.json')
    await writeFile(manifestFile, JSON.stringify({ version: value.version, releaseSequence: 2, build: artifact.build, installation: { role: 'server' } }))
    await mkdir(join(config.root, 'products')); await writeFile(join(config.root, 'products/catalog.json'), JSON.stringify({ assemblies: [] }))
    const file = join(directory, 'server-setup'), keyFile = join(directory, 'key.pem'), output = join(directory, 'releases')
    await writeFile(file, packageBytes)
    await writeFile(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    const descriptor = { product: value.product, version: value.version, sequence: 2, origin: trust.origin, artifacts: [{ target: artifactTarget(), kind: 'server-setup', runtime: config.root, file }] }
    await prepareRelease(descriptor, keyFile, output)
    const candidate = JSON.parse(await readFile(join(output, 'aixand-server/latest.candidate.json'), 'utf8'))
    assert.equal(verifyRelease(candidate, trust, { product: value.product }).sequence, 2)
    await assert.rejects(prepareRelease(descriptor, keyFile, output), /EEXIST/)
  })
})

test('database snapshots keep owned SQLite files and WALs without copying provider accounts or following links', async () => {
  await fixture(async (config, directory) => {
    await mkdir(join(config.base, 'auth')); await mkdir(join(config.base, 'agents'))
    const bytes = Buffer.from('SQLite format 3\0fixture contents')
    await writeFile(join(config.base, 'auth/auth.db'), bytes); await writeFile(join(config.base, 'auth/auth.db-wal'), 'wal bytes')
    await writeFile(join(config.base, 'agents/provider.db'), bytes)
    await symlink(join(config.base, 'agents'), join(config.base, 'redirected'), process.platform === 'win32' ? 'junction' : 'dir')
    const backup = join(directory, 'snapshot'), records = await snapshotDatabases(config.base, backup)
    assert.deepEqual(records.map(row => row.file), ['auth/auth.db', 'auth/auth.db-wal'])
    assert.deepEqual(await readFile(join(backup, 'auth/auth.db')), bytes)
    assert.equal(await readFile(join(config.base, 'agents/provider.db'), 'utf8'), bytes.toString())
  })
})

test('update review includes queued and running workflows even when the UC daemon is offline', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aixand-update-work-'))
  const socket = createServer(connection => { connection.on('data', () => connection.end(JSON.stringify({ ok: true, data: { service: 'runner' } }) + '\n')) })
  try {
    await new Promise((ready, fail) => { socket.once('error', fail); socket.listen(join(directory, 'runner.sock'), ready) })
    const uc = join(directory, 'uc'), runner = join(directory, 'runner')
    await writeFile(uc, `#!${process.execPath}\nconsole.log(JSON.stringify({accepting_connections:false}))`); await chmod(uc, 0o700)
    await writeFile(runner, `#!${process.execPath}\nconst after=Number(process.argv[process.argv.indexOf('--after')+1]);console.log(JSON.stringify({jobs:after?[]:Array.from({length:100},(_,i)=>({sequence:i+1,id:'job-'+i,state:i===0?'running':i===1?'queued':'completed'}))}));`); await chmod(runner, 0o700)
    const blockers = await updateBlockers({ server: directory, env: { PATH: process.env.PATH, RUNNER_HOME: directory }, tools: { uc, runner } })
    assert.deepEqual(blockers.map(row => row.id), ['job-0', 'job-1'])
  } finally { await new Promise(ready => socket.close(ready)); await rm(directory, { recursive: true, force: true }) }
})

for (const failHealth of [false, true, 'new-work']) test(`the external Server worker ${failHealth === 'new-work' ? 'refuses late workspace work' : failHealth ? 'retains recovery files after a health failure' : 'finishes replacement and restart'} without changing workspace data`, { skip: process.platform === 'win32' }, async () => {
  await fixture(async (config, directory) => {
    const jobs = join(config.base, 'updates/server'), jobDirectory = join(jobs, 'jobs/fixture')
    await mkdir(jobDirectory, { recursive: true }); await mkdir(join(config.root, 'node/bin'), { recursive: true })
    await symlink(process.execPath, join(config.root, 'node/bin/node'))
    await writeFile(join(config.base, 'history'), 'keep history and logins')
    await mkdir(join(config.base, 'config'))
    const previousSelection = { schema: 1, components: { web: { path: 'fixture', manifest: { inputs: { runtime: digest('old-runtime') } } } } }
    const selectionFile = join(config.base, 'config/component-selection.json')
    await writeFile(selectionFile, JSON.stringify(previousSelection))
    const selection = await componentSelectionSnapshot(config.base)
    const calls = join(directory, 'calls.jsonl')
    const previousProducts = { schema: 1, assemblies: { 'agent-manager': { manifestSha256: digest('independent manager'), compatibleBuilds: [digest('old-runtime'), digest('new-runtime')] } } }
    const productSelectionFile = join(config.base, 'config/product-selection.json')
    await writeFile(productSelectionFile, JSON.stringify(previousProducts))
    const selectedProducts = await productSelectionSnapshot(config.base)
    await writeFile(join(config.root, 'runtime.mjs'), `import{appendFileSync}from'node:fs'; const args=process.argv.slice(2); appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n'); if(args[0]==='updates')console.log(JSON.stringify({sessions:[]})); else if(args[0]==='start'&&${failHealth === true}||args[0]==='prepare-update'&&${failHealth === 'new-work'}){console.error('fixture health or work check failed');process.exitCode=1}else console.log('{}');`)
    const installer = join(directory, 'installer.mjs'), packageFile = join(directory, 'setup')
    await writeFile(installer, `import{readFile,writeFile,mkdir,cp}from'node:fs/promises';import{join}from'node:path';const root=${JSON.stringify(config.root)};const backup=join(root,'../.previous-fixture');await cp(root,backup,{recursive:true});await writeFile(join(root,'manifest.json'),JSON.stringify({build:${JSON.stringify(digest('new-runtime'))},releaseSequence:2}));await writeFile(join(root,'../server-installation.json'),JSON.stringify({updateBackup:'.previous-fixture'}));`)
    await writeFile(packageFile, `#!/bin/sh\nexec '${process.execPath}' '${installer}' "$@"\n`); await chmod(packageFile, 0o700)
    const bytes = await readFile(packageFile), value = release()
    Object.assign(value.artifacts[artifactTarget()], { size: bytes.length, sha256: digest(bytes) })
    const signed = envelope(value)
    await writeFile(join(config.root, '../server-installation.json'), '{}')
    const operation = 'fixture-native-operation', jobFile = join(jobDirectory, 'job.json')
    await reserveActivation(config.base, operation, 'native')
    await writeFile(join(jobs, 'state.json'), JSON.stringify({ operation, job: jobFile, phase: 'preparing', operationPid: null, daily: true }))
    const job = { operation, config: { ...config, updateDirectory: jobs }, root: config.root, workspace: config.base, port: 18753, carrierPort: 18765,
      product: value.product, installedBuild: digest('old-runtime'), envelope: signed, trust, sequence: 2,
      componentSelectionDigest: selection.digest,
      productSelectionDigest: selectedProducts.digest,
      artifact: value.artifacts[artifactTarget()], packageFile, wasRunning: true, env: { HOME: directory, PATH: process.env.PATH }, acceptedLicenses: [] }
    await writeFile(jobFile, JSON.stringify(job))
    await runUpdate(jobFile)
    const state = JSON.parse(await readFile(join(jobs, 'state.json'), 'utf8'))
    assert.equal(state.phase, failHealth ? 'failed' : 'complete')
    const retained = JSON.parse(await readFile(state.componentSelectionBackup, 'utf8'))
    assert.deepEqual(retained.selection, previousSelection)
    assert.deepEqual(JSON.parse(await readFile(productSelectionFile, 'utf8')), previousProducts)
    assert.equal(retained.digest, selection.digest)
    assert.deepEqual(JSON.parse(await readFile(selectionFile, 'utf8')), failHealth === 'new-work' ? previousSelection : { schema: 1, components: {} })

    assert.equal(await readFile(join(config.base, 'history'), 'utf8'), 'keep history and logins')
    if (failHealth !== 'new-work') assert.equal(JSON.parse(await readFile(join(state.backup, 'manifest.json'), 'utf8')).build, digest('old-runtime'))
    else assert.equal(JSON.parse(await readFile(join(config.root, 'manifest.json'), 'utf8')).build, digest('old-runtime'))
    const recorded = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    if (failHealth !== 'new-work') assert.equal(JSON.parse(recorded.find(args => args[0] === 'setup')[2]).connectionVerification, 'configuration')
    const operations = recorded.map(args => args[0])
    assert.deepEqual(operations, failHealth === 'new-work' ? ['updates', 'prepare-update', 'start'] : ['updates', 'prepare-update', 'stop', 'setup', 'start'])
  })
})

test('application update review fingerprints component selections and rejects redirection', async () => {
  await fixture(async (config, directory) => {
    assert.equal((await componentSelectionSnapshot(config.base)).digest, null)
    await mkdir(join(config.base, 'config'))
    const file = join(config.base, 'config/component-selection.json')
    await writeFile(file, JSON.stringify({ schema: 1, components: { web: {} } }))
    const first = await componentSelectionSnapshot(config.base)
    assert.deepEqual(first.components, ['web'])
    await writeFile(file, JSON.stringify({ schema: 1, components: { connect: {} } }))
    assert.notEqual((await componentSelectionSnapshot(config.base)).digest, first.digest)
    await rm(file)
    const foreign = join(directory, 'foreign-selection.json')
    await writeFile(foreign, '{}'); await symlink(foreign, file)
    await assert.rejects(componentSelectionSnapshot(config.base), /redirected/)
  })
})
