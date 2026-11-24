// Product installation owns its receipts; this worker only coordinates Suite.
import { readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { claimActivation, completeActivation } from './activation.mjs'
import { atomicJson } from './updates.mjs'
import { snapshotDatabases } from './update-worker.mjs'
import { processBirth } from './products.mjs'
import { owningLifecycle } from './component-updates.mjs'
import { productUpdateState, saveProductUpdateState, withProductUpdateLock, currentProductUpdatePlan,
  confirmProductUpdatePlan, stageProductPlan, productEngine, productUpdateInventory } from './product-updates.mjs'
import { readProductSelection, productSelectionPath } from './product-selection.mjs'
import { validateInstalledProducts } from './products.mjs'

const must = (ok, message) => { if (!ok) throw new Error(message) }
async function withWorkerLock(config, job, callback) {
  const deadline = Date.now() + 30000
  while (true) {
    let entered = false
    try { return await withProductUpdateLock(config, () => { entered = true; return callback() }) }
    catch (error) {
      if (entered || error.message !== 'Another product update operation is running.' || Date.now() >= deadline) throw error
      const state = productUpdateState(config)
      must(state.operation === job.operation && state.phase === 'preparing', 'Product worker launch is obsolete.')
      await delay(50)
    }
  }
}
export async function runProductUpdateWorker(config, job, dependencies = {}) {
  must(dependencies.outsideLifecycle === true, 'External owning-lifecycle launch is required.')
  // The launching request still owns this lock while it records our PID and
  // birth identity. Wait for that handoff before claiming activation.
  return withWorkerLock(config, job, async () => {
    const state = productUpdateState(config)
    must(job?.schema === 1 && state.operation === job.operation && state.phase === 'preparing'
      && resolve(config.root) === job.root && resolve(config.base) === job.base, 'Product worker job is obsolete or belongs to another workspace.')
    const authority = await claimActivation(config.base, job.operation, 'product')
    config = { ...config, input: { ...config.input, AIXAND_ACTIVATION_OPERATION: job.operation, AIXAND_ACTIVATION_OWNER: authority } }
    const lifecycle = await owningLifecycle(dependencies)
    const directory = dirname(job.path || join(config.base, 'software/product-updates/jobs', job.operation, 'job.json'))
    try {
      state.workerPid = process.pid; state.workerBirth = processBirth(config.root, process.pid); await saveProductUpdateState(config, state)
      const plan = await currentProductUpdatePlan(config, state, dependencies)
      must(plan.revision === job.revision, 'Complete product update plan changed before activation.')
      confirmProductUpdatePlan(plan, job.input)
      const staged = await stageProductPlan(config, plan, dependencies)
      must((await currentProductUpdatePlan(config, state, dependencies)).revision === plan.revision, 'Product update plan changed during staging.')
      const previous = readProductSelection(config.base)
      await atomicJson(join(directory, 'recovery.json'), { previousSelection: previous, plan, completed: [], state: 'prepared' })
      state.phase = 'installing'; state.completed = []; await saveProductUpdateState(config, state)
      // Close admission even when no service was running; concurrent lifecycle
      // operations must not start work between preflight and engine activation.
      await lifecycle.prepareUpdate(config)
      must((await lifecycle.updateBlockers(config)).length === 0, 'Workspace work appeared during product update preparation.')
      if (plan.running) {
        state.recovery.stopAttempted = true; await saveProductUpdateState(config, state)
        await lifecycle.stop(config, { migrate: false })
      }
      const current = await lifecycle.status(config)
      must(!current.services.some(s => ['running', 'starting', 'stopping'].includes(s.state)), 'Workspace services are still running.')
      must(productUpdateInventory(config).receiptDigest === plan.inventory.receiptDigest, 'Shared product installation changed after review.')
      const databases = await snapshotDatabases(config.base, join(directory, 'database-snapshots'))
      await atomicJson(join(directory, 'workspace-database-snapshots.json'), databases)
      const selection = structuredClone(previous)
      for (const id of plan.order) {
        const row = staged[id], candidate = plan.candidates[id]
        state.currentProduct = id; await saveProductUpdateState(config, state)
        if (candidate.action !== 'adopt') await (dependencies.engine || productEngine)(config, ['upgrade', '--artifact', row.artifact,
          '--expected-sha256', row.manifest_sha256, '--prefix', plan.inventory.prefix,
          '--scope', plan.inventory.scope, '--owner', plan.inventory.owner,
          '--request-id', 'product-update-' + job.operation + '-' + id,
          ...plan.licenses.flatMap(license => ['--accept-license', license.sha256])])
        const installed = productUpdateInventory(config).products[id]
        must(installed?.release === candidate.release, 'Installation engine did not select the reviewed product release.')
        if (candidate.action === 'restore') delete selection.assemblies[id]
        else selection.assemblies[id] = { manifestSha256: row.manifest_sha256, compatibleBuilds: candidate.compatibleBuilds }
        await atomicJson(productSelectionPath(config.base), selection)
        state.completed.push(id)
        await atomicJson(join(directory, 'recovery.json'), { previousSelection: previous, plan,
          completed: state.completed, state: 'installing', selected: selection })
        await saveProductUpdateState(config, state)
      }
      await (dependencies.validateProducts || validateInstalledProducts)(config.root, config.input, config.base)
      if (plan.running) {
        state.phase = 'restarting'; await saveProductUpdateState(config, state)
        await lifecycle.start(lifecycle.configuration ? lifecycle.configuration(config.root, config.input) : config)
      }
      state.phase = 'completed'; state.completedAt = Date.now(); state.currentProduct = null; state.error = null
      state.restoreBundled = false
      state.message = plan.kind === 'bundled-restore' ? 'Bundled tool versions restored.'
        : 'Selected products updated. Settings, accounts and saved history were retained.'
      await saveProductUpdateState(config, state)
      await atomicJson(join(directory, 'recovery.json'), { previousSelection: previous, plan, completed: state.completed, state: 'completed', selected: selection })
      await completeActivation(config.base, job.operation)
      return { completed: true, operation: job.operation, products: state.completed }
    } catch (error) {
      state.phase = 'failed'; state.recoveryRequired = true; state.error = error.message
      state.message = 'Product update stopped. Completed products are retained; inspect recovery before retrying.'
      await saveProductUpdateState(config, state)
      await atomicJson(join(directory, 'failure.json'), { operation: job.operation, completed: state.completed, currentProduct: state.currentProduct, error: error.message })
      // Never downgrade stateful products or restart an uncertain mixed state.
      // Activation ownership is deliberately retained for explicit recovery.
      throw error
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let job
  try {
    const file = resolve(process.argv[2]); job = JSON.parse(await readFile(file, 'utf8'))
    must(process.argv[3] === '--outside-lifecycle', 'External lifecycle launch marker is required.')
    await atomicJson(join(dirname(file), 'lease.json'), { operation: job.operation, pid: process.pid })
    const lifecycle = await import(pathToFileURL(join(job.root, 'runtime.mjs')).href)
    const config = lifecycle.configuration(job.root, { ...process.env, AIXAND_LOCAL_HOME: job.base })
    await runProductUpdateWorker(config, { ...job, path: file }, { outsideLifecycle: true, lifecycle })
  } catch (error) { console.error(error.message); process.exitCode = 1 }
  finally {
    if (process.platform === 'win32' && /^AixandComponentUpdate-[a-f0-9-]{36}$/.test(job?.taskName || '')) {
      const program = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
      await promisify(execFile)(program, ['-NoProfile', '-NonInteractive', '-Command', `Unregister-ScheduledTask -TaskName '${job.taskName}' -Confirm:$false`], { windowsHide: true, timeout: 30000 }).catch(() => {})
    }
  }
}
