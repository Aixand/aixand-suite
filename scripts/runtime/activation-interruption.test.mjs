import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm, rmdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withRequestLock, reserveActivation, claimActivation, withActivationAccess, completeActivation } from './activation.mjs'

const moduleUrl = new URL('./activation.mjs', import.meta.url).href
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'activation-interruption-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  return base
}
async function heldChild(t, base, mode) {
  const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const [base, mode] = process.argv.slice(1);
    const hold = async () => { process.stdout.write('ready\\n'); await new Promise(() => { setInterval(() => {}, 1000) }) };
    if (mode === 'arbitration') {
      const mkdir = fs.mkdir;
      fs.mkdir = async (...args) => { const result = await mkdir(...args); if (args[0].endsWith('.arbitration')) await hold(); return result };
      syncBuiltinESMExports();
    }
    const a = await import(${JSON.stringify(moduleUrl)});
    if (mode === 'request' || mode === 'arbitration') await a.withRequestLock(base + '/updates/.activation-lock', hold);
    else { await a.reserveActivation(base, 'interrupted', mode); if (mode !== 'handoff') await a.claimActivation(base, 'interrupted', mode); await hold() }
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, base, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child readiness timeout: ' + stderr)), 10000)
    child.stdout.once('data', () => { clearTimeout(timer); resolve() })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Child exited before readiness: ' + stderr)) })
    child.once('error', reject)
  })
  return async () => { const exited = once(child, 'exit'); child.kill('SIGKILL'); assert.deepEqual(await exited, [null, 'SIGKILL']) }
}

for (const kind of ['handoff', 'native', 'component']) test(`SIGKILL retains ${kind} reservation and denies startup and takeover`, { timeout: 15000 }, async t => {
  const base = await fixture(t), kill = await heldChild(t, base, kind)
  const file = join(base, 'updates/activation.json'), before = await readFile(file, 'utf8')
  const journal = join(base, 'updates/recovery.json')
  await writeFile(journal, '{"retained":"recovery evidence"}')
  await kill()
  await assert.rejects(withActivationAccess(base, null, () => assert.fail('startup admitted')), /reserved/)
  await assert.rejects(reserveActivation(base, 'replacement', 'native'), /reserved/)
  if (kind !== 'handoff') {
    await assert.rejects(claimActivation(base, 'interrupted', kind), /already claimed/)
    await assert.rejects(withActivationAccess(base, 'interrupted', () => assert.fail('dead owner admitted'), JSON.parse(before).authority), /reserved/)
    await assert.rejects(completeActivation(base, 'interrupted'), /reserved/)
  } else {
    // A reserved but unclaimed operation remains claimable only by its exact handoff identity.
    await assert.rejects(claimActivation(base, 'obsolete', kind), /obsolete/)
  }
  assert.equal(await readFile(file, 'utf8'), before)
  assert.equal(await readFile(journal, 'utf8'), '{"retained":"recovery evidence"}')
  if (kind === 'handoff') {
    await claimActivation(base, 'interrupted', kind)
    await completeActivation(base, 'interrupted')
    await assert.rejects(stat(file), { code: 'ENOENT' })
  }
})

test('SIGKILL of request holder permits dead-PID reclamation', { timeout: 15000 }, async t => {
  const base = await fixture(t), kill = await heldChild(t, base, 'request')
  const lock = join(base, 'updates/.activation-lock')
  await kill()
  let entered = false
  await withRequestLock(lock, async () => { entered = true; assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid) })
  assert.equal(entered, true)
  await assert.rejects(stat(lock), { code: 'ENOENT' })
})

test('SIGKILL inside arbitration fails closed; quiesced empty-guard removal preserves reservation', { timeout: 15000 }, async t => {
  const base = await fixture(t), kill = await heldChild(t, base, 'arbitration')
  const lock = join(base, 'updates/.activation-lock'), guard = lock + '.arbitration'
  await kill()
  // Simulate a previously retained operation, without granting any worker authority.
  const reservation = join(base, 'updates/activation.json'), retained = '{"operation":"retained","workerPid":null}'
  await writeFile(reservation, retained)
  await assert.rejects(withActivationAccess(base, null, () => assert.fail('startup admitted')), /arbitration is busy or interrupted/)
  assert.equal((await stat(guard)).isDirectory(), true)
  // All fixture participants are now quiesced. Only the empty guard is removed.
  await rmdir(guard)
  await assert.rejects(withActivationAccess(base, null, () => assert.fail('startup admitted after guard recovery')), /reserved/)
  assert.equal(await readFile(reservation, 'utf8'), retained)
})
