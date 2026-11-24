// Offline signing of qualified, canonical product archives. No publication.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { productDefinitions, validateProductFeed } from '../runtime/product-feed.mjs'

const execute = promisify(execFile)
const own = dirname(fileURLToPath(import.meta.url))
const must = (ok, message) => { if (!ok) throw new Error(message) }
async function digest(file) {
  const hash = createHash('sha256')
  for await (const block of createReadStream(file)) hash.update(block)
  return hash.digest('hex')
}
async function prepare(descriptor, privateKeyFile, output, temporary, { python = process.platform === 'win32' ? 'python' : 'python3' } = {}) {
  must(descriptor && Array.isArray(descriptor.products), 'Supply qualified product inputs.')
  const origin = new URL(descriptor.origin)
  must(origin.protocol === 'https:' && origin.origin === descriptor.origin, 'Choose a trusted HTTPS update origin.')
  const privateKey = createPrivateKey(await readFile(privateKeyFile))
  must(privateKey.asymmetricKeyType === 'ed25519', 'Use an Ed25519 update signing key.')
  const publicKey = createPublicKey(privateKey), pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
  const schema = descriptor.schema ?? 1
  must([1, 2].includes(schema), 'Unsupported product feed schema.')
  const now = Date.now(), payload = { schema, product: 'aixand-suite-products', target: descriptor.target,
    sequence: descriptor.sequence ?? now, issuedAt: new Date(now).toISOString(),
    expiresAt: descriptor.expiresAt || new Date(now + 30 * 86400000).toISOString(), products: {} }
  const pending = []
  const seen = new Set()
  for (const item of descriptor.products) {
    must(item && Object.hasOwn(productDefinitions, item.id) && (schema === 2 || !seen.has(item.id)), 'Choose distinct known product IDs.')
    seen.add(item.id)
    const proof = JSON.parse(await readFile(resolve(item.qualification), 'utf8'))
    must(proof.schema === 1 && proof.kind === 'product-update-qualification' && proof.verified === true
      && proof.product === item.id && proof.target === descriptor.target
      && JSON.stringify(proof.compatibleBuilds) === JSON.stringify(item.compatibleBuilds)
      && proof.checks?.upgrade === true && proof.checks?.restart === true && proof.checks?.dataRetained === true,
    'Product updates require matching native upgrade, restart and data-retention qualification.')
    if (item.id === 'carrier') {
      must(proof.checks.httpPlanAndInstall === true && proof.checks.carrierMessagesRetained === true
        && proof.checks.carrierDelivery === true, 'Carrier qualification must verify retained messages and delivery after restart.')
    }
    const file = resolve(item.file), sha256 = await digest(file)
    must(schema === 1 && item.id !== 'carrier' && proof.archiveSha256 === undefined || proof.archiveSha256 === sha256,
      'Qualification does not identify the product archive bytes.')
    const artifact = join(await mkdtemp(join(temporary, item.id + '-')), 'artifacts')
    const { stdout } = await execute(python, ['-I', '-B', join(own, '../runtime/product-update-artifact.py'),
      '--archive', file, '--output', artifact, '--helper', join(own, '../dev'),
      '--archive-sha256', sha256, '--manifest-sha256', proof.manifestSha256,
      '--target', descriptor.target, '--selection', productDefinitions[item.id].product], { maxBuffer: 8 * 1024 * 1024 })
    const manifest = JSON.parse(stdout), product = manifest.products[productDefinitions[item.id].product]
    must(Object.keys(manifest.products).length === 1 && product.release === proof.release, 'Qualification does not identify this canonical product artifact.')
    const licenses = []
    if (product.license_acceptance) {
      const record = product.license_acceptance, entry = product.files[record.path]
      must(entry && /^objects\/[a-f0-9]{64}$/.test(entry.artifact), 'Invalid product license object.')
      licenses.push({ product: product.id, sha256: record.sha256,
        text: await readFile(join(artifact, entry.artifact), 'utf8') })
    }
    const path = `aixand-suite-products/${descriptor.target}/${item.id}/${product.version}/${sha256}${descriptor.target.startsWith('windows-') ? '.zip' : '.tar.gz'}`
    const candidate = { selection: product.id, version: product.version, release: product.release,
      compatibleBuilds: item.compatibleBuilds, requires: item.requires || {}, licenses,
      artifact: { url: descriptor.origin + '/' + path, sha256, size: (await stat(file)).size, manifestSha256: proof.manifestSha256 } }
    if (schema === 2) (payload.products[item.id] ??= []).push(candidate)
    else payload.products[item.id] = candidate
    pending.push({ file, path })
  }
  const encoded = JSON.stringify(payload)
  const envelope = { schema: 1, keyId, payload: encoded, signature: sign(null, Buffer.from(encoded), privateKey).toString('base64') }
  validateProductFeed(envelope, { enabled: true, origin: descriptor.origin, keys: { [keyId]: pem } }, { target: descriptor.target, schema })
  const destination = join(resolve(output), 'aixand-suite-products', descriptor.target)
  await mkdir(destination, { recursive: true })
  for (const item of pending) {
    const file = join(resolve(output), item.path)
    await mkdir(dirname(file), { recursive: true }); await copyFile(item.file, file, constants.COPYFILE_EXCL)
  }
  await writeFile(join(destination, schema === 2 ? 'catalog.candidate.json' : 'latest.candidate.json'), JSON.stringify(envelope) + '\n', { flag: 'wx' })
  return { target: descriptor.target, sequence: payload.sequence, products: Object.keys(payload.products), keyId, publication: 'not-published' }
}

export async function prepareProductFeed(descriptor, keyFile, output, options) {
  const temporary = await mkdtemp(join(tmpdir(), 'aixand-product-signing-'))
  try { return await prepare(descriptor, keyFile, output, temporary, options) }
  finally { await rm(temporary, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) throw new Error('Usage: node scripts/release/sign-products.mjs DESCRIPTOR PRIVATE_KEY_FILE OUTPUT')
    console.log(JSON.stringify(await prepareProductFeed(JSON.parse(await readFile(process.argv[2], 'utf8')), process.argv[3], process.argv[4])))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
