// Prepare immutable, signed component feeds locally. Nothing is uploaded.
import { createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto'
import { readFile, mkdir, copyFile, writeFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { componentDigest, validateComponentFeed } from '../runtime/component-updates.mjs'

const execute = promisify(execFile)
const require = (ok, message) => { if (!ok) throw new Error(message) }
const own = dirname(fileURLToPath(import.meta.url))
async function fileHash(file) {
  const digest = createHash('sha256')
  for await (const block of createReadStream(file)) digest.update(block)
  return digest.digest('hex')
}
export async function prepareComponentFeed(descriptor, privateKeyFile, output, { python = process.platform === 'win32' ? 'python' : 'python3' } = {}) {
  require(descriptor && ['desktop', 'server', 'client'].includes(descriptor.role) && Array.isArray(descriptor.components), 'Choose a role and component artifact inputs.')
  const origin = new URL(descriptor.origin)
  require(origin.protocol === 'https:' && origin.href === origin.origin + '/' && !origin.username && !origin.password, 'Use an HTTPS origin.')
  const key = createPrivateKey(await readFile(privateKeyFile))
  require(key.asymmetricKeyType === 'ed25519', 'Use an Ed25519 release signing key.')
  const publicKey = createPublicKey(key), pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
  const now = new Date(), issuedAt = now.toISOString()
  const payload = { schema: 2, product: 'aixand-suite-components', role: descriptor.role, target: descriptor.target,
    sequence: descriptor.sequence, publishedAt: descriptor.publishedAt || issuedAt, issuedAt,
    expiresAt: descriptor.expiresAt || new Date(now.getTime() + 30 * 86400000).toISOString(), components: {} }
  const pending = []
  for (const item of descriptor.components) {
    require(item && typeof item.id === 'string' && !Object.hasOwn(payload.components, item.id), 'Choose distinct component IDs.')
    const file = resolve(item.file)
    const { stdout } = await execute(python, ['-B', join(own, 'artifacts.py'), 'verify', '--artifact', file, '--component', item.id, '--target', descriptor.target], { maxBuffer: 32 * 1024 * 1024 })
    const manifest = JSON.parse(stdout), sha256 = await fileHash(file)
    const object = `${item.id}/${manifest.version}/${manifest.release}-${sha256}.tar.gz`
    const licenses = []
    for (const license of item.licenses || []) {
      require(license && typeof license.id === 'string' && license.id.length > 0, 'Name each reviewed licence.')
      const licenseFile = resolve(license.file), digest = await fileHash(licenseFile)
      const path = 'licenses/' + digest + '.txt'
      licenses.push({ id: license.id, sha256: digest, url: origin.origin + '/aixand-suite-components/' + path })
      pending.push({ file: licenseFile, path })
    }
    payload.components[item.id] = { version: manifest.version, release: manifest.release, target: manifest.target,
      kind: manifest.kind, activation: manifest.activation, requires: manifest.requires, inputs: manifest.inputs,
      artifact: { url: origin.origin + '/aixand-suite-components/' + object, sha256, size: (await stat(file)).size,
        manifestSha256: componentDigest(manifest) }, licenses }
    pending.push({ file, path: object })
  }
  const text = JSON.stringify(payload)
  const envelope = { schema: 1, keyId, payload: text, signature: sign(null, Buffer.from(text), key).toString('base64') }
  validateComponentFeed(envelope, { enabled: true, origin: origin.origin, keys: { [keyId]: pem } }, { role: descriptor.role, target: descriptor.target })
  const destination = join(resolve(output), 'aixand-suite-components')
  await mkdir(resolve(output), { recursive: true })
  // Fresh staging is deliberate; copying cannot replace an immutable release.
  await mkdir(destination)
  const copied = new Set()
  for (const item of pending) {
    if (copied.has(item.path)) continue
    copied.add(item.path)
    const file = join(destination, item.path)
    await mkdir(dirname(file), { recursive: true }); await copyFile(item.file, file)
  }
  const feed = join(destination, descriptor.role, descriptor.target, 'latest.candidate.json')
  await mkdir(dirname(feed), { recursive: true })
  await writeFile(feed, JSON.stringify(envelope) + '\n', { flag: 'wx' })
  return { publication: 'not-published', keyId, candidate: feed, components: Object.keys(payload.components) }
}
if (import.meta.main) {
  try {
    require(process.argv.length === 5, 'Usage: node scripts/release/sign-components.mjs DESCRIPTOR PRIVATE_KEY OUTPUT')
    console.log(JSON.stringify(await prepareComponentFeed(JSON.parse(await readFile(process.argv[2], 'utf8')), process.argv[3], process.argv[4])))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
