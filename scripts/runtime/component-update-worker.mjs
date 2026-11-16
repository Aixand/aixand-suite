import { claimActivation, completeActivation } from './activation.mjs'
// The root launch adapter must place this worker outside the lifecycle being stopped.
import { readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { atomicJson } from './updates.mjs'
import { componentState, saveComponentState, withComponentLock, currentComponentPlan, confirmComponentPlan,
  stageComponentPlan, owningLifecycle, componentDigest, resolveComponentSelection } from './component-updates.mjs'

const must = (ok, message) => { if (!ok) throw new Error(message) }
async function withWorkerLock(config, job, callback) {
  const deadline = Date.now() + 30000
  while (true) {
    let entered = false
    try { return await withComponentLock(config, () => { entered = true; return callback() }) }
    catch (error) {
      if (entered || error.message !== 'Another component operation is in progress.' || Date.now() >= deadline) throw error
      const state = componentState(config)
      must(state.operation === job.operation && state.phase === 'preparing', 'Component worker launch is obsolete.')
      await delay(50)
    }
  }
}
export async function runComponentWorker(config, job, dependencies = {}) {
  must(dependencies.outsideLifecycle === true, 'External owning-lifecycle launch is required.')
  return withWorkerLock(config, job, async () => {
    const state = componentState(config)
    must(job?.schema === 1 && job.operation === state.operation && state.phase === 'preparing' && resolve(config.root) === job.root && resolve(config.base) === job.base, 'Worker job does not match the pending operation.')
    const authority = await claimActivation(config.base, job.operation, 'component')
    config = { ...config, input: { ...config.input, AIXAND_ACTIVATION_OPERATION: job.operation, AIXAND_ACTIVATION_OWNER: authority } }
    let stopped = false, committed = false, newRuntimeStarted = false
    const selection = join(config.base, 'config/component-selection.json')
    const lifecycle = await owningLifecycle(dependencies)
    try {
      state.workerPid = process.pid
      await saveComponentState(config, state)
      const plan = await currentComponentPlan(config, state, dependencies)
      must(plan.revision === job.revision, 'Complete component plan changed before worker activation.')
      confirmComponentPlan(plan, job.input)
      const staged = await stageComponentPlan(config, plan, dependencies)
      // Recheck all identities, licences, work and service state after extraction.
      must((await currentComponentPlan(config, state, dependencies)).revision === plan.revision, 'Complete component plan changed during staging.')
      const previous = state.recovery?.selection
      must(previous !== undefined, 'Missing recovery selection.')
      state.phase = 'installing'; await saveComponentState(config, state)
      if (plan.running) {
        // Mark intent first: a partial stop is also a recovery condition.
        state.recovery.stopAttempted = true; await saveComponentState(config, state)
        stopped = true
        must(typeof lifecycle.prepareUpdate === 'function', 'Owning lifecycle must support prepareUpdate to close work admission before stopping.')
        await lifecycle.prepareUpdate(config)
        must((await lifecycle.updateBlockers(config)).length === 0, 'Active work appeared during update preparation.')
        await lifecycle.stop(config, { migrate: false })
      }
      const fresh = await currentComponentPlan(config, state, dependencies)
      must(fresh.blockers.length === 0 && !fresh.running, 'Active work or services appeared before commit.')
      const { revision, ...body } = fresh
      body.running = plan.running; body.restartRequired = plan.restartRequired
      must(componentDigest(body) === plan.revision, 'Complete component plan changed before selection commit.')
      state.recovery.commitAttempted = true; await saveComponentState(config, state)
      await atomicJson(selection, { schema: 1, components: { ...(previous?.components || {}), ...staged } })
      committed = true
      resolveComponentSelection(config.root, config.base, { verifyPayloads: true })
      if (stopped) {
        const nextConfig = lifecycle.configuration ? lifecycle.configuration(config.root, config.input) : config
        newRuntimeStarted = true
        await lifecycle.start(nextConfig)
      }
      state.phase = 'completed'; state.completedAt = Date.now(); state.error = null
      state.recovery.completed = true
      await saveComponentState(config, state)
      await completeActivation(config.base, job.operation)
      return { completed: true, operation: job.operation }
    } catch (error) {
      let recoveryError
      try {
        // Starting new code can change state schemas, even if its health check
        // fails. Preserve the selected software and require reviewed recovery.
        if (newRuntimeStarted) throw new Error('The updated runtime started. Inspect retained recovery information before repair; automatic downgrade is refused.')
        if (committed) {
          must((await lifecycle.updateBlockers(config)).length === 0, 'Active work prevents automatic recovery; retain the recorded selection for manual repair.')
          if (stopped) {
            await lifecycle.prepareUpdate(config)
            must((await lifecycle.updateBlockers(config)).length === 0, 'Active work prevents recovery stop.')
            await lifecycle.stop(config, { migrate: false })
          }
          if (state.recovery.selection === null) await rm(selection, { force: true })
          else await atomicJson(selection, state.recovery.selection)
        }
        // Restart is covered by the prior reviewed consent, including rollback.
        if (stopped && job.input.restartConsent === true) {
          const previousConfig = lifecycle.configuration ? lifecycle.configuration(config.root, config.input) : config
          await lifecycle.start(previousConfig)
        }
      } catch (failure) { recoveryError = failure.message }
      state.phase = 'failed'; state.error = error.message
      if (recoveryError) { state.recoveryError = recoveryError; state.recoveryRequired = true }
      state.failedAt = Date.now(); await saveComponentState(config, state)
      throw error
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let job
  try {
    must(process.argv[3] === '--outside-lifecycle', 'Root external launch adapter must supply --outside-lifecycle.')
    job = JSON.parse(await readFile(process.argv[2], 'utf8'))
    await atomicJson(join(dirname(process.argv[2]), 'lease.json'), { operation: job.operation, pid: process.pid })
    const lifecycle = await import('./runtime.mjs')
    const config = lifecycle.configuration(job.root, { ...process.env, AIXAND_LOCAL_HOME: job.base })
    for (let attempt = 0; ; attempt++) {
      try { await runComponentWorker(config, job, { outsideLifecycle: true }); break }
      catch (error) {
        if (attempt >= 100 || error.message !== 'Another component operation is in progress.') throw error
        await delay(100)
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
  finally {
    if (process.platform === 'win32' && /^AixandComponentUpdate-[a-f0-9-]{36}$/.test(job?.taskName || '')) {
      const program = join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
      await promisify(execFile)(program, ['-NoProfile', '-NonInteractive', '-Command', `Unregister-ScheduledTask -TaskName '${job.taskName}' -Confirm:$false`], { timeout: 30000, windowsHide: true }).catch(() => {})
    }
  }
}
