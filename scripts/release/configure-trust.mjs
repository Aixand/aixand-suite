// Prepare public updater trust in the runner's temporary directory, never source.
import { createPublicKey, createHash } from 'node:crypto'
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function validateTrust(trust) {
  const require = (ok, message) => { if (!ok) throw new Error(message) }
  require(trust && Object.keys(trust).sort().join() === 'enabled,keys,origin,schema' && trust.schema === 1
    && typeof trust.enabled === 'boolean' && trust.origin === 'https://downloads.aixand.org'
    && trust.keys && typeof trust.keys === 'object' && !Array.isArray(trust.keys) && Object.keys(trust.keys).length > 0,
  'Use schema 1 public trust for https://downloads.aixand.org.')
  for (const [id, pem] of Object.entries(trust.keys)) {
    require(typeof pem === 'string' && pem.startsWith('-----BEGIN PUBLIC KEY-----'), 'Supply public keys only.')
    const key = createPublicKey(pem)
    require(key.asymmetricKeyType === 'ed25519' && id === createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16),
      'Trust keys must be Ed25519 with their exact fingerprint IDs.')
  }
  return trust
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const trust = validateTrust(JSON.parse(process.env.SUITE_UPDATE_TRUST_JSON))
    const directory = await mkdtemp(join(process.env.RUNNER_TEMP, 'suite-public-trust-'))
    const file = join(directory, 'update-config.json')
    await writeFile(file, JSON.stringify(trust) + '\n', { flag: 'wx', mode: 0o600 })
    await appendFile(process.env.GITHUB_ENV, `AIXAND_UPDATE_CONFIG=${file}\nAIXAND_CLIENT_UPDATE_CONFIG=${file}\n`)
    console.log(`Prepared public updater trust; enabled=${trust.enabled}. No source configuration changed.`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
