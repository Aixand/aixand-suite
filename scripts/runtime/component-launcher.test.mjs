import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { componentWorkerEnvironment, windowsComponentLaunch, launchComponentWorker } from './component-launcher.mjs'

const operation = 'b1111111-2222-3333-4444-555555555555'
test('helper environment excludes inherited manager paths and Windows launch retains exact task identity', () => {
  const config = { base: '/workspace', input: { HOME: '/user', PATH: '/bin', AGENT_MANAGER_HOMES_ROOT: '/live/accounts',
    NODE_OPTIONS: '--inspect', UNRELATED_SECRET: 'excluded' }, env: {} }
  const env = componentWorkerEnvironment(config)
  assert.equal(env.HOME, '/user'); assert.equal(env.AIXAND_LOCAL_HOME, '/workspace')
  assert.equal(env.NODE_OPTIONS, ''); assert.equal(env.AGENT_MANAGER_HOMES_ROOT, undefined)
  assert.equal(env.UNRELATED_SECRET, undefined)
  const launch = windowsComponentLaunch({ config, job: '/job', operation, worker: '/worker' })
  assert.equal(launch.taskName, 'AixandComponentUpdate-' + operation)
  const script = Buffer.from(launch.args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /Interactive/)
  assert.doesNotMatch(script, /live\/accounts|UNRELATED_SECRET/)
  assert.throws(() => windowsComponentLaunch({ config, operation: 'invalid' }), /identity/)
})

test('POSIX external launcher executes an exact finite worker and exposes its observed result', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'suite-component-launcher-'))
  try {
    const worker = join(root, 'worker.mjs'), job = join(root, 'job.json'), result = join(root, 'result.json')
    await writeFile(job, JSON.stringify({ result, operation }))
    await writeFile(worker, `import {readFile,writeFile} from 'node:fs/promises'; const job=JSON.parse(await readFile(process.argv[2])); await writeFile(job.result,JSON.stringify({operation:job.operation,pid:process.pid,outside:process.argv[3],home:process.env.HOME,manager:process.env.AGENT_MANAGER_HOME??null}));`)
    const receipt = await launchComponentWorker({ worker, job, operation, config: { base: root, input: { HOME: root, AGENT_MANAGER_HOME: '/live/state' }, env: {} } })
    let observed
    for (let index = 0; index < 100; index++) {
      try { observed = JSON.parse(await readFile(result, 'utf8')); break } catch (error) { if (error.code !== 'ENOENT') throw error }
      await delay(20)
    }
    assert.deepEqual(observed, { operation, pid: receipt.pid, outside: '--outside-lifecycle', home: root, manager: null })
    assert.equal(receipt.outsideLifecycle, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
