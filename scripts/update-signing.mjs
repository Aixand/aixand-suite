// Explicit local key initialization. Private bytes never enter release output.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdir, open, readFile, chmod, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function initializeSigning(directory, origin = 'https://downloads.aixand.org') {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('Choose an HTTPS release origin.')
  directory = resolve(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'update-signing-key.pem')
  let key
  try {
    key = createPrivateKey(await readFile(file))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const pair = generateKeyPairSync('ed25519')
    const handle = await open(file, 'wx', 0o600)
    try { await handle.writeFile(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })); await handle.sync() }
    finally { await handle.close() }
    key = pair.privateKey
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The existing signing key is not Ed25519; it was preserved.')
  await chmod(file, 0o600)
  const publicKey = createPublicKey(key), pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
  const configuration = { schema: 1, enabled: true, origin, keys: { [keyId]: pem } }
  await writeFile(join(directory, 'public-update-config.json'), JSON.stringify(configuration, null, 2) + '\n', { mode: 0o644 })
  return { directory, privateKeyFile: file, publicConfiguration: join(directory, 'public-update-config.json'), keyId }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length < 3 || process.argv.length > 4) { console.error('Usage: node scripts/update-signing.mjs PRIVATE_DIRECTORY [HTTPS_ORIGIN]'); process.exitCode = 1 }
  else initializeSigning(process.argv[2], process.argv[3]).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
