import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildTestServer, testAuthEnvironment, authenticateTestPage } from './isolated-test-server.mjs'
// Opt-in: two real managed agents through the existing SDK-enabled Runner.
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = resolve(web, '../server')
const authWork = mkdtempSync(resolve(tmpdir(), 'aixand-workflow-auth-'))
const backendMain = buildTestServer(server, authWork)
const token = randomBytes(32).toString('hex')
const children = []
const requests = new Map()
const events = new Map()
const terminalRequests = []
let browser, page, submitted, jobId, final
async function port() {
  const socket = createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const number = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return number
}
function start(args, cwd, env) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env, ...testAuthEnvironment() },
    detached: true,
    stdio: 'ignore',
  })
  children.push(child)
}
async function ready(url) {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(url)).ok
        } catch {
          return false
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true)
}
const backendPort = await port(),
  webPort = await port()
try {
  start([backendMain], server, {
    HOST: '127.0.0.1',
    PORT: String(backendPort),
    CORS_ORIGINS: `http://127.0.0.1:${webPort}`,
  })
  start(
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(webPort),
      '--strictPort',
    ],
    web,
    { AIXAND_SERVER_URL: `http://127.0.0.1:${backendPort}` },
  )
  await Promise.all([
    ready(`http://127.0.0.1:${backendPort}/api/health`),
    ready(`http://127.0.0.1:${webPort}`),
  ])
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.on('websocket', (socket) => {
    if (socket.url().includes('/api/terminals/ws')) {
      socket.on('framesent', (frame) => {
        const message = JSON.parse(String(frame.payload))
        if (message.op !== 'auth') terminalRequests.push(message)
      })
    }
    if (!socket.url().includes('/api/workflow-jobs/ws')) return
    socket.on('framesent', (frame) => {
      const message = JSON.parse(String(frame.payload))
      if (message.op === 'auth') return
      requests.set(message.id, message.op)
      if (message.op === 'submit') submitted = message.args.submission
    })
    socket.on('framereceived', (frame) => {
      const message = JSON.parse(String(frame.payload))
      if (message.type === 'error') console.error(message.message)
      if (message.type !== 'result') return
      if (requests.get(message.id) === 'submit') jobId = message.result.job.id
      if (requests.get(message.id) === 'events')
        for (const event of message.result.events) {
          if (events.has(event.sequence)) continue
          events.set(event.sequence, event)
          console.log(JSON.stringify(event))
        }
      if (requests.get(message.id) === 'result') final = message.result
    })
  })
  await authenticateTestPage(page, `http://127.0.0.1:${webPort}/#/workflows/sequential-hello`)
  await page.goto(`http://127.0.0.1:${webPort}/#/workflows/sequential-hello`)
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled()
  await page.getByRole('button', { name: 'Start run' }).click()
  await expect.poll(() => jobId, { timeout: 30_000 }).toBeTruthy()
  const acceptedId = jobId
  await expect.poll(() => [...events.values()].some((entry) =>
    entry.data.event === 'agent_session' && entry.data.invocation === 'op_1',
  ), { timeout: 300_000 }).toBe(true)
  await page.locator('[data-id="send-x"]').click()
  await expect(page.getByRole('dialog')).toContainText('Following terminal output', { timeout: 30_000 })
  await expect(page.getByRole('dialog')).toContainText(/\bHi[!.]?/, { timeout: 300_000 })
  await page.getByRole('button', { name: 'Close terminal preview', exact: true }).click()
  // Recover the retained job after losing the browser connection.
  await page.reload()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  await expect.poll(() => final, { timeout: 660_000 }).toBeTruthy()
  const artifact = resolve(web, 'artifacts/workflow-sequence-live')
  await mkdir(artifact, { recursive: true })
  await writeFile(
    resolve(artifact, 'run.json'),
    JSON.stringify(
      {
        submitted,
        events: [...events.values()].sort((a, b) => a.sequence - b.sequence),
        result: final,
      },
      null,
      2,
    ),
  )
  expect(final.id).toBe(acceptedId)
  expect(final.state, JSON.stringify(final.error)).toBe('completed')
  expect(
    [...events.values()]
      .filter(
        (event) => event.kind === 'ir' && event.data.event === 'published',
      )
      .map((event) => event.data.invocation),
  ).toEqual(Array.from({ length: 9 }, (_, index) => `op_${index + 1}`))
  expect(final.result.spawn_1_run_id).not.toBe(final.result.spawn_2_run_id)
  expect(final.result.wait_1_observation.session_id).not.toBe(
    final.result.wait_2_observation.session_id,
  )
  await expect(
    page.getByRole('heading', { name: 'Workflow completed', exact: true }),
  ).toBeVisible()
  await expect(
    page.locator('.wb-run-steps [data-status="completed"]'),
  ).toHaveCount(7)
  await page.screenshot({ path: resolve(artifact, 'completed.png') })
  await page.locator('[data-id="wait-y"]').click()
  await expect(page.getByRole('dialog')).toContainText(/\bHi[!.]?/, { timeout: 30_000 })
  await page.screenshot({ path: resolve(artifact, 'terminal-preview.png') })
  await page.getByRole('button', { name: 'Close terminal preview', exact: true }).click()
  const identities = [...events.values()].filter((entry) => entry.data.event === 'agent_session').map((entry) => entry.data)
  expect(identities).toHaveLength(2)
  expect(terminalRequests.filter((entry) => entry.op === 'attach').map((entry) => entry.args.sessionId))
    .toEqual(identities.map((entry) => entry.session_id))
  expect(terminalRequests.filter((entry) => ['input', 'resize'].includes(entry.op))).toEqual([])
  await writeFile(resolve(artifact, 'terminal-previews.json'), JSON.stringify({ identities, terminalRequests }, null, 2))
  execFileSync(
    process.env.WORKFLOW_TEST_PYTHON ??
      resolve(web, '../../workflow/ir/.venv/bin/python'),
    [
      resolve(web, 'scripts/inspect-workflow-sequence.py'),
      artifact,
      ...(process.env.WORKFLOW_RUNTIME_HOME
        ? ['--runtime-home', process.env.WORKFLOW_RUNTIME_HOME]
        : []),
    ],
    { stdio: 'inherit' },
  )
  console.log(
    `Sequential workflow completed: ${final.id}. Evidence: ${artifact}`,
  )
} finally {
  rmSync(authWork, { recursive: true, force: true })
  if (page && jobId && !final) {
    await page.keyboard.press('Escape').catch(() => {})
    await page
      .getByRole('button', { name: 'Cancel run', exact: true })
      .click()
      .catch(() => {})
    await expect
      .poll(() => !!final, { timeout: 30_000 })
      .toBe(true)
      .catch(() =>
        console.error(
          `Inspect Runner job ${jobId}; cancellation completion is unconfirmed.`,
        ),
      )
  }
  await browser?.close()
  for (const child of children.reverse()) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
  }
}
