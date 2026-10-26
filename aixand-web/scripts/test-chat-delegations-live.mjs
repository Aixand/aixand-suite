// Browser → Nest → Python → Agent Manager → Undercurrent → offline app-server.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
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
const work = await mkdtemp(resolve(tmpdir(), 'aixand-chat-return-'))
const token = randomBytes(32).toString('hex')
const env = {
  ...process.env,
  PATH: [dirname(python), binaries, process.env.PATH].join(delimiter),
  PYTHONPATH: [resolve(web, '../../manager-suites/agent-manager'), resolve(web, '../../undercurrent/python/src'),
    resolve(web, '../../manager-suites/mcp-manager/src'), resolve(web, '../../manager-suites/server-manager/src')].join(delimiter),
  UNDERCURRENT_HOME: resolve(work, 'runtime'),
  UNDERCURRENT_PYTHON_BRIDGE: resolve(binaries, 'uc-python-bridge'),
  AGENTS_PYTHON: python,
  AGENTS_STATE_DIR: resolve(work, 'chats'),
  AGENTS_SCRATCH_DIR: resolve(work, 'scratch'),
  AGENTS_CWD: work,
  AGENTS_WORKSPACE_TOOLS: '1',
  TERMINAL_CWD: work,
  CARRIER_AUTO_PROVISION: '0',
  CARRIER_URL: 'http://127.0.0.1:1',
  CARRIER_STATE_DIR: resolve(work, 'carrier'),
  CARRIER_STATE_DATABASE: resolve(work, 'carrier/suite.db'),
  CARRIER_DATABASE: '',
  SUITE_WORKFLOW_SOCKET: '',
  WORKFLOW_RUNNER_HOME: resolve(work, 'unused-runner'),
  CARRIER_USER_CREDENTIALS: resolve(work, 'carrier-user.json'),
  CARRIER_MAILBOXES_FILE: '',
  CARRIER_AGENT_CONFIG: '',
}
const children = [], logs = []
let browser, backend
let failed = false
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
function runs() {
  return JSON.parse(execFileSync(python, ['-c', 'import asyncio,json,agent_manager; print(json.dumps(asyncio.run(agent_manager.Client("codex").runs())))'], { env, encoding: 'utf8', timeout: 10000 }))
}
async function providerTurns() {
  const values = JSON.parse(await readFile(resolve(work, 'manager/codex/agents/work/fixture-threads.json'), 'utf8'))
  return Object.values(values).flatMap((thread) => thread.turns)
}
try {
  const fixture = JSON.parse(execFileSync(python, [resolve(server, 'agent-bridge/tests/fixture.py'), work], { env, encoding: 'utf8' }))
  env.AGENT_MANAGER_HOME = fixture.home
  env.AGENT_MANAGER_CONFIG = fixture.config
  const provider = await readFile(resolve(server, 'agent-bridge/tests/app_server_provider.py'), 'utf8')
  await writeFile(resolve(work, 'offline-provider'), provider.replace('#!/usr/bin/env python3', `#!${python}`), { mode: 0o700 })
  await writeFile(fixture.config, (await readFile(fixture.config, 'utf8')).replace('budget_timeout = 1', 'budget_timeout = 1\nauth_cache_ttl = 0'))
  const workAuth = await readFile(resolve(work, 'manager/codex/agents/work/auth.json'), 'utf8')
  const reviewAuth = await readFile(resolve(work, 'manager/codex/agents/review/auth.json'), 'utf8')
  const budgetsFile = resolve(work, 'manager/codex/fixture-budgets.json')
  await writeFile(budgetsFile, JSON.stringify({ [workAuth]: 10, [reviewAuth]: 60 }))
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await authenticateTestPage(page, origin)
  await page.goto(`${origin}/#/chat`)
  const prompt = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await expect(prompt).toBeVisible()
  await page.evaluate(async ({ path }) => {
    await new Promise((done, reject) => {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/agents/ws`)
      const id = crypto.randomUUID()
      socket.onerror = () => reject(new Error('Test project registration connection failed'))
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data)
        if (message.type === 'ready') socket.send(JSON.stringify({ id, op: 'project-create', args: { name: 'Studio website', path } }))
        if (message.id === id) { socket.close(); message.type === 'error' ? reject(new Error(message.message)) : done(message.result) }
      }
    })
  }, { path: work })
  await page.getByRole('button', { name: / Agent$/ }).click()
  await page.getByRole('option', { name: /^work/ }).click()
  await prompt.fill('launch audit')
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  const conversation = page.getByRole('region', { name: 'Agent conversation', exact: true })
  await expect(conversation).toContainText('Reply: Audit launched · done')
  const parentUrl = page.url()
  const card = page.getByRole('article', { name: 'Authentication audit', exact: true })
  await expect(card.getByRole('status')).toHaveText('Running')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  const returned = async () => (await providerTurns()).filter((turn) => turn.items.some((item) =>
    item.type === 'userMessage' && item.content[0].text.includes('"kind": "delegation.result"')))
  await page.goto('about:blank')
  await stop(backend)
  backend = launch()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  await expect.poll(async () => (await returned()).length, { timeout: 20000 }).toBe(1)
  await authenticateTestPage(page, parentUrl)
  await page.goto(parentUrl)
  await expect(conversation.getByRole('article', { name: 'Result from Authentication audit', exact: true }))
    .toContainText('Reply: slow audit authentication · done')
  await expect(conversation).toContainText('Reply: Reviewed the returned audit report · done')
  await expect(card.getByLabel('Result delivery')).toHaveText('Returned result processed', { timeout: 20000 })
  await page.goto('about:blank')
  await stop(backend)
  backend = launch()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  await page.goto(parentUrl)
  await expect(card.getByLabel('Result delivery')).toHaveText('Returned result processed')
  await expect(conversation.getByRole('article', { name: 'Result from Authentication audit', exact: true })).toHaveCount(1)
  expect(await returned()).toHaveLength(1)
  expect(errors).toEqual([])
  const artifacts = resolve(web, 'artifacts/chat-delegations-live')
  await mkdir(artifacts, { recursive: true })
  await page.screenshot({ path: resolve(artifacts, 'returned-report.png'), fullPage: true })
  await writeFile(resolve(artifacts, 'run.json'), JSON.stringify({ checks: [
    'parent dispatch turn ends while child is running', 'automatic report return without browser',
    'worker starts without Carrier/workflow configuration', 'pending result survives backend restart',
    'parent processes returned report in a new turn', 'second restart preserves exactly one return',
    'result provenance and delivery state rendered in the browser',
  ], pageErrors: errors, receivingTurnId: (await returned())[0].id }, null, 2))
  console.log('Chat delegation integration passed: asynchronous dispatch, automatic parent continuation, no-browser recovery without Carrier, and one return across two restarts.')
} catch (error) {
  failed = true
  console.error(error)
  for (const log of logs) console.error(log())
} finally {
  await browser?.close()
  spawnSync(resolve(binaries, 'uc'), ['stop', '--all', '--force'], { env, timeout: 10000, stdio: 'ignore' })
  spawnSync(resolve(binaries, 'uc'), ['daemon', 'stop'], { env, timeout: 10000, stdio: 'ignore' })
  for (const child of children.reverse()) await stop(child)
  await rm(work, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
