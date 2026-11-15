import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareProductFeed } from '../../scripts/release/sign-products.mjs'
import { validateProductFeed } from '../../scripts/runtime/product-feed.mjs'

test('offline product signing creates verifiable feeds and refuses unqualified promotion or mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-signing-test-'))
  try {
    const pair = generateKeyPairSync('ed25519'), key = join(root, 'private.pem')
    await writeFile(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    const descriptor = { origin: 'https://updates.example', target: 'linux-x86_64-gnu', sequence: 1, products: [] }
    const result = await prepareProductFeed(descriptor, key, join(root, 'output'))
    const envelope = JSON.parse(await readFile(join(root, 'output/aixand-suite-products/linux-x86_64-gnu/latest.candidate.json'), 'utf8'))
    const feed = validateProductFeed(envelope, { enabled: true, origin: descriptor.origin,
      keys: { [result.keyId]: pair.publicKey.export({ type: 'spki', format: 'pem' }) } }, { target: descriptor.target })
    assert.deepEqual(feed.products, {}); assert.equal(result.publication, 'not-published')
    assert.equal(JSON.stringify(envelope).includes('PRIVATE KEY'), false)
    await assert.rejects(prepareProductFeed(descriptor, key, join(root, 'output')), /exist/)
    const qualification = join(root, 'unqualified.json')
    await writeFile(qualification, JSON.stringify({ schema: 1, kind: 'product-update-qualification', verified: false }))
    await assert.rejects(prepareProductFeed({ ...descriptor, products: [{ id: 'runner', qualification }] }, key, join(root, 'rejected')), /qualification/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
