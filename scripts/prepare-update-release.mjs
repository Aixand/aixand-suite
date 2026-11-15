// Offline preparation only: no credentials, uploads, or deployment operations.
import { createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto'
import { readFile, mkdir, cp, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { verifyRelease } from './runtime/updates.mjs'

const need = (value, message) => { if (!value) throw new Error(message) }
export async function prepareRelease(descriptor, keyFile, output) {
  need(['aixand-desktop', 'aixand-server', 'aixand-client'].includes(descriptor.product) && Array.isArray(descriptor.artifacts), 'Choose Desktop, Server or Client artifacts.')
  const key = createPrivateKey(await readFile(keyFile)), publicKey = createPublicKey(key)
  need(key.asymmetricKeyType === 'ed25519', 'Use an Ed25519 update signing key.')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
  const now = Date.now(), version = descriptor.version, sequence = descriptor.sequence
  const pathVersion = version + (version.includes('-') ? '.' : '-') + 'r' + sequence
  const release = { schema: 1, apiProtocol: 1, product: descriptor.product, version, sequence, pathVersion, notes: descriptor.notes || '',
    publishedAt: descriptor.publishedAt || new Date(now).toISOString(), issuedAt: new Date(now).toISOString(), expiresAt: descriptor.expiresAt || new Date(now + 30 * 86400_000).toISOString(), artifacts: {} }
  const files = []
  for (const item of descriptor.artifacts) {
    need(!release.artifacts[item.target], 'Duplicate release target.')
    const client = descriptor.product === 'aixand-client'
    const runtime = item.runtime ? resolve(item.runtime) : null, file = resolve(item.file)
    need(client ? item.metadata : runtime, 'Supply the exact native Client metadata or packaged runtime.')
    const manifest = JSON.parse(await readFile(client ? resolve(item.metadata) : join(runtime, 'manifest.json'), 'utf8'))
    if (client) {
      need(manifest.role === 'client' && manifest.localRuntime === false && manifest.localListeners === false, 'Client metadata must describe an outbound-only native package.')
      const architecture = { x64: 'x86_64', amd64: 'x86_64', aarch64: 'arm64' }[manifest.architecture] || manifest.architecture
      need(item.target === `${manifest.platform}-${architecture}` || item.target === `${manifest.platform}-${architecture}-${item.kind}`, 'Client target disagrees with its build metadata.')
      const native = manifest.nativeUpdater
      need(native?.schema === 1 && native.product === 'aixand-client' && native.version === manifest.version && native.sequence === manifest.releaseSequence,
        'Native Client updater identity disagrees with its build metadata.')
      const sorted = value => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => [key, sorted(value[key])])) : value
      const baked = JSON.stringify(sorted(native.trust))
      need(baked === JSON.stringify(sorted(manifest.updateConfig)) && native.trustSha256 === createHash('sha256').update(baked).digest('hex'),
        'Native Client updater trust disagrees with its build metadata.')
      manifest.installation = { role: 'client' }
    }
    need(manifest.version === version && manifest.releaseSequence === sequence && manifest.installation?.role === descriptor.product.slice(7), 'Build and release identities disagree.')
    const trust = client ? manifest.updateConfig : JSON.parse(await readFile(join(runtime, 'update-config.json'), 'utf8'))
    need(trust.enabled && trust.keys[keyId] === pem && trust.origin === descriptor.origin, 'The built application does not trust this release signing key and origin.')
    const catalog = client ? { assemblies: [] } : JSON.parse(await readFile(join(runtime, 'products/catalog.json'), 'utf8'))
    const digest = createHash('sha256'); let size = 0
    for await (const block of createReadStream(file)) { digest.update(block); size += block.length }
    const sha256 = digest.digest('hex'), name = sha256.slice(0, 16) + '-' + basename(file).replace(/[^A-Za-z0-9._+-]/g, '-')
    if (client) need(manifest.installer_sha256?.[basename(file)] === sha256, 'Client package differs from its build metadata.')
    const artifact = { url: descriptor.origin + '/' + descriptor.product + '/' + pathVersion + '/' + name, kind: item.kind, sha256, size,
      build: manifest.build, products: catalog.assemblies.flatMap(row => Object.entries(row.products).map(([id, value]) => ({ id, version: value.version, release: value.release }))),
      licenses: catalog.assemblies.flatMap(row => row.licenses) }
    release.artifacts[item.target] = artifact
    files.push({ name, file, target: item.target, sha256 })
  }
  const payload = JSON.stringify(release)
  const envelope = { schema: 1, keyId, payload, signature: sign(null, Buffer.from(payload), key).toString('base64') }
  verifyRelease(envelope, { origin: descriptor.origin, keys: { [keyId]: pem } }, { product: descriptor.product })
  // Refuse to overwrite an existing immutable release directory.
  const destination = join(resolve(output), descriptor.product, pathVersion)
  await mkdir(join(resolve(output), descriptor.product), { recursive: true })
  await mkdir(destination)
  for (const item of files) await cp(item.file, join(destination, item.name), { errorOnExist: true, force: false })
  const downloadManifest = { schema: 1, product: descriptor.product, version: pathVersion,
    artifacts: Object.fromEntries(files.map(item => [item.target, { kind: 'suite-package', file: item.name, sha256: item.sha256 }])) }
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(downloadManifest, null, 2) + '\n')
  await writeFile(join(destination, 'SHA256SUMS'), files.map(item => item.sha256 + '  ' + item.name + '\n').join(''))
  await writeFile(join(destination, 'release.json'), JSON.stringify(envelope) + '\n')
  // Candidate feed is separate: upload immutable files, verify them, then promote.
  await writeFile(join(resolve(output), descriptor.product, 'latest.candidate.json'), JSON.stringify(envelope) + '\n')
  return { product: descriptor.product, sequence, keyId, directory: destination, publication: 'not-published' }
}
if (import.meta.main) {
  if (process.argv.length !== 5) { console.error('Usage: node scripts/prepare-update-release.mjs DESCRIPTOR.json PRIVATE_KEY_FILE OUTPUT_DIRECTORY'); process.exitCode = 1 }
  else prepareRelease(JSON.parse(await readFile(process.argv[2], 'utf8')), process.argv[3], process.argv[4])
    .then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
