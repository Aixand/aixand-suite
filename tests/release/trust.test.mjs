import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { validateTrust, buildTrust } from '../../scripts/release/configure-trust.mjs'

test('public trust validates exact fingerprints and rejects private keys or another origin', () => {
  const pair = generateKeyPairSync('ed25519')
  const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const id = createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
  const trust = { schema: 1, enabled: true, origin: 'https://downloads.aixand.org', keys: { [id]: pem } }
  assert.equal(validateTrust(trust), trust)
  assert.equal(buildTrust(trust, '0').enabled, false)
  assert.equal(buildTrust(trust, '3').enabled, true)
  assert.equal(trust.enabled, true)
  assert.throws(() => validateTrust({ ...trust, origin: 'https://evil.test' }), /public trust/)
  assert.throws(() => validateTrust({ ...trust, keys: { other: pem } }), /fingerprint/)
  assert.throws(() => validateTrust({ ...trust, keys: { [id]: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } }), /public keys/)
})
