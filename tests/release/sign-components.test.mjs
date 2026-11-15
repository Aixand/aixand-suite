import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { prepareComponentFeed } from '../../scripts/release/sign-components.mjs'
import { prepareRelease } from '../../scripts/prepare-update-release.mjs'
import { createHash } from 'node:crypto'
import { verifyRelease } from '../../scripts/runtime/updates.mjs'
import { canonical, validateComponentFeed } from '../../scripts/runtime/component-updates.mjs'

const python = process.platform === 'win32' ? 'python' : 'python3'

test('Python and JavaScript canonical identities agree for Unicode filenames', () => {
  const value = { files: { '\uffff.txt': { size: 1 }, '😀.txt': { size: 2 }, '漢字.txt': { size: 3 } }, source: { dirty: false } }
  const expected = execFileSync(python, ['-c', 'import json,sys;print(json.dumps(json.loads(sys.argv[1]),sort_keys=True,separators=(",",":"),ensure_ascii=True))', JSON.stringify(value)], { encoding: 'utf8' }).trim()
  assert.equal(canonical(value), expected)
})

test('offline component signing binds verified artifact bytes and cannot overwrite staging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'suite-component-sign-'))
  try {
    const source = join(directory, 'source'), payload = join(directory, 'payload')
    await mkdir(join(source, 'release'), { recursive: true }); await mkdir(join(source, 'apps/web'), { recursive: true }); await mkdir(payload)
    await writeFile(join(source, 'apps/web/package.json'), JSON.stringify({ version: '0.2.1-beta.2' }))
    await writeFile(join(source, 'release/components.json'), JSON.stringify({ schema: 1, suite: { version: '0.1.0-beta' }, components: {
      web: { root: 'apps/web', manifest: 'apps/web/package.json', format: 'node', kind: 'assets', activation: 'runtime', dependencies: [], check: [['true']], build: [['true']] },
    } }))
    await writeFile(join(payload, 'index.html'), '<p>Hello</p>')
    const artifact = join(directory, 'web.tar.gz')
    execFileSync(python, ['-B', '-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from artifacts import package;package(Path(sys.argv[2]),"web",Path(sys.argv[3]),"linux-x86_64-gnu",Path(sys.argv[4]),source={"revision":"a"*40,"dirty":False})', resolve('scripts/release'), source, payload, artifact])
    const pair = generateKeyPairSync('ed25519'), keyFile = join(directory, 'fixture-private.pem')
    await writeFile(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    const descriptor = { origin: 'https://updates.example', role: 'desktop', target: 'linux-x86_64-gnu', sequence: 3, components: [{ id: 'web', file: artifact }] }
    const output = join(directory, 'release')
    const result = await prepareComponentFeed(descriptor, keyFile, output, { python })
    assert.equal(result.publication, 'not-published')
    const envelope = JSON.parse(await readFile(result.candidate, 'utf8'))
    const feed = validateComponentFeed(envelope, { enabled: true, origin: descriptor.origin,
      keys: { [result.keyId]: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() } }, { role: descriptor.role, target: descriptor.target })
    assert.equal(feed.components.web.version, '0.2.1-beta.2')
    assert.equal(feed.sequence, 3)
    const copied = join(output, new URL(feed.components.web.artifact.url).pathname)
    assert.deepEqual(await readFile(copied), await readFile(artifact))
    await assert.rejects(prepareComponentFeed(descriptor, keyFile, output, { python }), /EEXIST/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('native Client feeds bind outbound-only build metadata, platform and package bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'suite-client-sign-'))
  try {
    const pair = generateKeyPairSync('ed25519'), keyFile = join(directory, 'fixture-private.pem')
    const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const keyId = createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
    await writeFile(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    const bytes = Buffer.from('synthetic native Client package'), file = join(directory, 'client.deb')
    const sha = createHash('sha256').update(bytes).digest('hex'); await writeFile(file, bytes)
    const trust = { schema: 1, enabled: true, origin: 'https://updates.example', keys: { [keyId]: pem } }
    const metadata = join(directory, 'client.json')
    const record = { role: 'client', version: '0.3.0-beta.1', releaseSequence: 4, build: 'b'.repeat(64),
      platform: 'linux', architecture: 'x86_64', localRuntime: false, localListeners: false,
      installer_sha256: { 'client.deb': sha }, updateConfig: trust,
      nativeUpdater: { schema: 1, product: 'aixand-client', version: '0.3.0-beta.1', sequence: 4, trust,
        trustSha256: createHash('sha256').update(canonical(trust)).digest('hex') } }
    await writeFile(metadata, JSON.stringify(record))
    const descriptor = { product: 'aixand-client', version: record.version, sequence: record.releaseSequence,
      origin: trust.origin, artifacts: [{ file, metadata, target: 'linux-x86_64-deb', kind: 'deb' }] }
    const output = join(directory, 'output')
    const result = await prepareRelease(descriptor, keyFile, output)
    assert.equal(result.publication, 'not-published')
    const envelope = JSON.parse(await readFile(join(output, 'aixand-client/latest.candidate.json'), 'utf8'))
    const feed = verifyRelease(envelope, trust, { product: 'aixand-client' })
    assert.equal(feed.artifacts['linux-x86_64-deb'].sha256, sha)
    assert.deepEqual(feed.artifacts['linux-x86_64-deb'].products, [])
    await writeFile(metadata, JSON.stringify({ ...record, localRuntime: true }))
    await assert.rejects(prepareRelease(descriptor, keyFile, join(directory, 'wrong-role')), /outbound-only/)
    await writeFile(metadata, JSON.stringify({ ...record, architecture: 'arm64' }))
    await assert.rejects(prepareRelease(descriptor, keyFile, join(directory, 'wrong-target')), /target disagrees/)
    for (const patch of [{ nativeUpdater: undefined }, { nativeUpdater: { ...record.nativeUpdater, sequence: 3 } },
      { nativeUpdater: { ...record.nativeUpdater, trustSha256: '0'.repeat(64) } }]) {
      await writeFile(metadata, JSON.stringify({ ...record, ...patch }))
      await assert.rejects(prepareRelease(descriptor, keyFile, join(directory, 'wrong-native')), /Native Client updater/)
    }
    await writeFile(metadata, JSON.stringify(record)); await writeFile(file, 'changed package')
    await assert.rejects(prepareRelease(descriptor, keyFile, join(directory, 'wrong-bytes')), /package differs/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
