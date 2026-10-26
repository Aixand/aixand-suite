// Real browser → Nest → Python SDK → isolated Undercurrent. No model calls.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { buildTestServer, testAuthEnvironment, authenticateTestPage } from './isolated-test-server.mjs'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = resolve(web, '../aixand-server')
const binaries =
  process.env.UNDERCURRENT_BIN_DIR ??
  resolve(web, '../../undercurrent/target/debug')
const work = await mkdtemp(resolve(tmpdir(), 'aixand-agents-live-'))
const token = randomBytes(32).toString('hex')
const python = process.env.AGENTS_TEST_PYTHON ?? 'python3'
const env = {
  ...process.env,
  PATH: `${binaries}${delimiter}${process.env.PATH}`,
  PYTHONPATH: [
    resolve(web, '../../manager-suites/agent-manager'),
    resolve(web, '../../undercurrent/python/src'),
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
  AGENTS_PYTHON: python,
  AGENTS_MANAGER_SOURCE: resolve(web, '../../manager-suites/agent-manager'),
  AGENTS_RUNTIME_SOURCE: resolve(web, '../../undercurrent/python/src'),
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
function credentialsMatch(profile, auth) {
  return JSON.parse(
    execFileSync(
      python,
      [
        '-c',
        'import json,sys,agent_manager; m=agent_manager.Manager("codex"); print(json.dumps(m.read_auth(m.home(sys.argv[1])) == m.read_auth(m.auth_home(sys.argv[2]))))',
        profile,
        auth,
      ],
      { env, encoding: 'utf8', timeout: 10_000 },
    ),
  )
}
async function stopInTerminals(page, sessionId) {
  const pane = page.locator(`.terminal-live[data-session-id="${sessionId}"]`)
  await expect(pane).toBeVisible()
  await pane.getByRole('button', { name: /^Terminal actions for / }).click()
  const dialog = page.getByRole('dialog', { name: /^Terminal actions · / })
  await dialog.getByRole('button', { name: 'Stop gracefully', exact: true }).click()
  await dialog.getByRole('button', { name: 'Confirm stop gracefully', exact: true }).click()
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
      'node_modules/vite/bin/vite.js',
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
  browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket
    window.WebSocket = class extends NativeSocket {
      send(value) {
        super.send(value)
        try {
          if (window.dropNextAgentLaunch && JSON.parse(value).op === 'session-start') {
            window.dropNextAgentLaunch = false
            setTimeout(() => this.close(), 0)
          }
        } catch {}
      }
    }
  })
  await authenticateTestPage(page, `${origin}/#/agents/profiles`)
  await page.goto(`${origin}/#/agents/profiles`)
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  let card = page.getByRole('article', { name: 'Agent details' })
  await card.getByRole('button', { name: 'Start session', exact: true }).click()
  await page.getByLabel('Project directory').fill(work)
  await page.getByRole('button', { name: 'Start session', exact: true }).click()
  await expect.poll(() => inspect().runs.filter((value) => value.active).length).toBe(1)
  const first = inspect()
  const run = first.runs.find((value) => value.profile === 'work')
  expect(first.sessions).toHaveLength(1)
  await expect(
    page.locator(`.terminal-live[data-session-id="${run.session_id}"]`),
  ).toBeVisible()
  await expect(page.locator('.xterm-accessibility-tree')).toContainText(
    'OFFLINE_AGENT_READY',
    { timeout: 15_000 },
  )
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('browser-agent-check')
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-accessibility-tree')).toContainText(
    'OFFLINE_REPLY: browser-agent-check',
  )
  expect(inspect().sessions).toHaveLength(1)

  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Agents', exact: true })
    .click()
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  card = page.getByRole('article', { name: 'Agent details' })
  await card.getByRole('button', { name: 'Actions for work', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit profile', exact: true }).click()
  await page.getByRole('button', { name: /Saved login$/ }).click()
  await page.getByRole('option', { name: 'company', exact: true }).click()
  await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  await expect(card).toContainText('company')
  expect(credentialsMatch('work', 'personal')).toBe(true)
  expect(credentialsMatch('work', 'company')).toBe(false)
  await card.getByRole('button', { name: 'Start session', exact: true }).click()
  await page.getByRole('button', { name: 'Start session', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('previous auth')
  expect(inspect().sessions).toHaveLength(1)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Sessions', exact: true })).toHaveCount(0)
  expect(inspect().runs.find((value) => value.run_id === run.run_id).auth).toBe('personal')
  if (process.platform === 'linux') {
    const pids = (
      await readFile(
        `/proc/${backend.pid}/task/${backend.pid}/children`,
        'utf8',
      )
    )
      .trim()
      .split(/\s+/)
    for (const pid of pids) {
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8')
      if (command.includes(resolve(server, 'agent-bridge/main.py')))
        process.kill(Number(pid), 'SIGKILL')
    }
    await page
      .getByRole('button', { name: 'Refresh agents', exact: true })
      .click()
    await expect(card.getByRole('button', { name: '1 running · Open Terminals', exact: true })).toBeVisible({ timeout: 20_000 })
    expect(inspect().sessions).toHaveLength(1)
  }
  await stop(backend)
  backend = launchBackend()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  await expect(page.locator('.carrier-sidebar-footer .carrier-connection-status')).toHaveText('Connected', { timeout: 20_000 })
  await expect(card.getByRole('button', { name: '1 running · Open Terminals', exact: true })).toBeVisible({ timeout: 20_000 })
  expect(inspect().sessions).toHaveLength(1)
  await card.getByRole('button', { name: '1 running · Open Terminals', exact: true }).click()
  await stopInTerminals(page, run.session_id)
  await expect
    .poll(
      () => inspect().runs.find((value) => value.run_id === run.run_id)?.active,
      { timeout: 15_000 },
    )
    .toBe(false)
  // Lose the response to a second launch. Reconnection must discover it once.
  await page.getByRole('navigation').getByRole('link', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  card = page.getByRole('article', { name: 'Agent details' })
  await card.getByRole('button', { name: 'Start session', exact: true }).click()
  await page.evaluate(() => {
    window.dropNextAgentLaunch = true
  })
  await page.getByRole('button', { name: 'Start session', exact: true }).click()
  await expect(page.locator('.carrier-sidebar-footer .carrier-connection-status')).toHaveText('Connected', { timeout: 20_000 })
  await expect
    .poll(() => inspect().runs.filter((value) => value.active).length, {
      timeout: 15_000,
    })
    .toBe(1)
  const recovered = inspect().runs.find((value) => value.active)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(card.getByRole('button', { name: '1 running · Open Terminals', exact: true })).toBeVisible({ timeout: 20_000 })
  expect(recovered.auth).toBe('company')
  expect(credentialsMatch('work', 'company')).toBe(true)
  expect(credentialsMatch('work', 'personal')).toBe(false)
  expect(inspect().sessions).toHaveLength(2)
  const other = await browser.newPage()
  await authenticateTestPage(other, `${origin}/#/agents/profiles`)
  await other.goto(`${origin}/#/agents/profiles`)
  await other.getByRole('button', { name: 'work · Codex', exact: true }).click()
  await expect(other.getByRole('region', { name: 'Codex work', exact: true })
    .getByRole('button', { name: '1 running · Open Terminals', exact: true })).toBeVisible()
  expect(inspect().sessions).toHaveLength(2)
  await other.close()
  await card.getByRole('button', { name: '1 running · Open Terminals', exact: true }).click()
  await stopInTerminals(page, recovered.session_id)
  await expect
    .poll(() => inspect().runs.every((value) => !value.active), {
      timeout: 15_000,
    })
    .toBe(true)
  await page.getByRole('navigation').getByRole('link', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'review · Codex', exact: true }).click()
  const review = page.getByRole('region', { name: 'Codex review', exact: true })
  await review.getByRole('button', { name: 'Delete review', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'Delete review?', exact: true })
    .getByRole('button', { name: 'Delete profile', exact: true }).click()
  await expect(review).toHaveCount(0)
  await page.reload()
  await expect(review).toHaveCount(0)
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Codex work', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Sessions', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /^Saved logins/ }).click()
  await page.getByRole('button', { name: 'New login', exact: true }).click()
  let loginSheet = page.getByRole('region', { name: 'New saved login', exact: true })
  await loginSheet.getByRole('textbox', { name: 'Login name', exact: true }).fill('web-login')
  await loginSheet.getByRole('button', { name: 'Start sign-in', exact: true }).click()
  await expect(loginSheet.getByText('Sign-in completed.', { exact: true })).toBeVisible({ timeout: 20_000 })
  await loginSheet.getByRole('button', { name: 'Close', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: /^Saved logins/ }).click()
  await page.getByRole('button', { name: 'web-login', exact: true }).click()
  loginSheet = page.getByRole('region', { name: 'web-login', exact: true })
  await loginSheet.getByRole('button', { name: 'Sign in again', exact: true }).click()
  await expect(loginSheet.getByText('Sign-in completed.', { exact: true })).toBeVisible({ timeout: 20_000 })
  await loginSheet.getByRole('button', { name: 'Check login', exact: true }).click()
  await expect(loginSheet.getByText('Login checked.', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(loginSheet).toContainText('Account access verified', { timeout: 10_000 })
  await loginSheet.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'web-login', exact: true }).click()
  await page.getByRole('button', { name: 'Manage saved login', exact: true }).click()
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await page.getByRole('textbox', { name: 'Login name', exact: true }).fill('web-renamed')
  await page.getByRole('button', { name: 'Save name', exact: true }).click()
  await page.getByRole('button', { name: 'web-renamed', exact: true }).click()
  await page.getByRole('button', { name: 'Manage saved login', exact: true }).click()
  await page.getByRole('button', { name: 'Remove saved login', exact: true }).click()
  await page.getByRole('region', { name: 'Remove web-renamed?', exact: true }).getByRole('button', { name: 'Remove saved login', exact: true }).click()
  await expect(page.getByRole('button', { name: 'web-renamed', exact: true })).toHaveCount(0)
  // Native import is prepared only in the disposable fixture home.
  execFileSync(python, ['-c', 'import agent_manager; m=agent_manager.Manager("codex"); m.copy_auth(m.auth_home("personal"),m.native)'], { env })
  await page.getByRole('button', { name: 'Import local login', exact: true }).click()
  const importSheet = page.getByRole('region', { name: 'Import local login', exact: true })
  await importSheet.getByRole('textbox', { name: 'Login name', exact: true }).fill('web-imported')
  await importSheet.getByRole('button', { name: 'Import login', exact: true }).click()
  await expect(importSheet.getByText('Login imported.', { exact: true })).toBeVisible({ timeout: 20_000 })
  await importSheet.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: /^Providers/ }).click()
  await page.getByRole('button', { name: 'Codex', exact: true }).click()
  const provider = page.getByRole('region', { name: 'Installation details Codex', exact: true })
  await expect(provider).toContainText('1.2.3', { timeout: 20_000 })
  await expect(provider.getByRole('button', { name: 'Update', exact: true })).toBeDisabled()
  await provider.getByRole('button', { name: 'Check setup', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Check setup Codex', exact: true })).toContainText('Terminal connection', { timeout: 20_000 })
  await page.getByRole('region', { name: 'Check setup Codex', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: /^Profiles/ }).click()
  await page.getByRole('button', { name: 'work · Codex', exact: true }).click()
  await card.getByRole('button', { name: 'Actions for work', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Duplicate profile', exact: true }).click()
  await page.getByRole('button', { name: 'Duplicate profile', exact: true }).click()
  await page.getByRole('button', { name: 'work-copy · Codex', exact: true }).click()
  const copied = page.getByRole('region', { name: 'Codex work-copy', exact: true })
  await expect(copied).toBeVisible()
  await page.getByRole('button', { name: 'Actions for work-copy', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename profile', exact: true }).click()
  await page.getByRole('textbox', { name: 'Profile name', exact: true }).fill('web-copy')
  await page.getByRole('button', { name: 'Save name', exact: true }).click()
  await page.getByRole('button', { name: 'web-copy · Codex', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Codex web-copy', exact: true })).toBeVisible()
  expect(errors).toEqual([])
  const artifact = resolve(web, 'artifacts/agents-live')
  await mkdir(artifact, { recursive: true })
  await page.screenshot({
    path: resolve(artifact, 'profiles.png'),
    fullPage: true,
  })
  await writeFile(
    resolve(artifact, 'run.json'),
    JSON.stringify(
      {
        checks: [
          'exact terminal attachment',
          'auth isolation',
          'backend restart',
          'Python worker recovery',
          'lost launch response',
          'multiple tabs',
          'stop and finalization',
          'quick profile deletion',
          'session-tab removed',
          'new saved login',
          'reauthentication and verification',
          'native login import',
          'login rename and removal',
          'provider inspection and diagnostics',
          'profile rename and duplication',
        ],
        final: inspect(),
        pageErrors: errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'Agents live integration passed: terminal recovery, login creation/renewal/import/verification/removal, provider diagnostics, and profile rename/duplication/deletion.',
  )
} catch (error) {
  failure = true
  console.error(error)
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
