import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOptions, instanceEnvironment } from './server-cli.mjs'
import { safeDestination } from './server-installer.mjs'

test('console setup requires explicit license identities and supports independent cleanup selections', () => {
  const license = 'a'.repeat(64)
  assert.deepEqual(parseOptions(['--yes', '--all', '--accept-license', license, '--select', 'workspace']).selected, ['workspace'])
  assert.deepEqual(parseOptions(['--accept-license', license]).acceptedLicenses, [license])
  assert.throws(() => parseOptions(['--accept-license', 'latest']), /digest/)
  assert.throws(() => parseOptions(['--select']), /Missing value/)
})

test('installed instance settings select the saved workspace and cannot inject arbitrary runtime environment', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'aixand-server-settings-'))
  try {
    const root = join(temporary, 'runtime'); await mkdir(root)
    const file = join(temporary, 'server-installation.json')
    await writeFile(file, JSON.stringify({ schema: 1, workspace: join(temporary, 'workspace'), port: 18753, carrierPort: 18765, PYTHONPATH: '/untrusted', origins: 'https://suite.example' }))
    const env = await instanceEnvironment(root, { HOME: temporary })
    assert.equal(env.AIXAND_LOCAL_HOME, join(temporary, 'workspace'))
    assert.equal(env.AIXAND_LOCAL_PORT, '18753')
    assert.equal(env.AIXAND_PRODUCTION_ORIGINS, 'https://suite.example')
    assert.equal(env.PYTHONPATH, undefined)
    await writeFile(file, JSON.stringify({ schema: 1, workspace: 'relative', port: 8753, carrierPort: 8765 }))
    await assert.rejects(instanceEnvironment(root, { HOME: temporary }), /invalid/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('console installer never adopts an unrelated directory or a redirected application root', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'aixand-server-ownership-'))
  try {
    const target = join(temporary, 'application'); await mkdir(target); await writeFile(join(target, 'personal.txt'), 'keep')
    await assert.rejects(safeDestination(target), /not a recognized/)
    await assert.rejects(safeDestination(temporary, { HOME: temporary }), /dedicated/)
    const redirected = join(temporary, 'redirected')
    await symlink(target, redirected, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(safeDestination(redirected), /symbolic links or junctions/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
