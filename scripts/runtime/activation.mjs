// Workspace activation admission and recoverable request locks.
import { mkdir, readFile, writeFile, rename, rm, stat, link } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const need = (ok, message) => { if (!ok) throw new Error(message) }
async function read(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
function dead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return false } catch (e) { return e.code === 'ESRCH' }
}
// All publication, reclamation and release uses the same arbitration directory.
// Never reclaim arbitration itself: its uncertain owner requires manual recovery.
// Recovery: quiesce every updater and lifecycle caller for this workspace, confirm
// no acquiring/releasing process remains, retain activation.json and job journals,
// then remove ONLY the empty <lock>.arbitration directory. Never use age alone.
// An interrupted activation reservation is separate: inspect its exact operation
// and recovery journal before any supervised repair; do not clear it as a lock.
async function arbitrate(path, callback, allowMissing = false) {
  const guard = path + '.arbitration'
  for (let n = 0; ; n++) {
    try { await mkdir(guard, { mode: 0o700 }); break }
    catch (e) {
      // An authorized cleanup callback may remove the entire lock namespace.
      // Release never recreates parents; a replacement namespace still uses the token check.
      if (allowMissing && e.code === 'ENOENT') return
      if (e.code !== 'EEXIST') throw e; need(n < 200, 'Lock arbitration is busy or interrupted; inspect recovery.'); await delay(10)
    }
  }
  try { return await callback() } finally { await rm(guard, { recursive: true, force: true }) }
}
export async function withRequestLock(path, callback, message = 'Another update operation is in progress.') {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  await arbitrate(path, async () => {
    let owner, info
    try { info = await stat(path); try { owner = await read(path) } catch (e) { if (!(e instanceof SyntaxError)) throw e } }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    if (info) {
      need(owner?.pid ? dead(owner.pid) : Date.now() - info.mtimeMs > 120000, message)
      await rm(path)
    }
    const temporary = path + '.' + token
    try {
      await writeFile(temporary, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 })
      // Publish a complete owner without exposing a create/write gap.
      await link(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  })
  try { return await callback() }
  finally { await arbitrate(path, async () => { if ((await read(path))?.token === token) await rm(path, { force: true }) }, true) }
}
const reservation = base => join(base, 'updates/activation.json')
async function save(path, value) {
  const temporary = path + '.' + randomUUID()
  try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}
export function withActivationAccess(base, operation, callback, authority) {
  return withRequestLock(join(base, 'updates/.activation-lock'), async () => {
    const owner = await read(reservation(base))
    need(owner ? operation === owner.operation && Number.isInteger(owner.workerPid) && owner.workerPid > 0 && !dead(owner.workerPid) && (owner.workerPid === process.pid || (typeof authority === 'string' && authority === owner.authority)) : true,
      'Workspace activation is reserved or its owner is uncertain; inspect the retained operation journal.')
    return callback()
  })
}
export function reserveActivation(base, operation, kind) {
  return withActivationAccess(base, null, () => save(reservation(base), { schema: 1, operation, kind, admittedPid: process.pid, workerPid: null }))
}
export function claimActivation(base, operation, kind) {
  return withRequestLock(join(base, 'updates/.activation-lock'), async () => {
    const owner = await read(reservation(base))
    need(owner?.operation === operation && owner.kind === kind && owner.workerPid === null,
      'Activation worker is obsolete, already claimed, or has uncertain ownership.')
    const authority = randomUUID()
    await save(reservation(base), { ...owner, workerPid: process.pid, authority })
    return authority
  })
}
export function completeActivation(base, operation) {
  return withActivationAccess(base, operation, () => rm(reservation(base)))
}
