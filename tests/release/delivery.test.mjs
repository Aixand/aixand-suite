import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareDelivery } from '../../scripts/release/delivery.mjs'

test('signed staging flattens into exact immutable GitHub assets and fixed Worker paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'suite-delivery-'))
  try {
    const input = join(root, 'signed'), output = join(root, 'assets')
    const directory = join(input, 'aixand-suite-components/desktop/linux-x86_64-gnu')
    await mkdir(directory, { recursive: true })
    const envelope = { schema: 1, keyId: 'fixture', payload: '{}', signature: 'fixture' }
    await writeFile(join(directory, 'latest.candidate.json'), JSON.stringify(envelope))
    const object = join(input, 'aixand-suite-components/web/0.1.0-beta')
    await mkdir(object, { recursive: true })
    await writeFile(join(object, 'payload.tar.gz'), 'exact payload')
    const descriptor = await prepareDelivery(input, output, 'web/v0.1.0-beta')
    assert.equal(descriptor.feeds[0].path, '/aixand-suite-components/desktop/linux-x86_64-gnu/latest.json')
    assert.deepEqual(descriptor.feeds[0].envelope, envelope)
    const record = descriptor.objects[0]
    assert.equal(record.sha256, createHash('sha256').update('exact payload').digest('hex'))
    assert.equal(await readFile(join(output, record.asset), 'utf8'), 'exact payload')
    assert.equal(record.path, '/aixand-suite-components/web/0.1.0-beta/payload.tar.gz')
    assert.ok((await readFile(join(output, 'SHA256SUMS'), 'utf8')).includes('  delivery.json'))
    await assert.rejects(prepareDelivery(input, output, 'web/v0.1.0-beta'), /exist/)
    await assert.rejects(prepareDelivery(input, join(root, 'bad'), 'attacker/v1.0.0'), /tag/)
    if (process.platform !== 'win32') {
      await symlink(join(object, 'payload.tar.gz'), join(object, 'link'))
      await assert.rejects(prepareDelivery(input, join(root, 'links'), 'web/v0.1.0-beta'), /regular/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
