import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetLabel, uploadArguments, releaseTitle, releaseGuide } from '../../scripts/release/label-assets.mjs'

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


test('application names distinguish Client, Server, Suite and web-only assets', () => {
  assert.equal(releaseTitle('suite/v0.1.0-alpha.3'), 'Aixand Suite 0.1.0-alpha.3')
  assert.equal(releaseTitle('client/v0.1.0-alpha.3'), 'Aixand Client 0.1.0-alpha.3')
  assert.equal(releaseTitle('server/v0.1.0-alpha.3'), 'Aixand Server 0.1.0-alpha.3')
  assert.match(releaseTitle('web/v0.1.0-alpha.3'), /Aixand Client.*Web assets.*not an installer/)
  assert.match(releaseTitle('runner-client/v0.1.0-alpha.2'), /Runner Python library/)
  assert.match(releaseGuide('web/v0.1.0-alpha.3'), /not the installable Aixand Client/)
  assert.equal(assetLabel('web-0.1.0-alpha.3-linux-x86_64-gnu.tar.gz'), 'aixand-client-web-assets-0.1.0-alpha.3-linux-x86_64-gnu.tar.gz')
  assert.match(assetLabel('suite-client-0.1.0-alpha.3-application.json'), /aixand-client-/)
  assert.throws(() => releaseTitle('unknown/v1.0.0'), /Unknown/)
})
