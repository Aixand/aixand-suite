// Disposable real-daemon qualification: 16 panes, one unacknowledged consumer,
// sustained output, concurrent interactive input, and bounded bridge memory.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binaries =
  process.env.UNDERCURRENT_BIN_DIR ??
  resolve(server, '../../../undercurrent/target/debug')
const work = await mkdtemp(resolve(tmpdir(), 'aixand-terminal-pressure-'))
const env = {
  ...process.env,
  UNDERCURRENT_HOME: resolve(work, 'runtime'),
  TERMINAL_CWD: work,
}
const seconds = Math.max(
  3,
  Math.min(300, Number(process.env.TERMINAL_PRESSURE_SECONDS) || 30)
)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const daemon = spawn(resolve(binaries, 'uc-daemon'), [], {
  env,
  stdio: 'ignore',
})
let bridge
const pending = new Map()
const blocked = new Set()
const output = new Map()
const screens = new Set()
const receivedBytes = new Map()
const streamErrors = []
let backendResets = 0
let peakRss = 0
let sampler
function send(op, args, id = randomUUID()) {
  bridge.stdin.write(JSON.stringify({ id, op, args }) + '\n')
  return id
}
function request(op, args = {}) {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${op} timed out`))
    }, 15_000)
    pending.set(id, { resolve, reject, timer })
    send(op, args, id)
  })
}
async function until(predicate, message, timeout = 10_000) {
  const started = performance.now()
  while (!predicate()) {
    assert(performance.now() - started < timeout, message)
    await pause(10)
  }
}
async function rss() {
  if (process.platform !== 'linux') return 0
  try {
    return (
      Number(
        (await readFile(`/proc/${bridge.pid}/status`, 'utf8')).match(
          /^VmRSS:\s+(\d+)/m
        )?.[1] ?? 0
      ) * 1024
    )
  } catch {
    return 0
  }
}
try {
  const started = performance.now()
  while (
    spawnSync(resolve(binaries, 'uc'), ['daemon', 'status'], {
      env,
      timeout: 2000,
      stdio: 'ignore',
    }).status !== 0
  ) {
    assert(performance.now() - started < 15_000, 'isolated daemon starts')
    await pause(100)
  }
  bridge = spawn(
    resolve(server, 'bridge/target/debug/aixand-terminal-bridge'),
    [],
    { env, stdio: ['pipe', 'pipe', 'ignore'] }
  )
  let ready = false
  const lines = createInterface({ input: bridge.stdout })
  lines.on('line', (line) => {
    const event = JSON.parse(line)
    if (event.type === 'ready') ready = true
    if (event.type === 'backend-state' && event.phase !== 'connected')
      backendResets++
    if (event.type === 'stream-error' && !blocked.has(event.stream))
      streamErrors.push(event.message)
    const waiter = pending.get(event.id)
    if (waiter) {
      clearTimeout(waiter.timer)
      pending.delete(event.id)
      if (event.type === 'error')
        waiter.reject(
          new Error(`${event.operation}: ${event.code}: ${event.message}`)
        )
      else waiter.resolve(event.result)
    }
    if (event.type === 'output' || event.type === 'screen') {
      receivedBytes.set(
        event.stream,
        (receivedBytes.get(event.stream) ?? 0) +
          Buffer.from(event.data, 'base64').length
      )
      output.set(
        event.stream,
        (
          (output.get(event.stream) ?? '') +
          Buffer.from(event.data, 'base64').toString()
        ).slice(-4096)
      )
      if (event.type === 'screen') screens.add(event.stream)
      if (!blocked.has(event.stream))
        send('ack', { stream: event.stream, sequence: event.sequence })
    }
  })
  await until(() => ready, 'bridge starts')
  const panes = []
  for (let index = 0; index < 16; index++) {
    const { session } = await request('create', {
      name: `pressure-${index}`,
      columns: 80,
      rows: 24,
    })
    const paneId = randomUUID()
    const { stream } = await request('attach', {
      paneId,
      sessionId: session.id,
      offset: '0',
      screen: false,
    })
    panes.push({ paneId, session, stream })
  }
  blocked.add(panes[0].stream)
  const baselineRss = await rss()
  sampler = setInterval(() => {
    void rss().then((value) => {
      peakRss = Math.max(peakRss, value)
    })
  }, 200)
  await Promise.all(
    panes
      .slice(0, 15)
      .map((pane) =>
        request('input', {
          sessionId: pane.session.id,
          data: Buffer.from(
            `python3 -u -c "import os,time; [(os.write(1,b'x'*1023+b'\\n'),time.sleep(.01)) for _ in range(${Math.ceil(seconds * 120)})]"\n`
          ).toString('base64'),
        })
      )
  )
  const quiet = panes[15]
  const timings = []
  const end = performance.now() + seconds * 1000
  while (performance.now() < end) {
    const sample = timings.length
    const started = performance.now()
    await request('input', {
      sessionId: quiet.session.id,
      data: Buffer.from(`printf '\\n%s%s\\n' PRESSURE_ ${sample}\n`).toString(
        'base64'
      ),
    })
    await until(
      () => output.get(quiet.stream)?.includes(`PRESSURE_${sample}`),
      'quiet peer remains responsive',
      3000
    )
    timings.push(performance.now() - started)
    await pause(200)
  }
  await Promise.all(
    panes
      .slice(0, 15)
      .map((pane) =>
        request('input', {
          sessionId: pane.session.id,
          data: Buffer.from('\x03').toString('base64'),
        })
      )
  )
  const restored = await request('attach', {
    paneId: panes[0].paneId,
    sessionId: panes[0].session.id,
    offset: '0',
    screen: true,
  })
  await until(
    () => screens.has(restored.stream),
    'stalled pane restores its current screen'
  )
  for (const pane of panes) {
    const { summary } = await request('inspect', { sessionId: pane.session.id })
    assert.equal(summary.lifecycle.state, 'running')
    assert.equal(summary.started_at_millis, pane.session.started_at_millis)
    assert.equal(summary.restart_count, pane.session.restart_count)
  }
  timings.sort((a, b) => a - b)
  const p95 = timings[Math.ceil(timings.length * 0.95) - 1]
  assert(p95 < 1000, `interactive p95 ${p95} ms exceeds 1 second under load`)
  assert(
    peakRss < baselineRss + 64 * 1024 * 1024,
    'bridge memory stays within its bounded delivery budget'
  )
  assert.equal(
    backendResets,
    0,
    'one blocked consumer must not reset the shared backend'
  )
  assert.deepEqual(streamErrors, [], 'peer output subscriptions remain healthy')
  for (const pane of panes.slice(1, 15))
    assert(
      (receivedBytes.get(pane.stream) ?? 0) > 64 * 1024,
      'each output producer was exercised'
    )
  console.log(
    `PASS: 16 real panes, ${seconds}s output pressure, stalled consumer recovery, ${timings.length} interactive probes; p95 ${Math.round(p95)} ms; bridge RSS ${Math.round(baselineRss / 1048576)} -> peak ${Math.round(peakRss / 1048576)} MiB; no SDK resets or session restarts.`
  )
} finally {
  clearInterval(sampler)
  for (const item of pending.values()) clearTimeout(item.timer)
  bridge?.stdin.end()
  bridge?.kill('SIGTERM')
  spawnSync(resolve(binaries, 'uc'), ['stop', '--all', '--force'], {
    env,
    timeout: 15_000,
    stdio: 'ignore',
  })
  spawnSync(resolve(binaries, 'uc'), ['daemon', 'stop'], {
    env,
    timeout: 15_000,
    stdio: 'ignore',
  })
  daemon.kill('SIGTERM')
  await rm(work, { recursive: true, force: true })
}
