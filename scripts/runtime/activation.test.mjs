import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withRequestLock, reserveActivation, claimActivation, withActivationAccess, completeActivation } from './activation.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runUpdate } from './update-worker.mjs'

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'activation-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  return base
}
const barrier = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }

test('native admission excludes component admission and ordinary lifecycle until owner finishes', async t => {
  const base = await fixture(t), entered = barrier(), finish = barrier()
  const lifecycle = withActivationAccess(base, null, async () => { entered.release(); await finish.promise })
  await entered.promise
  await assert.rejects(reserveActivation(base, 'native', 'native'), /operation/)
  finish.release(); await lifecycle
  await reserveActivation(base, 'native', 'native')
  await assert.rejects(reserveActivation(base, 'component', 'component'), /reserved/)
  await assert.rejects(withActivationAccess(base, null, () => assert.fail('ordinary startup entered')), /reserved/)
  await claimActivation(base, 'native', 'native')
  await assert.rejects(claimActivation(base, 'native', 'native'), /already claimed/)
  let starts = 0
  await withActivationAccess(base, 'native', () => { starts++ })
  assert.equal(starts, 1)
  await completeActivation(base, 'native')
  await reserveActivation(base, 'component', 'component')
  await assert.rejects(withActivationAccess(base, 'native', () => assert.fail('old owner entered')), /reserved/)
})

test('aged ownerless locks recover; fresh acquiring lock and concurrent reclaimers retain winner', async t => {
  const base = await fixture(t), lock = join(base, '.lock')
  for (const body of ['', '{"pid":']) {
    await writeFile(lock, body)
    await assert.rejects(withRequestLock(lock, () => assert.fail('fresh acquiring lock entered')), /operation/)
    const aged = new Date(Date.now() - 180000); await utimes(lock, aged, aged)
    const entered = barrier(), finish = barrier()
    const winner = withRequestLock(lock, async () => { entered.release(); await finish.promise })
    await entered.promise
    const published = await readFile(lock, 'utf8')
    await assert.rejects(withRequestLock(lock, () => assert.fail('second reclaimer entered')), /operation/)
    assert.equal(await readFile(lock, 'utf8'), published)
    finish.release(); await winner
  }
})

test('obsolete native job cannot publish a lease or mutate persisted state', async t => {
  const base = await fixture(t), directory = join(base, 'jobs/old'), updateDirectory = join(base, 'updates')
  await mkdir(directory, { recursive: true }); await mkdir(updateDirectory)
  const jobFile = join(directory, 'job.json'), stateFile = join(updateDirectory, 'state.json')
  await writeFile(jobFile, JSON.stringify({ operation: 'old', config: { updateDirectory }, workspace: base }))
  const state = JSON.stringify({ operation: 'new', job: join(base, 'jobs/new/job.json'), phase: 'preparing' })
  await writeFile(stateFile, state)
  await assert.rejects(runUpdate(jobFile), /Obsolete/)
  assert.equal(await readFile(stateFile, 'utf8'), state)
  await assert.rejects(readFile(join(directory, 'lease.json')), { code: 'ENOENT' })
})

test('two simultaneous stale reclaimers cannot remove the live winning lock', async t => {
  const base = await fixture(t), lock = join(base, '.lock'), entered = barrier(), finish = barrier()
  await writeFile(lock, '{')
  const aged = new Date(Date.now() - 180000); await utimes(lock, aged, aged)
  let admissions = 0
  const attempt = () => withRequestLock(lock, async () => { admissions++; entered.release(); await finish.promise }).then(() => 'entered', () => 'refused')
  const first = attempt(), second = attempt()
  await entered.promise
  const owner = await readFile(lock, 'utf8')
  // Both requests are already started; the second must refuse while winner waits.
  assert.equal(await Promise.race([first, second]), 'refused')
  assert.equal(await readFile(lock, 'utf8'), owner)
  finish.release()
  assert.deepEqual((await Promise.all([first, second])).sort(), ['entered', 'refused'])
  assert.equal(admissions, 1)
})


test('another process cannot borrow an operation identity without the worker handoff capability', async t => {
  const base = await fixture(t)
  await reserveActivation(base, 'native', 'native')
  const authority = await claimActivation(base, 'native', 'native')
  const script = `import { withActivationAccess } from ${JSON.stringify(new URL('./activation.mjs', import.meta.url).href)};
    try { await withActivationAccess(process.argv[1], 'native', () => {}, process.argv[2]); process.stdout.write('entered') }
    catch { process.stdout.write('refused') }`
  const run = promisify(execFile)
  const denied = await run(process.execPath, ['--input-type=module', '-e', script, base, 'incorrect'])
  assert.equal(denied.stdout, 'refused')
  const allowed = await run(process.execPath, ['--input-type=module', '-e', script, base, authority])
  assert.equal(allowed.stdout, 'entered')
  await completeActivation(base, 'native')
})


for (const removeWorkspace of [false, true]) test(`lock release preserves authorized removal of ${removeWorkspace ? 'workspace' : 'updates directory'}`, async t => {
  const base = await fixture(t), workspace = join(base, 'workspace'), updates = join(workspace, 'updates')
  const lock = join(updates, '.activation-lock'), removed = removeWorkspace ? workspace : updates
  const result = await withRequestLock(lock, async () => {
    await rm(removed, { recursive: true })
    return 'removed'
  })
  assert.equal(result, 'removed')
  await assert.rejects(readFile(lock), { code: 'ENOENT' })
  // A release must not recreate even an empty directory after cleanup.
  await assert.rejects(stat(removed), { code: 'ENOENT' })
})

test('lock release after namespace removal preserves callback error', async t => {
  const base = await fixture(t), updates = join(base, 'updates'), failure = new Error('cleanup failed after removal')
  await assert.rejects(withRequestLock(join(updates, '.lock'), async () => {
    await rm(updates, { recursive: true })
    throw failure
  }), error => error === failure)
  await assert.rejects(stat(updates), { code: 'ENOENT' })
})

test('release cannot remove a replacement owner after callback replaces the namespace', async t => {
  const base = await fixture(t), updates = join(base, 'updates'), lock = join(updates, '.lock')
  const entered = barrier(), finish = barrier()
  let replacement, published
  try {
    await withRequestLock(lock, async () => {
      await rm(updates, { recursive: true })
      replacement = withRequestLock(lock, async () => {
        published = await readFile(lock, 'utf8'); entered.release(); await finish.promise
      })
      await entered.promise
    })
    assert.equal(await readFile(lock, 'utf8'), published)
  } finally { finish.release(); await replacement }
})
