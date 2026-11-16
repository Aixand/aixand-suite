import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetLabel, uploadArguments } from '../../scripts/release/label-assets.mjs'

test('release labels explain sidecars and preserve upload filenames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'suite-labels-'))
  try {
    const name = 'legacy-hash-installer.exe'
    const path = '/aixand-client/0.1.0-alpha.3.r123/abcdef0123456789-Aixand-Client_x64-setup.exe'
    await writeFile(join(root, name), 'exact bytes')
    await writeFile(join(root, 'delivery.json'), JSON.stringify({ objects: [{ asset: name, path }] }))
    await writeFile(join(root, 'TESTING.json'), '{}')
    const args = uploadArguments(root)
    assert.ok(args.includes(`${join(root, name)}#aixand-client-0.1.0-alpha.3-windows-x64-setup.exe`))
    assert.match(args.find(arg => arg.startsWith(join(root, 'TESTING.json') + '#')), /Testing report/)
    assert.match(assetLabel('composition.json'), /Release inventory/)
    assert.match(assetLabel('delivery.json'), /Update delivery map/)
    assert.equal(assetLabel('installer.exe'), 'installer.exe')
  } finally { await rm(root, { recursive: true, force: true }) }
})
