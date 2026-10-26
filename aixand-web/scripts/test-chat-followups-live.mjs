// Exercise browser → Nest → Python → SDK against the offline Codex protocol.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { chromium, expect } from '@playwright/test'
import { buildTestServer, testAuthEnvironment, authenticateTestPage } from './isolated-test-server.mjs'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = resolve(web, '../aixand-server')
const python = process.env.AGENTS_TEST_PYTHON ?? resolve(web, '../aixand-ir/.venv/bin/python')
const binaries = process.env.UNDERCURRENT_BIN_DIR ?? resolve(web, '../../undercurrent/target/debug')
const work = await mkdtemp(resolve(tmpdir(), 'aixand-chat-followups-'))
const env = {
  ...process.env, PATH: [dirname(python), binaries, process.env.PATH].join(delimiter),
  PYTHONPATH: [resolve(web, '../../manager-suites/agent-manager'), resolve(web, '../../undercurrent/python/src')].join(delimiter),
  UNDERCURRENT_HOME: resolve(work, 'runtime'), UNDERCURRENT_PYTHON_BRIDGE: resolve(binaries, 'uc-python-bridge'),
  AGENTS_PYTHON: python, AGENTS_STATE_DIR: resolve(work, 'chats'), AGENTS_SCRATCH_DIR: resolve(work, 'scratch'),
  AGENTS_CWD: work, AGENTS_WORKSPACE_TOOLS: '0', TERMINAL_CWD: work,
  CARRIER_AUTO_PROVISION: '0', CARRIER_URL: 'http://127.0.0.1:1', CARRIER_STATE_DIR: resolve(work, 'carrier'),
  CARRIER_STATE_DATABASE: resolve(work, 'carrier/suite.db'), CARRIER_DATABASE: resolve(work, 'carrier.db'),
  CARRIER_USER_CREDENTIALS: resolve(work, 'carrier-user.json'), CARRIER_MAILBOXES_FILE: '', CARRIER_AGENT_CONFIG: '',
}
const children = [], logs = []
let browser, backend, failed = false
function start(command, args, cwd, extra = {}) {
  const child = spawn(command, args, { cwd, env: { ...env, ...testAuthEnvironment(), ...extra }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-6000) })
  children.push(child); logs.push(() => output)
  return child
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise((resolveDone) => child.once('exit', resolveDone))
  child.kill('SIGTERM')
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 12000)
  await done; clearTimeout(timer)
}
async function port() {
  const socket = createServer()
  await new Promise((ready) => socket.listen(0, '127.0.0.1', ready))
  const value = socket.address().port
  await new Promise((closed) => socket.close(closed))
  return value
}
async function ready(url) {
  await expect.poll(async () => { try { return (await fetch(url)).ok } catch { return false } }, { timeout: 20000 }).toBe(true)
}
async function turns() {
  const rows = []
  for (const profile of await readdir(resolve(work, 'manager/codex/agents'))) {
    try { rows.push(...Object.values(JSON.parse(await readFile(resolve(work, 'manager/codex/agents', profile, 'fixture-threads.json'), 'utf8'))).flatMap((thread) => thread.turns)) }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
  }
  return rows
}
function hasPrompt(turn, text) { return turn.items.some((item) => item.type === 'userMessage' && item.content[0].text === text) }

try {
  const fixture = JSON.parse(execFileSync(python, [resolve(server, 'agent-bridge/tests/fixture.py'), work], { env, encoding: 'utf8' }))
  env.AGENT_MANAGER_HOME = fixture.home; env.AGENT_MANAGER_CONFIG = fixture.config
  const provider = await readFile(resolve(server, 'agent-bridge/tests/app_server_provider.py'), 'utf8')
  await writeFile(resolve(work, 'offline-provider'), provider.replace('#!/usr/bin/env python3', `#!${python}`), { mode: 0o700 })
  const apiPort = await port(), webPort = await port()
  const origin = `http://127.0.0.1:${webPort}`
  start(resolve(binaries, 'uc-daemon'), [], work)
  await expect.poll(() => spawnSync(resolve(binaries, 'uc'), ['daemon', 'status'], { env, timeout: 2000 }).status, { timeout: 20000 }).toBe(0)
  const main = buildTestServer(server, work)
  const launch = () => start(process.execPath, [main], server, { HOST: '127.0.0.1', PORT: String(apiPort), CORS_ORIGINS: origin })
  backend = launch()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], web, { AIXAND_SERVER_URL: `http://127.0.0.1:${apiPort}` })
  await ready(origin)
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  let page = await context.newPage()
  const errors = []
  context.on('page', (target) => target.on('pageerror', (error) => errors.push(error.message)))
  page.on('pageerror', (error) => errors.push(error.message))
  await authenticateTestPage(page, origin)
  await page.goto(`${origin}/#/chat`)
  const input = () => page.getByRole('textbox', { name: 'Instructions', exact: true })
  const queue = () => page.getByRole('region', { name: 'Queued messages', exact: true })
  const conversation = () => page.getByRole('region', { name: 'Agent conversation', exact: true })
  async function send(text, label = 'Send message') {
    await input().fill(text)
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(input()).toHaveValue('')
  }
  async function enqueue(text) {
    await page.getByRole('button', { name: 'Chat settings', exact: true }).click()
    await page.getByRole('combobox', { name: 'Message timing' }).selectOption('queue')
    await send(text, 'Send after this turn')
  }
  await send('slow original investigation', 'Start agent')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await send('use the mobile error log', 'Add to current turn')
  await enqueue('slow first queued task')
  await enqueue('second queued task')
  const queued = queue().locator('li').filter({ hasText: 'second queued task' })
  await queued.getByRole('button', { name: 'Edit queued message', exact: true }).click()
  await queued.getByRole('textbox', { name: 'Edit queued message', exact: true }).fill('edited second queued task')
  await queued.getByRole('button', { name: 'Save message', exact: true }).click()
  await expect(queue()).toContainText('edited second queued task')
  const chatUrl = page.url()
  await page.reload()
  await expect(queue()).toContainText('edited second queued task')
  await expect(conversation()).toContainText('context: use the mobile error log', { timeout: 20000 })
  await expect(conversation()).toContainText('Reply: edited second queued task · done', { timeout: 20000 })
  await expect(queue()).toHaveCount(0)
  const ordered = await turns()
  expect(ordered).toHaveLength(3)
  expect(ordered[0].steering).toEqual(['use the mobile error log'])
  expect(hasPrompt(ordered[1], 'slow first queued task')).toBe(true)
  expect(hasPrompt(ordered[2], 'edited second queued task')).toBe(true)
  console.log('Steering, separate FIFO turns, queue editing, and refresh passed.')

  await send('slow task to stop')
  await enqueue('task held after stop')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(queue()).toContainText('Queue paused')
  await expect(conversation()).toContainText('Stopped. You can send another message.')
  await page.reload()
  await expect(queue()).toContainText('Queue paused')
  expect((await turns()).filter((turn) => hasPrompt(turn, 'task held after stop'))).toHaveLength(0)
  await queue().getByRole('button', { name: 'Resume queue', exact: true }).click()
  await expect(conversation()).toContainText('Reply: task held after stop · done', { timeout: 20000 })
  await expect(queue()).toHaveCount(0)
  console.log('Stop pauses the durable queue until explicitly resumed.')

  await send('slow restart task')
  await enqueue('follow-up after restart without a browser')
  await page.close()
  await stop(backend)
  backend = launch()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  await expect.poll(async () => (await turns()).filter((turn) => hasPrompt(turn, 'follow-up after restart without a browser') && turn.status === 'completed').length, { timeout: 20000 }).toBe(1)
  page = await context.newPage()
  await page.goto(chatUrl)
  await expect(conversation()).toContainText('Reply: follow-up after restart without a browser · done', { timeout: 20000 })
  await expect(queue()).toHaveCount(0)
  expect((await turns()).filter((turn) => hasPrompt(turn, 'follow-up after restart without a browser'))).toHaveLength(1)
  expect(errors).toEqual([])
  console.log('Backend restart resumes the queue without a browser and sends exactly once.')
} catch (error) {
  failed = true
  console.error(error)
  for (const log of logs) console.error(log())
  console.error(`Retained integration state: ${work}`)
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  for (const child of children.reverse()) await stop(child)
  spawnSync(resolve(binaries, 'uc'), ['daemon', 'stop'], { env, timeout: 5000 })
  if (!failed) await rm(work, { recursive: true, force: true })
}
