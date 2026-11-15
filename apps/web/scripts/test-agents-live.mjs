// Real browser → Nest → Python SDK → isolated Undercurrent. No model calls.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { buildTestServer, testAuthEnvironment, authenticateTestPage } from './isolated-test-server.mjs'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = resolve(web, '../server')
const binaries =
  process.env.UNDERCURRENT_BIN_DIR ??
  resolve(web, '../../../undercurrent/target/debug')
const work = await mkdtemp(resolve(tmpdir(), 'aixand-agents-live-'))
const python = process.env.AGENTS_TEST_PYTHON ?? 'python3'
const env = {
  ...process.env,
  PATH: `${binaries}${delimiter}${process.env.PATH}`,
  PYTHONPATH: [
    resolve(web, '../../../manager-suites/agent-manager'),
    resolve(web, '../../../undercurrent/python/src'),
    ...['mcp-manager', 'server-manager', 'prompt-manager', 'skill-manager', 'resource-sources'].map(name => resolve(web, '../../../manager-suites', name, 'src')),
  ].join(delimiter),
  UNDERCURRENT_HOME: resolve(work, 'undercurrent'),
  UNDERCURRENT_PYTHON_BRIDGE: resolve(binaries, 'uc-python-bridge'),
}
const fixture = JSON.parse(
  execFileSync(
    python,
    [resolve(server, 'agent-bridge/tests/fixture.py'), work],
    { env, encoding: 'utf8' },
  ),
)
Object.assign(env, {
  ...fixture.environment,
  AGENTS_PYTHON: python,
  AGENTS_MANAGER_SOURCE: resolve(web, '../../../manager-suites/agent-manager'),
  AGENTS_RUNTIME_SOURCE: resolve(web, '../../../undercurrent/python/src'),
  AGENT_MANAGER_HOME: fixture.home,
  AGENT_MANAGER_CONFIG: fixture.config,
  AGENTS_CWD: work,
  AGENTS_STATE_DIR: resolve(work, 'chats'),
  AGENTS_SCRATCH_DIR: resolve(work, 'scratch'),
  TERMINAL_CWD: work,
  WORKFLOW_SDK_CONFIG: '',
  CARRIER_AUTO_PROVISION: '0',
  CARRIER_URL: 'http://127.0.0.1:1',
  CARRIER_STATE_DIR: resolve(work, 'carrier-suite'),
  CARRIER_STATE_DATABASE: resolve(work, 'carrier-suite/suite.db'),
  CARRIER_DATABASE: resolve(work, 'carrier.db'),
  CARRIER_USER_CREDENTIALS: resolve(work, 'carrier-user.json'),
  CARRIER_MAILBOXES_FILE: '',
  CARRIER_AGENT_CONFIG: '',
})
const children = []
const logs = []
let browser
let page
let backend
const backendMain = buildTestServer(server, work)
let failure = false
function start(command, args, cwd, extra = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...env, ...testAuthEnvironment(), ...extra },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-4000)
    })
  child.on('error', (error) => {
    output += error.message
  })
  children.push(child)
  logs.push(() => output)
  return child
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise((resolveDone) => child.once('exit', resolveDone))
  child.kill('SIGTERM')
  const kill = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }, 12_000)
  await done
  clearTimeout(kill)
}
async function port() {
  const socket = createServer()
  await new Promise((resolveReady) =>
    socket.listen(0, '127.0.0.1', resolveReady),
  )
  const value = socket.address().port
  await new Promise((resolveClosed) => socket.close(resolveClosed))
  return value
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
      { timeout: 20_000 },
    )
    .toBe(true)
}
function inspect() {
  return JSON.parse(
    execFileSync(
      python,
      [
        '-c',
        `import asyncio,json,agent_manager,undercurrent
async def main():
    async with undercurrent.Client() as runtime:
        client=agent_manager.Client('codex',runtime=runtime)
        runs=await client.runs()
        sessions=await runtime.list()
        print(json.dumps({'runs':runs,'sessions':[{'id':s.id,'lifecycle':s.lifecycle} for s in sessions]}))
asyncio.run(main())`,
      ],
      { env, encoding: 'utf8', timeout: 10_000 },
    ),
  )
}
async function stopInTerminals(page, sessionId) {
  const pane = page.locator(`.terminal-live[data-session-id="${sessionId}"]`)
  await expect(pane).toBeVisible()
  await pane.getByRole('button', { name: /^Terminal actions for / }).click()
  await page.getByRole('menuitem', { name: 'Stop gracefully', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(pane.locator('.tile-state')).toHaveText('stopped', { timeout: 20_000 })
  await page.keyboard.press('Escape')
}
try {
  const apiPort = await port(),
    webPort = await port()
  const origin = `http://127.0.0.1:${webPort}`
  start(resolve(binaries, 'uc-daemon'), [], work)
  await expect
    .poll(
      () =>
        spawnSync(resolve(binaries, 'uc'), ['daemon', 'status'], {
          env,
          timeout: 2000,
        }).status,
      { timeout: 20_000 },
    )
    .toBe(0)
  const launchBackend = () =>
    start(process.execPath, [backendMain], server, {
      HOST: '127.0.0.1',
      PORT: String(apiPort),
      CORS_ORIGINS: origin,
    })
  backend = launchBackend()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  start(
    process.execPath,
    [
      'scripts/test-vite-live.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      String(webPort),
      '--strictPort',
    ],
    web,
    { AIXAND_SERVER_URL: `http://127.0.0.1:${apiPort}` },
  )
  await ready(origin)
  browser = await chromium.launch({ env })
  page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await authenticateTestPage(page, `${origin}/#/agents/profiles`)
  await page.goto(`${origin}/#/agents/profiles`)
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  const profile = page.getByRole('region', { name: 'Codex work', exact: true })
  await profile.getByRole('button', { name: 'Open terminal', exact: true }).click()
  const launch = page.getByRole('region', { name: 'Open terminal', exact: true })
  await launch.getByLabel('Project directory').fill(work)
  await launch.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await expect.poll(() => inspect().runs.filter(value => value.active).length).toBe(1)
  const run = inspect().runs.find(value => value.active)
  expect(run.environment_id).toBe(fixture.profiles.work.environment_id)
  expect(run.profile_id).toBe(fixture.profiles.work.profile_id)
  expect(inspect().sessions).toHaveLength(1)
  await expect(page.locator(`.terminal-live[data-session-id="${run.session_id}"]`)).toBeVisible()
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('OFFLINE_AGENT_READY')
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('browser-agent-check')
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('OFFLINE_REPLY: browser-agent-check')
  await stop(backend)
  backend = launchBackend()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  await page.reload()
  await expect(page.locator(`.terminal-live[data-session-id="${run.session_id}"]`)).toBeVisible()
  expect(inspect().runs.filter(value => value.active).map(value => value.run_id)).toEqual([run.run_id])
  expect(inspect().sessions).toHaveLength(1)
  await stopInTerminals(page, run.session_id)
  await expect.poll(() => inspect().runs.find(value => value.run_id === run.run_id)?.active).toBe(false)
  expect(errors).toEqual([])
  console.log('Native terminal integration passed: captured environment/profile identity, input, backend restart, exact session recovery and explicit stop.')
} catch (error) {
  failure = true
  console.error(error)
  if (page) console.error('Browser state:', await page.locator('body').innerText().catch(() => ''))
  for (const log of logs) console.error(log())
} finally {
  await browser?.close()
  spawnSync(resolve(binaries, 'uc'), ['stop', '--all', '--force'], {
    env,
    timeout: 10_000,
    stdio: 'ignore',
  })
  spawnSync(resolve(binaries, 'uc'), ['daemon', 'stop'], {
    env,
    timeout: 10_000,
    stdio: 'ignore',
  })
  for (const child of children.reverse()) await stop(child)
  await rm(work, { recursive: true, force: true })
}
if (failure) process.exitCode = 1
