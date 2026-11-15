import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOptions, instanceEnvironment, componentSelection, componentUpdate } from './server-cli.mjs'
import { safeDestination } from './server-installer.mjs'

test('console setup requires explicit license identities and supports independent cleanup selections', () => {
  const license = 'a'.repeat(64)
  assert.deepEqual(parseOptions(['--yes', '--all', '--accept-license', license, '--select', 'workspace']).selected, ['workspace'])
  assert.deepEqual(parseOptions(['--accept-license', license]).acceptedLicenses, [license])
  assert.throws(() => parseOptions(['--accept-license', 'latest']), /digest/)
  assert.throws(() => parseOptions(['--select']), /Missing value/)
  assert.equal(parseOptions(['--installation-mode', 'isolated']).installationMode, 'isolated')
  assert.throws(() => parseOptions(['--installation-mode', 'other']), /shared.*isolated/)
  assert.equal(parseOptions(['--installation-mode', 'shared']).installationMode, 'shared')
  assert.equal(parseOptions(['--all']).all, true)
  assert.equal(parseOptions(['--purge']).purge, true)
  assert.equal(parseOptions(['--remove-target', 'tools']).removeTarget, 'tools')
  assert.equal(parseOptions(['--remove-target', 'everything']).removeTarget, 'everything')
  assert.equal(parseOptions(['--existing-files', 'remove']).existingFiles, 'remove')
  assert.throws(() => parseOptions(['--existing-files', 'anything']), /backup or remove/)
  assert.throws(() => parseOptions(['--remove-target', 'everything', '--select', 'workspace']), /cannot be combined/)
  assert.throws(() => parseOptions(['--remove-target', 'unknown']), /application, tools or both/)
  assert.throws(() => parseOptions(['--settings', 'delete']), /fresh, copy.*reuse/)
  assert.throws(() => parseOptions(['--settings', 'legacy']), /fresh/)
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


test('cleanup 0 selects every available component while Enter preserves everything', () => {
  const items = [{ id: 'workspace', available: true }, { id: 'provider:manual', available: false },
    { id: 'product:undercurrent', available: true }]
  assert.deepEqual(componentSelection('0', items), ['workspace', 'product:undercurrent'])
  assert.deepEqual(componentSelection(' 0 ', items), ['workspace', 'product:undercurrent'])
  assert.deepEqual(componentSelection('', items), [])
  assert.deepEqual(componentSelection('   ', items), [])
  assert.deepEqual(componentSelection('3, 1, 3', items), ['product:undercurrent', 'workspace'])
  for (const input of ['0,1', '2', '4', '-1', '1,', '1e0', 'all'])
    assert.throws(() => componentSelection(input, items))
})

test('component updates require selection, licences and explicit restart consent', async () => {
  const calls = []
  const licence = 'a'.repeat(64)
  const invoke = async (action, input) => {
    calls.push({ action, input })
    return action === 'plan' ? { revision: 'revision', licenses: [{ sha256: licence }], restartRequired: true, companions: ['server'] } : { started: true }
  }
  await assert.rejects(componentUpdate({}, parseOptions(['plan']), invoke), /Select components/)
  await assert.rejects(componentUpdate({}, parseOptions(['install', '--select', 'server', '--yes']), invoke), /license acceptance/)
  await assert.rejects(componentUpdate({}, parseOptions(['install', '--select', 'server', '--yes', '--accept-license', licence]), invoke), /restart-consent/)
  const result = await componentUpdate({}, parseOptions(['install', '--select', 'server', '--yes', '--accept-license', licence, '--restart-consent']), invoke)
  assert.equal(result.started, true)
  assert.deepEqual(calls.at(-1), { action: 'install', input: { confirmed: true, revision: 'revision', restartConsent: true, acceptedLicenses: [licence] } })
  await componentUpdate({}, parseOptions(['automatic-download', 'on']), invoke)
  assert.deepEqual(calls.at(-1), { action: 'settings', input: { automaticDownload: true } })
})
