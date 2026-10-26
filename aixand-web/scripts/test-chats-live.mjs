// Browser → Nest → Python → Agent Manager → Undercurrent → offline app-server.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { buildTestServer, testAuthEnvironment, authenticateTestPage } from './isolated-test-server.mjs'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = resolve(web, '../aixand-server')
const python = process.env.AGENTS_TEST_PYTHON ?? resolve(web, '../aixand-ir/.venv/bin/python')
const binaries = process.env.UNDERCURRENT_BIN_DIR ?? resolve(web, '../../undercurrent/target/debug')
const work = await mkdtemp(resolve(tmpdir(), 'aixand-chat-live-'))
const token = randomBytes(32).toString('hex')
const env = {
  ...process.env,
  PATH: [dirname(python), binaries, process.env.PATH].join(delimiter),
  PYTHONPATH: [resolve(web, '../../manager-suites/agent-manager'), resolve(web, '../../undercurrent/python/src'),
    ...['mcp-manager', 'server-manager', 'prompt-manager', 'skill-manager', 'resource-sources', 'orchestration-mcp'].map(name => resolve(web, '../../manager-suites', name, 'src'))].join(delimiter),
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
  CARRIER_DATABASE: resolve(work, 'carrier.db'),
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket
    window.WebSocket = class extends NativeSocket {
      send(value) {
        super.send(value)
        try {
          if (window.dropNextChatSend && JSON.parse(value).op === 'chat-send') {
            window.dropNextChatSend = false
            setTimeout(() => this.close(), 0)
          }
        } catch {}
      }
    }
  })
  async function connect(target = page) {
    await expect(target.getByLabel('Workspace access key')).toHaveCount(0)
  }
  const conversation = page.getByRole('region', { name: 'Agent conversation', exact: true })
  const prompt = page.getByRole('textbox', { name: 'Instructions', exact: true })
  async function openInfo() {
    const information = page.getByRole('dialog', { name: 'Conversation information', exact: true })
    if (!await information.isVisible()) await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
    await expect(information).toBeVisible()
  }
  async function send(text) {
    await prompt.fill(text)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  async function checkSharedTerminal(originalUrl, firstThread) {
    // Both interfaces continue the original thread while the terminal stays open.
    await authenticateTestPage(page, originalUrl)
    await page.goto(originalUrl)
    await openInfo()
    const terminalCard = page.getByRole('group', { name: 'Conversation terminal', exact: true })
    const appServerRun = runs().find((run) => run.profile === 'work' && run.mode === 'app-server' && run.active)
    await terminalCard.getByRole('button', { name: 'Spawn terminal', exact: true }).click()
    if (!page.url().includes('#/terminals/')) {
      await expect(page.getByRole('dialog', { name: 'Conversation information', exact: true })).toBeHidden()
      await openInfo()
      await expect(terminalCard.getByRole('button', { name: 'Open terminal', exact: true })).toBeVisible({ timeout: 20000 })
      await terminalCard.getByRole('button', { name: 'Open terminal', exact: true }).click()
    }
    await expect(page).toHaveURL(/#\/terminals\/[^/]+$/)
    const terminalUrl = page.url()
    const terminalRun = runs().find((run) => run.thread_id === firstThread.id && run.active)
    expect(terminalRun.launch_kind).toBe('app-server-client')
    expect(terminalRun.app_server_run_id).toBe(appServerRun.run_id)
    expect(terminalRun.cwd).toBe(firstThread.cwd)
    await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Connected')
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('Resumed thread ' + firstThread.id)
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('terminal follow-up')
    await page.keyboard.press('Enter')
    await expect(page.locator('.xterm-accessibility-tree')).toContainText('Reply: terminal follow-up · done')
    await authenticateTestPage(page, originalUrl)
    await page.goto(originalUrl)
    await expect(conversation).toContainText('Reply: terminal follow-up · done')
    await expect(prompt).not.toHaveAttribute('readonly', '')
    await send('Web follow-up with terminal still open')
    await expect(conversation).toContainText('Reply: Web follow-up with terminal still open · done')
    expect(runs().find((run) => run.run_id === terminalRun.run_id).active).toBe(true)
    await page.goto(terminalUrl)
    await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Connected')
    const beforeApprovalTurns = (await providerTurns()).length
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('approve from the terminal')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await providerTurns()).length).toBe(beforeApprovalTurns + 1)
    await page.goto(originalUrl)
    await expect(page.getByRole('region', { name: 'Agent approval' })).toContainText('echo approved')
    await page.getByRole('button', { name: 'Approve once', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Agent approval' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    expect(runs().find((run) => run.run_id === terminalRun.run_id).active).toBe(true)
    await send('slow web task with terminal open')
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(conversation).toContainText('Stopped. You can send another message.')
    expect(runs().find((run) => run.run_id === terminalRun.run_id).active).toBe(true)
    await openInfo()
    await expect(terminalCard.getByRole('button', { name: 'Open terminal', exact: true })).toBeVisible()
    // A backend restart preserves shared input and the exact terminal session.
    await stop(backend)
    const beforeOutageTurns = (await providerTurns()).length
    execFileSync(python, ['-B', '-c',
      'import asyncio,sys,undercurrent\nasync def send():\n async with undercurrent.Client() as runtime:\n  await runtime.send_input(sys.argv[1],sys.argv[2],paste=False)\nasyncio.run(send())',
      terminalRun.session_id, 'approve while the web backend is down'], { env, encoding: 'utf8', timeout: 10000 })
    await expect.poll(async () => (await providerTurns()).length).toBe(beforeOutageTurns + 1)
    backend = launch()
    await ready(`http://127.0.0.1:${apiPort}/api/health`)
    await page.reload()
    await connect()
    await expect(page.getByRole('region', { name: 'Agent approval' })).toContainText('echo approved')
    await page.getByRole('button', { name: 'Approve once', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Agent approval' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    await expect(prompt).not.toHaveAttribute('readonly', '')
    await send('Web after backend restart with terminal')
    await expect(conversation).toContainText('Reply: Web after backend restart with terminal · done')
    await openInfo()
    await terminalCard.getByRole('button', { name: 'Open terminal', exact: true }).click()
    await expect(page).toHaveURL(terminalUrl)
    expect(runs().filter((run) => run.thread_id === firstThread.id)).toHaveLength(1)
    await authenticateTestPage(page, originalUrl)
    await page.goto(originalUrl)
    await openInfo()
    await terminalCard.getByRole('button', { name: 'Stop terminal client', exact: true }).click()
    await expect(prompt).not.toHaveAttribute('readonly', '')
    expect(runs().find((run) => run.run_id === appServerRun.run_id).active).toBe(true)
    await send('Command after terminal')
    await expect(conversation).toContainText('Reply: Command after terminal · done')
    await openInfo()
    await expect(terminalCard.getByRole('button', { name: 'Spawn terminal', exact: true })).toBeVisible({ timeout: 20000 })
    await page.keyboard.press('Escape')
    await send('spawn a terminal')
    await expect(conversation).toContainText('Reply: Terminal queued · done', { timeout: 20000 })
    await openInfo()
    await expect(terminalCard.getByRole('button', { name: 'Open terminal', exact: true })).toBeVisible({ timeout: 20000 })
    await expect(prompt).not.toHaveAttribute('readonly', '')
    expect(runs().filter((run) => run.thread_id === firstThread.id && run.active)).toHaveLength(1)
    expect(runs().filter((run) => run.thread_id === firstThread.id)).toHaveLength(2)
    await terminalCard.getByRole('button', { name: 'Stop terminal client', exact: true }).click()
    await expect(prompt).not.toHaveAttribute('readonly', '')
    const resumedThread = JSON.parse(await readFile(resolve(work, 'manager/codex/agents/work/fixture-threads.json'), 'utf8'))[firstThread.id]
    expect(resumedThread.model).toBe(firstThread.model)
    expect(resumedThread.sandbox).toBe(firstThread.sandbox)
    expect(resumedThread.approvalPolicy).toBe(firstThread.approvalPolicy)

  }
  await authenticateTestPage(page, `${origin}/#/chat`)
  await page.goto(`${origin}/#/chat`)
  if (process.argv.includes('--shared-terminals')) {
    await page.getByRole('button', { name: 'Auto Profile', exact: true }).click()
    await page.getByRole('option', { name: /^work/ }).click()
    await prompt.fill('hello')
    await page.getByRole('button', { name: 'Start agent', exact: true }).click()
    await expect(conversation).toContainText('Reply: hello · done', { timeout: 20000 })
    const firstThread = Object.values(JSON.parse(await readFile(resolve(work, 'manager/codex/agents/work/fixture-threads.json'), 'utf8')))[0]
    await checkSharedTerminal(page.url(), firstThread)
    expect(errors).toEqual([])
    console.log('Shared terminal integration passed: both composers, cross-client approval, pending approval recovery after backend restart, Stop, exact-session reuse, client shutdown and retained native policy.')
  } else {
  await expect(page.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Auto Agent', exact: true })).toBeVisible()
  await connect()
  await expect(page.getByRole('button', { name: 'Auto Agent', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('button')).toHaveCount(0)
  await expect(page.getByLabel('Project directory')).toHaveCount(0)
  const modelPicker = page.getByRole('button', { name: /Model$/ })
  await expect(modelPicker).toBeEnabled()
  await modelPicker.click()
  await page.getByRole('option', { name: /^Fixture Fast/ }).click()
  await page.getByRole('dialog', { name: 'Model settings', exact: true }).getByRole('button', { name: 'Done', exact: true }).click()
  await expect(modelPicker).toContainText('Fixture Fast')
  await prompt.fill('hello')
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect(conversation).toContainText('Reply: hello · done', { timeout: 20000 })
  await expect(modelPicker).toBeDisabled()
  const firstThread = Object.values(JSON.parse(await readFile(resolve(work, 'manager/codex/agents/work/fixture-threads.json'), 'utf8')))[0]
  expect(firstThread.model).toBe('fixture-fast')
  expect(firstThread.sandbox).toBe('workspace-write')
  expect(dirname(firstThread.cwd)).toBe(env.AGENTS_SCRATCH_DIR)
  const scratchFile = resolve(firstThread.cwd, 'scratch-note.txt')
  await expect(page.locator('.command-directory-context')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'work Agent', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await writeFile(budgetsFile, JSON.stringify({ [workAuth]: 95, [reviewAuth]: 10 }))
  await send('follow-up')
  await expect(conversation).toContainText('Reply: follow-up · done')
  expect((await providerTurns()).length).toBe(2)
  expect(runs().filter((run) => run.profile === 'work' && run.active)).toHaveLength(1)

  await send('write scratch file')
  await expect(conversation).toContainText('Reply: Saved scratch-note.txt · done')
  expect(await readFile(scratchFile, 'utf8')).toBe("A file generated in this chat's workspace.")

  await send('approve this')
  await expect(page.getByRole('region', { name: 'Agent approval' })).toContainText('echo approved')
  await page.getByRole('button', { name: 'Approve once' }).click()
  await expect(conversation).toContainText('Reply: approved · done')
  await send('ask a question')
  await page.getByLabel('Which option should I use?').fill('First')
  await page.getByRole('button', { name: 'Send answers' }).click()
  await expect(conversation).toContainText('Reply: First · done')

  await send('slow stop')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(conversation).toContainText('Stopped. You can send another message.')
  await send('after stop')
  await expect(conversation).toContainText('Reply: after stop · done')

  await page.evaluate(() => { window.dropNextChatSend = true })
  await send('lost response')
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
  await connect()
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect(conversation).toContainText('Reply: lost response · done')
  expect((await providerTurns()).filter((turn) => turn.items.some((item) => item.type === 'userMessage' && item.content[0].text === 'lost response'))).toHaveLength(1)

  await send('slow backend restart')
  await stop(backend)
  backend = launch()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  await connect()
  await expect(conversation).toContainText('Reply: slow backend restart · done', { timeout: 20000 })
  expect(await readFile(scratchFile, 'utf8')).toBe("A file generated in this chat's workspace.")
  expect(runs().filter((run) => run.profile === 'work' && run.active)).toHaveLength(1)

  await page.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Auto Agent', exact: true })).toBeVisible()
  await expect(modelPicker).toBeEnabled()
  await page.getByRole('button', { name: / Agent$/ }).click()
  await page.getByRole('option', { name: /^review/ }).click()
  await expect(modelPicker).toContainText('Profile default')
  await page.getByRole('button', { name: / Agent$/ }).click()
  await page.getByRole('option', { name: /^Auto/ }).click()
  await expect(modelPicker).toBeEnabled()
  await modelPicker.click()
  await page.getByRole('option', { name: /^Fixture Deep/ }).click()
  await page.getByRole('dialog', { name: 'Model settings', exact: true }).getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project', exact: true })
  await expect(projectDialog.getByRole('textbox')).toHaveCount(2)
  await projectDialog.getByLabel('Project name').fill('Studio website')
  await projectDialog.getByLabel('Project path').fill(resolve(work, 'missing-project'))
  await projectDialog.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(projectDialog.getByRole('alert')).toHaveText('Project directory does not exist')
  await projectDialog.getByLabel('Project path').fill(work)
  await projectDialog.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(projectDialog).toHaveCount(0)
  await expect(page.getByLabel('Project directory')).toHaveCount(0)
  await expect(page.locator('.command-directory-context > summary')).toContainText('Studio website')
  await page.locator('.command-directory-context > summary').click()
  await expect(page.locator('.command-directory-context')).toContainText(work)
  await prompt.fill('project work')
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect(conversation).toContainText('Reply: project work · done')
  await expect(page.getByRole('button', { name: 'review Agent', exact: true })).toBeDisabled()
  const threads = (await Promise.all(['work', 'review'].map(async (profile) =>
    Object.values(JSON.parse(await readFile(resolve(work, `manager/codex/agents/${profile}/fixture-threads.json`), 'utf8')))))).flat()
  expect(threads.map((thread) => thread.sandbox)).toEqual(['workspace-write', 'workspace-write'])
  expect(threads.map((thread) => thread.model)).toEqual(['fixture-fast', 'fixture-deep'])
  expect(threads.every((thread) => thread.approvalPolicy === 'on-request')).toBe(true)
  expect(threads.map((thread) => thread.cwd)).toEqual([firstThread.cwd, work])
  expect(runs().filter((run) => run.profile === 'work' && run.active)).toHaveLength(1)
  expect(runs().filter((run) => run.profile === 'review' && run.active)).toHaveLength(1)

  await page.getByRole('button', { name: 'Chat settings', exact: true }).click()
  await page.getByRole('button', { name: / Project$/ }).click()
  await page.getByRole('option', { name: /^No project/ }).click()
  await expect(page.locator('.command-directory-context')).toHaveCount(0)
  await prompt.fill('separate scratch chat')
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect(conversation).toContainText('Reply: separate scratch chat · done')
  const reviewThreads = Object.values(JSON.parse(await readFile(resolve(work, 'manager/codex/agents/review/fixture-threads.json'), 'utf8')))
  const separateScratch = reviewThreads.find((thread) => thread.cwd !== work)
  expect(dirname(separateScratch.cwd)).toBe(env.AGENTS_SCRATCH_DIR)
  expect(separateScratch.cwd).not.toBe(firstThread.cwd)
  await expect(readFile(resolve(separateScratch.cwd, 'scratch-note.txt'))).rejects.toThrow(/ENOENT/)

  await page.reload()
  await connect()
  await page.getByRole('tab', { name: 'Projects', exact: true }).click()
  await page.getByRole('button', { name: 'Studio website, 1 conversations', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Studio website conversations', exact: true })).toContainText('project work')
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click()
  await page.getByRole('tab', { name: 'Recent', exact: true }).click()
  await page.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('button', { name: /^hello/ }).click()
  await expect(modelPicker).toContainText('fixture-fast')
  await expect(modelPicker).toBeDisabled()
  await expect(conversation).toContainText('Reply: follow-up · done')
  await expect(conversation).toContainText('Reply: slow backend restart · done')
  await expect(page.locator('.command-directory-context')).toHaveCount(0)
  expect(await readFile(scratchFile, 'utf8')).toBe("A file generated in this chat's workspace.")
  await expect(page.getByRole('button', { name: 'work Agent', exact: true })).toBeDisabled()
  await send('original profile after reload')
  await expect(conversation).toContainText('Reply: original profile after reload · done')
  expect((await providerTurns()).at(-1).items.some((item) => item.type === 'userMessage' && item.content[0].text === 'original profile after reload')).toBe(true)

  // Launch from a general chat, with another browser already subscribed.
  const observer = await context.newPage()
  await observer.addInitScript(() => {
    const NativeSocket = window.WebSocket
    window.WebSocket = class extends NativeSocket {
      catalogs = new Set()
      send(value) {
        const message = JSON.parse(value)
        if (message.op === 'chat-list') this.catalogs.add(message.id)
        super.send(value)
      }
      set onmessage(listener) {
        super.onmessage = (event) => {
          const message = JSON.parse(event.data)
          if (this.catalogs.has(message.id)) {
            this.catalogs.delete(message.id)
            setTimeout(() => { listener.call(this, event); window.catalogDelivered = true }, 2500)
          } else listener.call(this, event)
        }
      }
    }
  })
  await observer.goto(`${origin}/#/chat`)
  await connect(observer)
  const originalUrl = page.url()
  const parentTitle = await page.locator('.command-conversation-title').getAttribute('title')
  const beforeLaunch = Object.values(JSON.parse(await readFile(resolve(work, 'manager/codex/agents/work/fixture-threads.json'), 'utf8'))).length
  await send('launch audit slow parent')
  const card = page.getByRole('article', { name: 'Authentication audit', exact: true })
  await expect(card.getByRole('status')).toHaveText('Running', { timeout: 20000 })
  await expect(page.getByRole('region', { name: 'Agent approval' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(conversation).toContainText('Stopped. You can send another message.')
  await expect(observer.getByRole('region', { name: 'Recent conversations', exact: true })).toContainText('Authentication audit')
  const recent = page.getByRole('region', { name: 'Recent conversations', exact: true })
  const auditHistory = recent.getByRole('button', { name: /^Authentication audit/ })
  const spawnedHistory = recent.getByRole('list', { name: `Sessions spawned from ${parentTitle}`, exact: true })
  const collapseName = `Collapse sessions spawned from ${parentTitle}`
  const expandName = `Expand sessions spawned from ${parentTitle}`
  await expect(spawnedHistory).toBeHidden()
  await expect(recent.getByRole('button', { name: expandName, exact: true })).toHaveAttribute('aria-expanded', 'false')
  await recent.getByRole('button', { name: expandName, exact: true }).click()
  await expect(spawnedHistory.getByRole('button', { name: /^Authentication audit/ })).toBeVisible()
  const parentHistory = spawnedHistory.locator('..').locator(':scope > .command-history-row > .command-history-item')
  expect((await auditHistory.boundingBox()).x - (await parentHistory.boundingBox()).x).toBeGreaterThanOrEqual(12)
  await expect(parentHistory.getByLabel('1 session in this group')).toHaveText('1')
  const artifacts = resolve(web, 'artifacts/chats-live')
  await mkdir(artifacts, { recursive: true })
  await page.screenshot({ path: resolve(artifacts, 'sidebar-expanded.png'), fullPage: true })
  await recent.getByRole('button', { name: collapseName, exact: true }).click()
  await expect(spawnedHistory).toBeHidden()
  await expect(recent.getByRole('button', { name: expandName, exact: true })).toHaveAttribute('aria-expanded', 'false')
  await expect(page).toHaveURL(originalUrl)
  await page.getByRole('tab', { name: 'Chats', exact: true }).click()
  const chatsHistory = page.getByRole('region', { name: 'Chats', exact: true })
  await expect(chatsHistory.getByRole('button', { name: expandName, exact: true })).toHaveAttribute('aria-expanded', 'false')
  await chatsHistory.getByRole('button', { name: expandName, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(chatsHistory.getByRole('list', { name: `Sessions spawned from ${parentTitle}`, exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Recent', exact: true }).click()
  await expect(spawnedHistory).toBeVisible()
  await expect.poll(() => observer.evaluate(() => window.catalogDelivered === true)).toBe(true)
  await expect(observer.getByRole('region', { name: 'Recent conversations', exact: true })).toContainText('Authentication audit')
  const launchedThreads = Object.values(JSON.parse(await readFile(resolve(work, 'manager/codex/agents/work/fixture-threads.json'), 'utf8')))
  expect(launchedThreads).toHaveLength(beforeLaunch + 1)
  const audit = launchedThreads.find((thread) => thread.sandbox === 'read-only')
  expect(audit.cwd).toBe(work)
  expect(audit.model).toBe('fixture-fast')
  expect(audit.dynamicTools).toEqual([])
  expect(audit.turns[0].items[0].content[0].text).toBe('slow audit authentication')
  expect(audit.id).not.toBe(firstThread.id)

  await card.getByRole('button', { name: 'Open chat', exact: true }).click()
  await expect(page).toHaveURL(/#\/chat\/[a-f0-9-]+$/)
  await openInfo()
  await expect(page.locator('.command-chat-context')).toContainText('Read-only')
  const parentLink = page.getByRole('group', { name: 'Parent session' }).getByRole('link')
  await expect(parentLink).toHaveText(parentTitle)
  await expect(spawnedHistory.getByRole('button', { name: /^Authentication audit/ })).toBeVisible()
  await expect(parentLink).toHaveAttribute('href', new URL(originalUrl).hash)
  await parentLink.click()
  await expect(page).toHaveURL(originalUrl)
  await card.getByRole('button', { name: 'Open chat', exact: true }).click()
  await expect(conversation).toContainText('Reply: slow audit authentication · done', { timeout: 20000 })
  const auditUrl = page.url()
  await recent.getByRole('button', { name: collapseName, exact: true }).click()
  await page.reload()
  await connect()
  await expect(page).toHaveURL(auditUrl)
  await openInfo()
  await expect(parentLink).toHaveText(parentTitle)
  await page.keyboard.press('Escape')
  await expect(spawnedHistory).toBeHidden()
  await recent.getByRole('button', { name: expandName, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(spawnedHistory).toBeVisible()
  await expect(conversation).toContainText('Reply: slow audit authentication · done')
  await send('audit follow-up')
  await expect(conversation).toContainText('Reply: audit follow-up · done')
  await authenticateTestPage(page, originalUrl)
  await page.goto(originalUrl)
  await page.reload()
  await connect()
  await expect(card.getByRole('status')).toHaveText('Completed')
  await expect(spawnedHistory).toBeVisible()
  await expect(card).toContainText('Reply: slow audit authentication · done')
  await expect(card.getByLabel('Result delivery')).toHaveText('Result delivery paused')

  // Both browsers observe a live relationship change without stopping the child.
  await observer.goto(originalUrl)
  const observerCard = observer.getByRole('article', { name: 'Authentication audit', exact: true })
  await expect(observerCard).toBeVisible()
  await card.getByRole('button', { name: 'Open chat', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Show chat history', exact: true }).click()
  const mobileHistory = page.getByRole('dialog', { name: 'Chat history', exact: true })
  await expect(mobileHistory.getByRole('list', { name: `Sessions spawned from ${parentTitle}`, exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: resolve(artifacts, 'sidebar-mobile.png'), fullPage: true })
  await mobileHistory.getByRole('button', { name: collapseName, exact: true }).click()
  await expect(mobileHistory.getByRole('button', { name: expandName, exact: true })).toHaveAttribute('aria-expanded', 'false')
  await mobileHistory.getByRole('button', { name: expandName, exact: true }).click()
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1440, height: 1100 })
  await send('slow detached follow-up')
  await expect(observerCard.getByRole('status')).toHaveText('Running')
  await openInfo()
  await page.getByRole('button', { name: 'Detach', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Parent session' })).toHaveCount(0)
  await expect(page.locator('.command-chat-context')).toContainText('Independent session')
  await page.keyboard.press('Escape')
  await expect(observerCard).toHaveCount(0)
  await expect(recent.getByRole('button', { name: /^Authentication audit/ }).locator('..').locator('..').locator('..')).not.toHaveClass('command-history-children')
  await expect(recent.getByRole('button', { name: collapseName, exact: true })).toHaveCount(0)
  await expect(observer.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('list', { name: `Sessions spawned from ${parentTitle}`, exact: true })).toHaveCount(0)
  await expect(conversation).toContainText('Reply: slow detached follow-up · done', { timeout: 20000 })
  await stop(backend)
  backend = launch()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  await page.reload()
  await connect()
  await expect(page).toHaveURL(auditUrl)
  await openInfo()
  await expect(page.getByRole('group', { name: 'Parent session' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await send('continue independently')
  await expect(conversation).toContainText('Reply: continue independently · done')
  await authenticateTestPage(page, originalUrl)
  await page.goto(originalUrl)
  await page.reload()
  await connect()
  await expect(card).toHaveCount(0)

  // An explicit detached launch starts with no parent and no tracking card.
  await send('launch audit detached')
  await expect(conversation).toContainText('Reply: Audit launched · done')
  await expect(page.getByRole('heading', { name: 'Spawned sessions', exact: true })).toHaveCount(0)
  const history = page.getByRole('region', { name: 'Recent conversations', exact: true })
  await expect(history).toContainText('Detached audit')
  await history.getByRole('button', { name: /^Detached audit/ }).click()
  await openInfo()
  await expect(page.locator('.command-chat-context')).toContainText('Independent session')
  await expect(page.getByRole('group', { name: 'Parent session' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(conversation).toContainText('Reply: slow audit authentication · done', { timeout: 20000 })
  await observer.close()

  await checkSharedTerminal(originalUrl, firstThread)

  await page.setViewportSize({ width: 390, height: 844 })
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token)
  expect(errors).toEqual([])
  await page.screenshot({ path: resolve(artifacts, 'conversation-mobile.png'), fullPage: true })
  await writeFile(resolve(artifacts, 'run.json'), JSON.stringify({ checks: ['Auto highest-budget profile', 'new conversation reranks profiles', 'follow-ups and reload keep original profile', 'isolated writable scratch workspaces', 'generated files survive backend restart and reopening', 'clearing a project uses a new scratch workspace', 'streaming', 'follow-ups', 'approval', 'questions', 'interrupt', 'lost response without duplicate', 'backend restart', 'project Work thread', 'history after reload', 'standalone read-only audit from general chat', 'tool delivery deduplication', 'source Stop preserves audit', 'chat-created broadcast to second browser', 'direct chat links survive reload', 'linked completion card survives reload', 'parent link and navigation', 'sidebar child count and connector lines', 'keyboard expand/collapse and reload persistence', 'mobile sidebar disclosure', 'live detachment broadcasts to second browser', 'detachment preserves active work and survives restart', 'explicit detached launch', 'exact-thread shared terminal', 'terminal input updates the original transcript', 'web input remains enabled with a terminal', 'web answers terminal-origin approvals', 'web Stop leaves the terminal client alive', 'web and terminal input survive backend restart', 'reopen reuses the existing session', 'stopping the terminal client preserves the shared app-server', 'natural-language terminal launch queues and deduplicates', 'thread model and permissions are preserved', 'mobile accessibility'], runs: runs(), pageErrors: errors }, null, 2))
  console.log('Chat integration passed: exact-thread shared terminal, web and terminal input, cross-client approvals, Stop, restart and reopen, terminal client shutdown, natural-language queued launch and duplicate delivery, project audits, direct links and accessibility.')
  }
} catch (error) {
  failed = true
  console.error(error)
  if (process.argv.includes('--shared-terminals')) {
    try { console.error('Last isolated provider turn:', JSON.stringify((await providerTurns()).at(-1))) } catch {}
  }
  for (const log of logs) console.error(log())
} finally {
  await browser?.close()
  spawnSync(resolve(binaries, 'uc'), ['stop', '--all', '--force'], { env, timeout: 10000, stdio: 'ignore' })
  spawnSync(resolve(binaries, 'uc'), ['daemon', 'stop'], { env, timeout: 10000, stdio: 'ignore' })
  for (const child of children.reverse()) await stop(child)
  await rm(work, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
