// Isolated browser → Suite → shared automation host → managed offline provider.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { chromium, expect } from '@playwright/test'
import { buildTestServer, testAuthEnvironment, authenticateTestPage } from './isolated-test-server.mjs'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = resolve(web, '../server')
const python = process.env.AGENTS_TEST_PYTHON ?? resolve(web, '../../workflow/ir/.venv/bin/python')
const binaries = process.env.UNDERCURRENT_BIN_DIR ?? resolve(web, '../../../undercurrent/target/debug')
const work = await mkdtemp(resolve(tmpdir(), 'aixand-command-'))
const env = { ...process.env, ...testAuthEnvironment(),
  PATH: [dirname(python), binaries, process.env.PATH].join(delimiter),
  PYTHONPATH: [resolve(web, '../../mcps/orchestration/src'), resolve(web, '../../../manager-suites/agent-manager'),
    resolve(web, '../../../undercurrent/python/src'), resolve(web, '../../../manager-suites/mcp-manager/src'),
    resolve(web, '../../../manager-suites/server-manager/src')].join(delimiter),
  PYTHONDONTWRITEBYTECODE: '1', UNDERCURRENT_HOME: resolve(work, 'runtime'),
  UNDERCURRENT_PYTHON_BRIDGE: resolve(binaries, 'uc-python-bridge'), AGENTS_PYTHON: python,
  AGENTS_STATE_DIR: resolve(work, 'chats'), AGENTS_SCRATCH_DIR: resolve(work, 'scratch'), AGENTS_CWD: work,
  AGENTS_WORKSPACE_TOOLS: '1', TERMINAL_CWD: work,
  CARRIER_AUTO_PROVISION: '0', CARRIER_URL: 'http://127.0.0.1:1', CARRIER_DATABASE: '', SUITE_WORKFLOW_SOCKET: '',
  CARRIER_STATE_DIR: resolve(work, 'carrier'), CARRIER_STATE_DATABASE: resolve(work, 'carrier/suite.db'),
  WORKFLOW_RUNNER_HOME: resolve(work, 'unused-runner'), CARRIER_USER_CREDENTIALS: resolve(work, 'carrier-user.json'),
  CARRIER_MAILBOXES_FILE: '', CARRIER_AGENT_CONFIG: '',
}
const children = [], logs = []
let browser, backend, failed = false
function start(command, args, cwd, extra = {}) {
  const child = spawn(command, args, { cwd, env: { ...env, ...testAuthEnvironment(), ...extra }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-10000) })
  children.push(child); logs.push(() => output)
  return child
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise(finish => child.once('exit', finish))
  child.kill('SIGTERM')
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 12000)
  await done; clearTimeout(timer)
}
async function port() {
  const socket = createServer()
  await new Promise(ready => socket.listen(0, '127.0.0.1', ready))
  const value = socket.address().port
  await new Promise(closed => socket.close(closed))
  return value
}
async function ready(url) {
  await expect.poll(async () => { try { return (await fetch(url)).ok } catch { return false } }, { timeout: 20000 }).toBe(true)
}
async function request(page, op, args = {}) {
  return page.evaluate(({ op, args }) => new Promise((done, reject) => {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/agents/ws`)
    const id = crypto.randomUUID()
    const timer = setTimeout(() => { socket.close(); reject(new Error('Command test request timed out')) }, 30000)
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Command test connection failed')) }
    socket.onclose = event => { clearTimeout(timer); reject(new Error('Command test connection closed: ' + event.reason)) }
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      if (message.type === 'ready') socket.send(JSON.stringify({ id, op, args }))
      if (message.id === id) {
        clearTimeout(timer); socket.close()
        message.type === 'error' ? reject(new Error(message.message)) : done(message.result)
      }
    }
  }), { op, args })
}
async function turns() {
  const values = JSON.parse(await readFile(resolve(work, 'manager/codex/agents/work/fixture-threads.json'), 'utf8'))
  return Object.values(values).flatMap(thread => thread.turns)
}
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
  start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], web,
    { AIXAND_SERVER_URL: `http://127.0.0.1:${apiPort}` })
  await ready(origin)
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await authenticateTestPage(page, origin)
  await page.goto(`${origin}/#/command`)
  const project = await request(page, 'project-create', { name: 'Command test project', path: work })
  const target = await request(page, 'chat-create', { key: crypto.randomUUID(), profile: 'work', mode: 'work', projectId: project.id })
  const controller = await request(page, 'chat-create', { key: crypto.randomUUID(), profile: 'work', mode: 'work', projectId: project.id })
  await page.goto(`${origin}/#/chat/${controller.id}`)
  const instructions = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await instructions.fill('supervise checkout @chat:')
  await page.getByRole('listbox', { name: 'Chat suggestions', exact: true }).getByRole('option')
    .filter({ hasText: target.id.slice(0, 8) }).click()
  await expect(instructions).toHaveValue(`supervise checkout [${target.title}](#/chat/${target.id}) `)
  await expect(page).toHaveURL(new RegExp(`/chat/${controller.id}$`))
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Supervising: open supervision' })).toBeVisible({ timeout: 25000 })
  const listed = await request(page, 'command-list')
  const id = listed.monitors[0].id
  expect(listed.monitors[0].conversationChatId).toBe(controller.id)
  await expect.poll(async () => (await request(page, 'command-get', { monitorId: id })).monitor.memory, { timeout: 25000 }).toBe('audit dispatched')
  await page.goto('about:blank')
  await stop(backend)
  backend = launch()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  await expect.poll(async () => (await turns()).filter(turn => turn.items.some(item => item.type === 'dynamicToolCall' &&
    item.tool === 'checkpoint_monitor' && item.arguments.state === 'completed') && turn.status === 'completed').length, { timeout: 30000 }).toBe(1)
  await page.goto(`${origin}/#/command/monitors/${id}`)
  await expect(page).toHaveURL(new RegExp(`/chat/${controller.id}/supervision/${id}$`))
  // Checkpoint text can reach the browser before the host confirms that its
  // assigned provider turn ended. Wait for the durable settlement separately.
  await expect.poll(async () => (await request(page, 'command-get', { monitorId: id })).monitor.state,
    { timeout: 10000 }).toBe('completed')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Completed: open supervision' })).toBeVisible()
  await expect(page.getByRole('article', { name: 'Supervision update', exact: true }).last()).toContainText('Checkout requirements verified.')
  await expect(page.getByRole('article', { name: 'Your message', exact: true }).first()).toContainText('supervise checkout')
  await expect(page.getByRole('log', { name: 'Conversation messages' })).not.toContainText('persistent autonomous monitor')
  const allTurns = await turns()
  expect(allTurns.filter(turn => turn.items.some(item => item.type === 'dynamicToolCall' && item.tool === 'send_chat_message'))).toHaveLength(1)
  expect(allTurns.filter(turn => turn.items.some(item => item.type === 'dynamicToolCall' && item.tool === 'start_project_chat'))).toHaveLength(1)
  expect(errors).toEqual([])
  await page.screenshot({ path: '/tmp/aixand-supervision-chat.png', fullPage: true })
  console.log('Chat supervision: natural-language creation, badges, retained progress, follow-up, audit, browser closure and backend restart passed.')

  await mkdir(resolve(work, 'architecture'))
  const architectureProject = await request(page, 'project-create', { name: 'Undercurrent', path: resolve(work, 'architecture') })
  const architectureChat = await request(page, 'chat-create', { key: crypto.randomUUID(), profile: 'work', mode: 'work', projectId: architectureProject.id })
  await page.goto(`${origin}/#/chat/${architectureChat.id}`)
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill(
    'I want you to spawn a chat for Undercurrent and audit whether it has good architecture. After it finishes, spawn another agent to verify its claims. If confirmed, ask the original auditor to create a small brief and deliver it here.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Supervising: open supervision' })).toBeVisible({ timeout: 15000 })
  const architectureMonitor = (await request(page, 'command-list')).monitors.find(row => row.conversationChatId === architectureChat.id)
  expect(architectureMonitor).toBeTruthy()
  await expect.poll(async () => {
    const detail = await request(page, 'command-get', { monitorId: architectureMonitor.id })
    return detail.monitor.state === 'waiting' && !detail.monitor.currentRunId && JSON.parse(detail.monitor.memory || '{}').stage === 'deliver'
  }, { timeout: 35000 }).toBe(true)
  // No chat view stays open while the original auditor handles its second turn.
  await page.goto('about:blank')
  await stop(backend)
  backend = launch()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  await expect.poll(async () => (await turns()).filter(turn => turn.items.some(item => item.type === 'dynamicToolCall' &&
    item.tool === 'checkpoint_monitor' && item.arguments.state === 'completed') && turn.status === 'completed').length,
  { timeout: 30000 }).toBe(2)
  await page.goto(`${origin}/#/chat/${architectureChat.id}`)
  await expect.poll(async () => (await request(page, 'command-get', { monitorId: architectureMonitor.id })).monitor.state,
    { timeout: 10000 }).toBe('completed')
  await expect(page.getByRole('article', { name: 'Supervision update', exact: true }).last())
    .toContainText('Architecture brief: transport and policy have separate owners.')
  const continuationTurns = await turns()
  const calls = continuationTurns.flatMap(turn => turn.items.filter(item => item.type === 'dynamicToolCall'))
  expect(calls.filter(item => item.tool === 'create_monitor')).toHaveLength(2)
  expect(calls.filter(item => item.tool === 'start_project_chat')).toHaveLength(3)
  expect(calls.filter(item => item.tool === 'send_chat_message')).toHaveLength(2)
  expect(calls.filter(item => ['read_chat', 'get_chat_status', 'get_chat_message_status'].includes(item.tool))).toHaveLength(0)
  const detail = await request(page, 'command-get', { monitorId: architectureMonitor.id })
  expect(detail.activity.filter(entry => entry.kind === 'settled')).toHaveLength(4)
  expect(detail.delegations).toHaveLength(2)
  expect(detail.watches.filter(watch => watch.kind === 'receipt')).toHaveLength(1)
  expect(detail.watches.filter(watch => watch.kind === 'chat')).toHaveLength(0)
  expect(errors).toEqual([])
  console.log('Audit → independent verification → original-auditor brief: four settled evaluations, durable receipt return, no model polling, and restart without an open chat passed.')
} catch (error) {
  failed = true
  console.error(error)
  for (const log of logs) console.error(log())
  console.error(`Isolated artifacts retained at ${work}`)
} finally {
  await browser?.close()
  spawnSync(resolve(binaries, 'uc'), ['stop', '--all', '--force'], { env, timeout: 10000, stdio: 'ignore' })
  spawnSync(resolve(binaries, 'uc'), ['daemon', 'stop'], { env, timeout: 10000, stdio: 'ignore' })
  for (const child of [...children].reverse()) await stop(child)
  // Only the daemon and sessions under this private test runtime are stopped.
  if (!failed) await rm(work, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
