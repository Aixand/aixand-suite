import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildTestServer, testAuthEnvironment, authenticateTestPage } from './isolated-test-server.mjs'
// Exercise optional Carrier consultations through the SDK-enabled Runner.
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = resolve(web, '../aixand-server')
const authWork = mkdtempSync(resolve(tmpdir(), 'aixand-workflow-auth-'))
const backendMain = buildTestServer(server, authWork)
const token = randomBytes(32).toString('hex')
const scenarios = {
  independent: 'Say hi. Reply with exactly "Hi." Complete this yourself without consulting any tools.',
  once: 'Ask Brain once for a short greeting, wait for its answer, and return that greeting. Make exactly one consultation.',
  multiple: 'Ask Brain for a short greeting, wait for its answer, then ask Brain a separate follow-up question for a short sign-off. Wait for that answer and return the greeting and sign-off together. Make exactly two consultations, one at a time.',
}
const scenario = process.env.WORKFLOW_BRAIN_SCENARIO ?? 'independent'
if (!scenarios[scenario]) throw new Error(`Unknown scenario: ${scenario}`)
const artifact = resolve(web, `artifacts/workflow-brain-optional/${scenario}`)
const children = [], events = new Map(), requests = new Map(), terminalRequests = []
let browser, page, submitted, jobId, final
async function port() {
  const socket = createServer()
  await new Promise((done) => socket.listen(0, '127.0.0.1', done))
  const value = socket.address().port
  await new Promise((done) => socket.close(done))
  return value
}
function start(args, cwd, env) {
  children.push(spawn(process.execPath, args, { cwd, env: { ...process.env, ...env, ...testAuthEnvironment() }, detached: true, stdio: 'ignore' }))
}
async function ready(url) {
  await expect.poll(async () => { try { return (await fetch(url)).ok } catch { return false } }, { timeout: 30_000 }).toBe(true)
}
const backendPort = await port(), webPort = await port()
try {
  await mkdir(artifact, { recursive: true })
  start([backendMain], server, { HOST: '127.0.0.1', PORT: String(backendPort),
    CORS_ORIGINS: `http://127.0.0.1:${webPort}` })
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], web,
    { AIXAND_SERVER_URL: `http://127.0.0.1:${backendPort}` })
  await Promise.all([ready(`http://127.0.0.1:${backendPort}/api/health`), ready(`http://127.0.0.1:${webPort}`)])
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.on('websocket', (socket) => {
    if (socket.url().includes('/api/terminals/ws')) socket.on('framesent', (frame) => {
      const message = JSON.parse(String(frame.payload))
      if (message.op !== 'auth') terminalRequests.push(message)
    })
    if (!socket.url().includes('/api/workflow-jobs/ws')) return
    socket.on('framesent', (frame) => {
      const message = JSON.parse(String(frame.payload))
      if (message.op === 'auth') return
      requests.set(message.id, message.op)
      if (message.op === 'submit') submitted = message.args.submission
    })
    socket.on('framereceived', (frame) => {
      const message = JSON.parse(String(frame.payload))
      if (message.type === 'error') console.error(message.code, message.message)
      if (message.type !== 'result') return
      if (requests.get(message.id) === 'submit') jobId = message.result.job.id
      if (requests.get(message.id) === 'events') for (const entry of message.result.events) {
        if (!events.has(entry.sequence)) {
          events.set(entry.sequence, entry)
          if (typeof entry.data.event === 'string') console.log(entry.data.event, entry.data.invocation ?? '')
        }
      }
      if (requests.get(message.id) === 'result') final = message.result
    })
  })
  await authenticateTestPage(page, `http://127.0.0.1:${webPort}/#/workflows`)
  await page.goto(`http://127.0.0.1:${webPort}/#/workflows`)
  await expect(page.getByRole('button', { name: 'Open Sequential hello', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open Brain and Implementer', exact: true }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(4)
  await page.locator('[data-id="task"]').click()
  await page.getByLabel('Task', { exact: true }).fill(scenarios[scenario])
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Start run' }).click()
  await expect.poll(() => jobId, { timeout: 30_000 }).toBeTruthy()
  const accepted = jobId
  await writeFile(resolve(artifact, 'submission.json'), JSON.stringify({ jobId, submitted }, null, 2))
  await expect.poll(() => [...events.values()].some((entry) => entry.data.event === 'agent_session' && entry.data.invocation === 'op_3') || final,
    { timeout: 660_000 }).toBeTruthy()
  if (final && final.state !== 'completed') throw new Error(JSON.stringify(final.error))
  await page.locator('[data-id="task"]').click()
  await expect(page.getByRole('dialog')).toContainText('Following terminal output', { timeout: 30_000 })
  await page.screenshot({ path: resolve(artifact, 'live-preview.png') })
  await page.keyboard.press('Escape')
  await page.reload()
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await expect(page.getByText('Connected to Runner', { exact: true })).toBeVisible()
  await expect.poll(() => final, { timeout: 660_000 }).toBeTruthy()
  await writeFile(resolve(artifact, 'run.json'), JSON.stringify({ submitted,
    events: [...events.values()].sort((a, b) => a.sequence - b.sequence), result: final }, null, 2))
  expect(final.id).toBe(accepted)
  expect(final.state, JSON.stringify(final.error)).toBe('completed')
  expect(final.result.final_reply.reply_to).toBe(final.result.message_1_request.id)
  expect(final.result.final_reply.sender).toBe(submitted.workflow.workflow.body.steps[2].inputs.address.value)
  expect(final.result.final_reply.recipient).toBe(submitted.workflow.workflow.body.steps[3].inputs.address.value)
  expect(final.result.final_reply_text.trim()).not.toBe('')
  expect([...events.values()].filter((entry) => entry.data.event === 'published').map((entry) => entry.data.invocation))
    .toEqual(Array.from({ length: 10 }, (_, index) => `op_${index + 1}`))
  await expect(page.locator('.wb-final-reply')).toContainText(final.result.final_reply_text)
  await expect(page.locator('.wb-run-steps [data-status="completed"]')).toHaveCount(3)
  await expect(page.getByRole('list', { name: 'Optional tools' })).toContainText('closed')
  await page.screenshot({ path: resolve(artifact, 'completed.png') })
  await page.locator('[data-id="result"]').click()
  await expect(page.getByRole('dialog')).toContainText('Following terminal output', { timeout: 30_000 })
  await page.screenshot({ path: resolve(artifact, 'retained-preview.png') })
  await page.keyboard.press('Escape')
  const identities = [...events.values()].filter((entry) => entry.data.event === 'agent_session').map((entry) => entry.data)
  expect(identities).toHaveLength(2)
  expect(terminalRequests.filter((entry) => entry.op === 'attach').every((entry) => entry.args.sessionId === identities[1].session_id)).toBe(true)
  expect(terminalRequests.filter((entry) => ['input', 'resize', 'stop', 'cancel'].includes(entry.op))).toEqual([])
  await writeFile(resolve(artifact, 'terminal-previews.json'), JSON.stringify({ identities, terminalRequests }, null, 2))
  execFileSync(process.env.WORKFLOW_TEST_PYTHON ?? resolve(web, '../aixand-ir/.venv/bin/python'),
    [resolve(web, 'scripts/inspect-workflow-brain.py'), artifact, '--consultations',
      String({ independent: 0, once: 1, multiple: 2 }[scenario]),
      ...(process.env.WORKFLOW_RUNTIME_HOME ? ['--runtime-home', process.env.WORKFLOW_RUNTIME_HOME] : []),
      ...(process.env.WORKFLOW_SDK_STATE ? ['--state-dir', process.env.WORKFLOW_SDK_STATE] : [])], { stdio: 'inherit' })
  console.log(`${scenario} completed: ${final.id}. Final reply: ${final.result.final_reply_text}`)
} finally {
  rmSync(authWork, { recursive: true, force: true })
  if (page && jobId && !final) {
    await page.keyboard.press('Escape').catch(() => {})
    await page.getByRole('button', { name: 'Cancel run', exact: true }).click().catch(() => {})
    await expect.poll(() => !!final, { timeout: 30_000 }).toBe(true)
      .catch(() => console.error(`Inspect Runner job ${jobId}; cleanup is unconfirmed.`))
  }
  await browser?.close()
  for (const child of children.reverse()) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
}
