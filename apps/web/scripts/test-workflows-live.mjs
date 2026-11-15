import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildTestServer, testAuthEnvironment, authenticateTestPage } from './isolated-test-server.mjs'
// Opt-in: launches and stops a real Codex agent using the existing backup profile.
// Agent authentication and the Undercurrent daemon must already be configured.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = resolve(web, '../server')
const authWork = mkdtempSync(resolve(tmpdir(), 'aixand-workflow-auth-'))
const backendMain = buildTestServer(server, authWork)
const ir = resolve(web, '../../workflow/ir')
const bridge =
  process.env.WORKFLOW_BRIDGE_PATH ??
  resolve(server, 'workflow-bridge/target/debug/aixand-workflow-bridge')
const config =
  process.env.WORKFLOW_SDK_CONFIG ??
  resolve(ir, 'examples/real-agent/runtime.example.json')
await access(bridge)
await access(config)
const token = randomBytes(32).toString('hex')
const children = []
const events = []
let browser, page, submitted, final
async function port() {
  const socket = createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const number = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return number
}
function start(command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env, ...testAuthEnvironment() },
    detached: true,
    stdio: 'ignore',
  })
  children.push(child)
  child.on('error', (error) => console.error(error.message))
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
      { timeout: 30_000 }
    )
    .toBe(true)
}
const backendPort = await port(),
  webPort = await port()
try {
  start(process.execPath, [backendMain], server, {
    HOST: '127.0.0.1',
    PORT: String(backendPort),
    CORS_ORIGINS: `http://127.0.0.1:${webPort}`,
    WORKFLOW_BRIDGE_PATH: bridge,
    WORKFLOW_SDK_CONFIG: config,
    WORKFLOW_PYTHON_BIN:
      process.env.WORKFLOW_PYTHON_BIN ?? resolve(ir, '.venv/bin'),
    WORKFLOW_CWD: ir,
    WORKFLOW_CATALOG_PATHS: '',
  })
  start(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(webPort),
      '--strictPort',
    ],
    web,
    {
      AIXAND_SERVER_URL: `http://127.0.0.1:${backendPort}`,
    }
  )
  await Promise.all([
    ready(`http://127.0.0.1:${backendPort}/api/health`),
    ready(`http://127.0.0.1:${webPort}`),
  ])
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/api/workflows/ws')) return
    socket.on('framesent', (frame) => {
      const message = JSON.parse(String(frame.payload))
      if (message.op === 'run') submitted = message.args
    })
    socket.on('framereceived', (frame) => {
      const message = JSON.parse(String(frame.payload))
      if (message.type === 'run-event') {
        events.push(message.event)
        console.log(JSON.stringify(message.event))
      }
      if (message.type === 'run-result' || message.type === 'run-failure')
        final = message
    })
  })
  await authenticateTestPage(page, `http://127.0.0.1:${webPort}/#/workflows`)
  await page.goto(`http://127.0.0.1:${webPort}/#/workflows`)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Load compiled example' }).click()
  await expect(
    page.getByRole('region', { name: 'Workflow validation' })
  ).toContainText('Valid Aixand IR v0.1')
  const inputs = JSON.parse(
    await readFile(resolve(ir, 'examples/real-agent/inputs.json'), 'utf8')
  )
  const run = page.getByRole('region', { name: 'Workflow execution' })
  await run.getByLabel('Provide task', { exact: true }).check()
  await run.getByLabel('Run task', { exact: true }).fill(inputs.task)
  await run.getByRole('button', { name: 'Run Workflow', exact: true }).click()
  await expect.poll(() => final?.type, { timeout: 360_000 }).toBeTruthy()
  const artifact = resolve(web, 'artifacts/workflows-live')
  await mkdir(artifact, { recursive: true })
  await writeFile(
    resolve(artifact, 'run.json'),
    JSON.stringify(
      {
        workflow: JSON.parse(submitted.source),
        inputs: submitted.inputs,
        events,
        result: final,
      },
      null,
      2
    )
  )
  expect(final.type, JSON.stringify(final.failure)).toBe('run-result')
  expect(JSON.parse(submitted.source)).toEqual(
    JSON.parse(
      await readFile(
        resolve(ir, 'examples/python/managed_codex_two_turns.json'),
        'utf8'
      )
    )
  )
  expect(
    events
      .filter((event) => event.event === 'published')
      .map((event) => event.invocation)
  ).toEqual(['spawn_1', 'send_1', 'wait_1', 'send_2', 'wait_2', 'stop_1'])
  await expect(
    run.getByRole('heading', { name: 'Workflow completed', exact: true })
  ).toBeVisible()
  expect(
    JSON.parse(await run.getByLabel('Workflow run outputs').textContent())
  ).toEqual(final.outputs)
  await run.scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(artifact, 'completed.png') })
  console.log(
    `Browser workflow completed: ${final.outputs.run_id}. Evidence: ${artifact}`
  )
} finally {
  rmSync(authWork, { recursive: true, force: true })
  if (page && submitted && !final) {
    await page
      .getByRole('button', { name: 'Cancel run', exact: true })
      .click()
      .catch(() => {})
    await expect
      .poll(() => !!final, { timeout: 30_000 })
      .toBe(true)
      .catch(() =>
        console.error(
          'Cancellation completion unconfirmed; inspect the managed run before retrying.'
        )
      )
  }
  await browser?.close()
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
        resolve()
      }, 35_000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
}
