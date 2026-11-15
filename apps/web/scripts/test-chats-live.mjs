// Browser → Nest → Python → Agent Manager → Undercurrent → offline app-server.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { buildTestServer, testAuthEnvironment, authenticateTestPage } from './isolated-test-server.mjs'

if (process.argv.includes('--shared-terminals')) {
  throw new Error('Shared managed-chat terminals were retired. Run test-agents-live.mjs for the separate native-terminal contract.')
}

// Bounded qualification excludes the separate delegation/project workflow.
const managedCore = process.argv.includes('--managed-core')
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = resolve(web, '../server')
let python = process.env.AGENTS_TEST_PYTHON ?? resolve(web, '../../workflow/ir/.venv/bin/python')
const binaries = process.env.UNDERCURRENT_BIN_DIR ?? resolve(web, '../../../undercurrent/target/debug')
const work = await mkdtemp(resolve(tmpdir(), 'aixand-chat-live-'))
const token = randomBytes(32).toString('hex')
const env = {
  ...process.env,
  PATH: [dirname(python), binaries, process.env.PATH].join(delimiter),
  PYTHONPATH: [resolve(web, '../../mcps/orchestration/src'), resolve(web, '../../../manager-suites/agent-manager'), resolve(web, '../../../undercurrent/python/src'),
    ...['mcp-manager', 'server-manager', 'prompt-manager', 'skill-manager', 'resource-sources'].map(name => resolve(web, '../../../manager-suites', name, 'src'))].join(delimiter),
  UNDERCURRENT_HOME: resolve(work, 'runtime'),
  UNDERCURRENT_PYTHON_BRIDGE: resolve(binaries, 'uc-python-bridge'),
  AGENTS_PYTHON: python,
  AGENTS_STATE_DIR: resolve(work, 'chats'),
  AGENTS_SCRATCH_DIR: resolve(work, 'scratch'),
  AGENTS_CWD: work,
  CHAT_FIXTURE_STATE_DIR: resolve(work, 'provider-evidence'),
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
let browser, backend, fixture
let failed = false
const workflowFailures = []
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
async function providerThreads(profile = 'work') {
  const files = await readdir(env.CHAT_FIXTURE_STATE_DIR).catch(() => [])
  const values = await Promise.all(files.filter(file => file.endsWith('.json')).map(async file =>
    JSON.parse(await readFile(resolve(env.CHAT_FIXTURE_STATE_DIR, file), 'utf8'))))
  // Catalog discovery may create empty threads. Only sent sessions are chats.
  return values.filter(thread => thread.fixtureProfile === profile && thread.turns.length > 0)
}
async function providerTurns() {
  return (await providerThreads()).flatMap(thread => thread.turns)
}
try {
  // Captured MCP intentionally launches Python with -I. Install the offline
  // source/dependency paths into a disposable venv instead of weakening -I.
  python = execFileSync(python, ['-c', `
import os, sys, venv
from pathlib import Path
root = Path(sys.argv[1]) / 'fixture-python'
venv.EnvBuilder(with_pip=False, symlinks=True).create(root)
site = next(root.glob('lib/python*/site-packages'))
site.joinpath('offline-suite.pth').write_text('\\n'.join(path for path in sys.path if os.path.isabs(path)) + '\\n')
print(root / 'bin/python')
`, work], { env, encoding: 'utf8' }).trim()
  env.AGENTS_PYTHON = python
  env.PATH = [dirname(python), env.PATH].join(delimiter)
  fixture = JSON.parse(execFileSync(python, [resolve(server, 'agent-bridge/tests/fixture.py'), work], { env, encoding: 'utf8' }))
  Object.assign(env, fixture.environment)
  env.AGENT_MANAGER_HOME = fixture.home
  env.AGENT_MANAGER_CONFIG = fixture.config
  const provider = await readFile(resolve(server, 'agent-bridge/tests/app_server_provider.py'), 'utf8')
  await writeFile(resolve(work, 'offline-provider'), provider.replace('#!/usr/bin/env python3', `#!${python}`), { mode: 0o700 })
  await writeFile(resolve(work, 'offline-provider-evidence.json'), JSON.stringify({ directory: env.CHAT_FIXTURE_STATE_DIR }))
  const workAuth = await readFile(resolve(fixture.profiles.work.home, 'auth.json'), 'utf8')
  const reviewAuth = await readFile(resolve(fixture.profiles.review.home, 'auth.json'), 'utf8')
  const budgetsFile = resolve(dirname(fixture.profiles.work.home), 'fixture-budgets.json')
  await writeFile(budgetsFile, JSON.stringify({ [workAuth]: 10, [reviewAuth]: 60 }))
  const carrierPort = await port()
  env.CARRIER_URL = `http://127.0.0.1:${carrierPort}`
  start(python, [resolve(server, 'agent-bridge/tests/chat_carrier.py'), env.CARRIER_DATABASE, String(carrierPort)], work)
  await ready(`${env.CARRIER_URL}/openapi.json`)
  const apiPort = await port(), webPort = await port()
  const origin = `http://127.0.0.1:${webPort}`
  start(resolve(binaries, 'uc-daemon'), [], work)
  await expect.poll(() => spawnSync(resolve(binaries, 'uc'), ['daemon', 'status'], { env, timeout: 2000 }).status, { timeout: 20000 }).toBe(0)
  const main = buildTestServer(server, work)
  const launch = () => start(process.execPath, [main], server, { HOST: '127.0.0.1', PORT: String(apiPort), CORS_ORIGINS: origin })
  backend = launch()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  start(process.execPath, ['scripts/test-vite-live.mjs', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], web, { AIXAND_SERVER_URL: `http://127.0.0.1:${apiPort}` })
  await ready(origin)
  browser = await chromium.launch({ env })
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
  async function checkManagedChatContract(originalUrl) {
    // Managed SDK chats retain their own execution; native terminals are tested
    // separately by test-agents-live.mjs and never share this conversation.
    await authenticateTestPage(page, originalUrl)
    await page.goto(originalUrl)
    await openInfo()
    await expect(page.getByRole('group', { name: 'Conversation terminal', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Spawn terminal', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await send('managed chat follow-up')
    await expect(conversation).toContainText('Reply: managed chat follow-up · done')
    await page.reload()
    await expect(conversation).toContainText('Reply: managed chat follow-up · done')
  }
  await authenticateTestPage(page, `${origin}/#/chat`)
  await page.goto(`${origin}/#/chat`)
  await expect(page.getByRole('button', { name: 'Set up later', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('button')).toHaveCount(0)
  await expect(page.getByRole('button', { name: / Provider$/ })).toContainText('Codex')
  await expect(page.getByRole('button', { name: / Profile$/ })).toContainText('work')
  await connect()
  await expect(page.getByRole('button', { name: / Provider$/ })).toContainText('Codex')
  await expect(page.getByRole('button', { name: / Profile$/ })).toContainText('work')
  await expect(page.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('button')).toHaveCount(0)
  await expect(page.getByLabel('Project directory')).toHaveCount(0)
  const modelPicker = page.getByRole('button', { name: /Model$/ })
  await expect(modelPicker).toBeEnabled()
  await modelPicker.click()
  await page.getByRole('option', { name: /^Fixture Fast/ }).click()
  await expect(modelPicker).toContainText('Fixture Fast')
  await prompt.fill('hello')
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect(conversation).toContainText('Reply: hello · done', { timeout: 20000 })
  await expect(page.getByRole('button', { name: / Profile$/ })).toBeDisabled()
  const firstThread = Object.values(JSON.parse(await readFile(resolve(fixture.profiles.work.home, 'fixture-threads.json'), 'utf8'))).find(thread => thread.turns.some(turn => turn.items.some(item => item.type === 'userMessage' && item.content[0].text === 'hello')))
  expect(firstThread).toBeDefined()
  expect(firstThread.model).toBe('fixture-fast')
  expect(firstThread.sandbox).toBe('workspace-write')
  expect(firstThread.cwd).toBe(work)
  console.log('CHECK: managed initial send, native model and configured workspace passed')
  const scratchFile = resolve(firstThread.cwd, 'scratch-note.txt')
  await expect(page.locator('.command-directory-context')).toHaveCount(0)
  await expect(page.getByRole('button', { name: / Profile$/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await writeFile(budgetsFile, JSON.stringify({ [workAuth]: 95, [reviewAuth]: 10 }))
  await send('follow-up')
  await expect(conversation).toContainText('Reply: follow-up · done')
  expect((await providerTurns()).length).toBe(2)
  expect(await providerThreads('work')).toHaveLength(1)

  await send('streaming probe')
  await expect(conversation).toContainText('Reply: streaming probe')
  await expect(conversation).not.toContainText('Reply: streaming probe · done')
  await expect(conversation).toContainText('Reply: streaming probe · done')
  console.log('CHECK: managed follow-up and incremental browser streaming passed')

  await send('write scratch file')
  await expect(conversation).toContainText('Reply: Saved scratch-note.txt · done')
  expect(await readFile(scratchFile, 'utf8')).toBe("A file generated in this chat's workspace.")

  await send('approve this')
  await expect(page.getByRole('region', { name: 'Agent approval' })).toContainText('echo approved')
  await page.getByRole('button', { name: 'Approve once' }).click()
  await expect(conversation).toContainText('Reply: approved · done')
  await send('ask a question')
  await page.getByRole('button', { name: 'First', exact: true }).click()
  await page.getByRole('button', { name: 'Send answers' }).click()
  await expect(conversation).toContainText('Reply: First · done')

  console.log('CHECK: workspace file, approval and user question passed')
  await send('slow stop')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(async () => (await providerTurns()).at(-1)?.status).toBe('interrupted')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await send('after stop')
  await expect(page.getByRole('button', { name: 'Resume pending messages', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Resume pending messages', exact: true }).click()
  await expect(conversation).toContainText('Reply: after stop · done')

  console.log('CHECK: interrupt and subsequent send passed')
  await page.evaluate(() => { window.dropNextChatSend = true })
  await send('lost response')
  await expect(page.getByRole('button', { name: 'Retry request', exact: true })).toBeVisible({ timeout: 20000 })
  await expect.poll(async () => (await providerTurns()).filter(turn => turn.items.some(item => item.type === 'userMessage' && item.content[0].text === 'lost response')).length).toBe(1)
  await connect()
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect(conversation).toContainText('Reply: lost response · done')
  expect((await providerTurns()).filter((turn) => turn.items.some((item) => item.type === 'userMessage' && item.content[0].text === 'lost response'))).toHaveLength(1)

  console.log('CHECK: lost-response retry without duplicate provider turn passed')
  await send('slow backend restart')
  await expect.poll(async () => {
    const turn = (await providerTurns()).at(-1)
    return turn?.status === 'inProgress' && turn.items.some(item => item.type === 'userMessage' && item.content[0].text === 'slow backend restart')
  }).toBe(true)
  await stop(backend)
  backend = launch()
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  await connect()
  await expect(conversation).toContainText('Reply: slow backend restart · done', { timeout: 20000 })
  expect(await readFile(scratchFile, 'utf8')).toBe("A file generated in this chat's workspace.")
  expect((await providerThreads('work')).map(thread => thread.id)).toEqual([firstThread.id])

  console.log('CHECK: backend restart retained conversation and workspace file')
  const artifacts = resolve(web, 'artifacts/chats-live')
  await mkdir(artifacts, { recursive: true })
  if (managedCore) {
    const originalUrl = page.url()
    await checkManagedChatContract(originalUrl)
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await page.getByRole('button', { name: / Profile$/ }).click()
    await page.getByRole('option', { name: /^review/ }).click()
    await expect(page.getByRole('button', { name: / Profile$/ })).toContainText('review')
    await modelPicker.click()
    await page.getByRole('option', { name: /^Fixture Deep/ }).click()
    await prompt.fill('review profile qualification')
    await page.getByRole('button', { name: 'Start agent', exact: true }).click()
    await expect(conversation).toContainText('Reply: review profile qualification · done')
    const reviewThreads = await providerThreads('review')
    expect(reviewThreads).toHaveLength(1)
    expect(reviewThreads[0]).toMatchObject({ model: 'fixture-deep', cwd: work, sandbox: 'workspace-write', approvalPolicy: 'on-request' })
    expect(reviewThreads[0].id).not.toBe(firstThread.id)
    await page.goto(originalUrl)
    await page.reload()
    await expect(page.getByRole('button', { name: / Profile$/ })).toContainText('work')
    await send('original profile after reload')
    await expect(conversation).toContainText('Reply: original profile after reload · done')
    expect((await providerThreads())[0].id).toBe(firstThread.id)
    expect((await providerTurns()).at(-1).items.some(item => item.type === 'userMessage' && item.content[0].text === 'original profile after reload')).toBe(true)
    expect((await providerThreads('review'))[0].turns).toHaveLength(1)
    console.log('CHECK: explicit review profile/model and original work identity after reload passed')
  } else {
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await expect(page.getByRole('button', { name: / Provider$/ })).toContainText('Codex')
    await expect(page.getByRole('button', { name: / Profile$/ })).toContainText('work')
    await expect(modelPicker).toBeEnabled()
    await page.getByRole('button', { name: / Profile$/ }).click()
    await page.getByRole('option', { name: /^review/ }).click()
    await expect(modelPicker).toContainText('Default')
    await expect(modelPicker).toBeEnabled()
    await modelPicker.click()
    await page.getByRole('option', { name: /^Fixture Deep/ }).click()
    await page.getByRole('button', { name: 'New project', exact: true }).click()
    const projectDialog = page.getByRole('dialog', { name: 'Add projects', exact: true })
    await projectDialog.getByRole('button', { name: 'Edit folder location', exact: true }).click()
    await projectDialog.getByRole('combobox', { name: 'Folder location' }).fill(resolve(work, 'missing-project'))
    await projectDialog.getByRole('combobox', { name: 'Folder location' }).press('Enter')
    await expect(projectDialog.getByRole('combobox', { name: 'Folder location' })).toHaveAttribute('aria-invalid', 'true')
    await projectDialog.getByRole('combobox', { name: 'Folder location' }).fill(work)
    await projectDialog.getByRole('combobox', { name: 'Folder location' }).press('Enter')
    const folderCheckbox = projectDialog.getByRole('checkbox', { name: 'Add this folder', exact: true })
    await expect(folderCheckbox).toBeEnabled()
    await folderCheckbox.focus()
    await page.keyboard.press('Space')
    await expect(folderCheckbox).toBeChecked()
    await projectDialog.getByRole('button', { name: 'Name projects', exact: true }).click()
    await projectDialog.getByRole('textbox', { name: `Project name for ${work}`, exact: true }).fill('Studio website')
    await projectDialog.getByRole('button', { name: 'Save names', exact: true }).click()
    await projectDialog.getByRole('button', { name: 'Add project', exact: true }).click()
    await expect(projectDialog).toHaveCount(0)
    await expect(page.getByLabel('Project directory')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Studio website Project', exact: true })).toBeVisible()
    await prompt.fill('project work')
    await page.getByRole('button', { name: 'Start agent', exact: true }).click()
    await expect(conversation).toContainText('Reply: project work · done')
    await expect(page.getByRole('button', { name: / Profile$/ })).toBeDisabled()
    const threads = (await Promise.all(['work', 'review'].map(async (profile) =>
      providerThreads(profile)))).flat()
    expect(threads.map((thread) => thread.sandbox)).toEqual(['workspace-write', 'workspace-write'])
    expect(threads.map((thread) => thread.model)).toEqual(['fixture-fast', 'fixture-deep'])
    expect(threads.every((thread) => thread.approvalPolicy === 'on-request')).toBe(true)
    expect(threads.map((thread) => thread.cwd)).toEqual([firstThread.cwd, work])
    expect(await providerThreads('work')).toHaveLength(1)
    expect(await providerThreads('review')).toHaveLength(1)

    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await page.getByRole('button', { name: / Profile$/ }).click()
    await page.getByRole('option', { name: /^review/ }).click()
    const selectedProject = page.getByRole('button', { name: / Project$/ })
    if (await selectedProject.count()) {
      await selectedProject.click()
      await page.getByRole('option', { name: /^No project/ }).click()
    }
    await expect(selectedProject).toHaveCount(0)
    await expect(page.locator('.command-directory-context')).toHaveCount(0)
    await prompt.fill('separate scratch chat')
    await page.getByRole('button', { name: 'Start agent', exact: true }).click()
    await expect(conversation).toContainText('Reply: separate scratch chat · done')
    const reviewThreads = await providerThreads('review')
    const separateChat = reviewThreads.find(thread => thread.turns.some(turn => turn.items.some(item => item.type === 'userMessage' && item.content[0].text === 'separate scratch chat')))
    expect(separateChat).toBeDefined()
    expect(separateChat.cwd).toBe(work)
    expect(separateChat.id).not.toBe(firstThread.id)
    // General chats intentionally share the configured workspace, but have distinct sessions.
    expect(await readFile(resolve(separateChat.cwd, 'scratch-note.txt'), 'utf8')).toBe("A file generated in this chat's workspace.")
    console.log('CHECK: folder picker validation/rename, project and separate general session passed')

    await page.reload()
    await connect()
    const projectHistory = page.getByRole('button', { name: 'Studio website, 1 conversation', exact: true })
    await expect(projectHistory).toBeVisible()
    if (await projectHistory.getAttribute('aria-expanded') !== 'true') await projectHistory.click()
    await expect(page.getByRole('region', { name: 'Studio website conversations', exact: true })).toContainText('project work')
    await page.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('button', { name: /^hello/ }).click()
    await expect(modelPicker).toContainText('Fixture Fast')
    await expect(page.getByRole('button', { name: / Profile$/ })).toBeDisabled()
    await expect.poll(async () => {
      if ((await conversation.innerText()).includes('Reply: follow-up · done')) return true
      const older = page.getByRole('button', { name: 'Load older messages', exact: true })
      if (await older.count() && await older.isEnabled()) await older.click()
      return false
    }, { timeout: 15000 }).toBe(true)
    await expect(conversation).toContainText('Reply: follow-up · done')
    await expect(conversation).toContainText('Reply: slow backend restart · done')
    await expect(page.locator('.command-directory-context')).toHaveCount(0)
    expect(await readFile(scratchFile, 'utf8')).toBe("A file generated in this chat's workspace.")
    await expect(page.getByRole('button', { name: / Profile$/ })).toBeDisabled()
    const latest = page.getByRole('button', { name: 'Jump to latest', exact: true })
    if (await latest.count()) await latest.click()
    const receiptRetry = page.getByRole('button', { name: 'Retry request', exact: true })
    if (await receiptRetry.count()) {
      await receiptRetry.click()
      await expect(receiptRetry).toHaveCount(0)
      expect((await providerTurns()).filter(turn => turn.items.some(item => item.type === 'userMessage' && item.content[0].text === 'slow backend restart'))).toHaveLength(1)
    }
    await send('original profile after reload')
    await expect(conversation).toContainText('Reply: original profile after reload · done')
    expect((await providerTurns()).at(-1).items.some((item) => item.type === 'userMessage' && item.content[0].text === 'original profile after reload')).toBe(true)

    console.log('CHECK: paginated history, original profile and restart receipt deduplication passed')
    // Current captured MCP delegation replaces retired dynamic tool launch cards.
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
    const beforeLaunch = (await providerThreads()).length
    await send('launch audit slow parent')
    const recent = page.getByRole('region', { name: 'Recent conversations', exact: true })
    const spawnedHistory = recent.getByRole('list', { name: `Sessions spawned from ${parentTitle}`, exact: true })
    const expandName = `Expand sessions spawned from ${parentTitle}`
    const collapseName = `Collapse sessions spawned from ${parentTitle}`
    await expect(recent.getByRole('button', { name: expandName, exact: true })).toBeVisible({ timeout: 30000 })
    await expect.poll(async () => (await providerThreads()).find(thread => thread.id === firstThread.id)?.mcpCalls?.filter(call => call.name === 'delegate_conversation_task' && !call.expectedError).length, { timeout: 20000 }).toBe(2)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    await expect(observer.getByRole('region', { name: 'Recent conversations', exact: true })).toContainText('Delegated task')
    await expect.poll(() => observer.evaluate(() => window.catalogDelivered === true)).toBe(true)
    await expect(observer.getByRole('region', { name: 'Recent conversations', exact: true })).toContainText('Delegated task')
    await expect(spawnedHistory).toBeHidden()
    await recent.getByRole('button', { name: expandName, exact: true }).click()
    const auditHistory = spawnedHistory.getByRole('button', { name: /^Delegated task/ })
    await expect(auditHistory).toBeVisible()
    const parentHistory = spawnedHistory.locator('..').locator(':scope > .command-history-row > .command-history-item')
    expect((await auditHistory.boundingBox()).x - (await parentHistory.boundingBox()).x).toBeGreaterThanOrEqual(12)
    await expect(parentHistory).toContainText('1 session in this group')
    await page.screenshot({ path: resolve(artifacts, 'sidebar-expanded.png'), fullPage: true })
    await recent.getByRole('button', { name: collapseName, exact: true }).click()
    await expect(spawnedHistory).toBeHidden()
    await recent.getByRole('button', { name: expandName, exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(spawnedHistory).toBeVisible()
    await expect.poll(async () => (await providerThreads()).length).toBe(beforeLaunch + 1)
    const audit = (await providerThreads()).find(thread => thread.config?.['mcp_servers.agent_manager_task_result'])
    expect(audit).toBeDefined()
    expect(audit.cwd).toBe(work)
    expect(audit.sandbox).toBe('workspace-write')
    expect(audit.approvalPolicy).toBe('on-request')
    expect(audit.dynamicTools).toEqual([])
    expect(audit.config['mcp_servers.agent_manager_suite_tools']).toBeUndefined()
    expect(audit.id).not.toBe(firstThread.id)
    await auditHistory.click()
    await expect(conversation).toContainText('slow audit authentication', { timeout: 20000 })
    const auditUrl = page.url()
    await openInfo()
    const parentLink = page.getByRole('group', { name: 'Parent session' }).getByRole('link')
    await expect(parentLink).toHaveText(parentTitle)
    await expect(parentLink).toHaveAttribute('href', new URL(originalUrl).hash)
    await parentLink.click()
    await expect(page).toHaveURL(originalUrl)
    await auditHistory.click()
    await expect(conversation).toContainText(' · done', { timeout: 20000 })
    await expect.poll(async () => (await providerThreads()).find(thread => thread.id === audit.id)?.reported).toBe(true)
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
    await send('audit follow-up')
    await expect(conversation).toContainText('Reply: audit follow-up · done')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Show chat history', exact: true }).click()
    const mobileHistory = page.getByRole('dialog', { name: 'Chat history', exact: true })
    await expect(mobileHistory.getByRole('list', { name: `Sessions spawned from ${parentTitle}`, exact: true })).toBeVisible()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: resolve(artifacts, 'sidebar-mobile.png'), fullPage: true })
    await mobileHistory.getByRole('button', { name: collapseName, exact: true }).click()
    await expect(mobileHistory.getByRole('button', { name: expandName, exact: true })).toHaveAttribute('aria-expanded', 'false')
    await expect(mobileHistory.getByRole('list', { name: `Sessions spawned from ${parentTitle}`, exact: true })).toBeHidden()
    await mobileHistory.getByRole('button', { name: expandName, exact: true }).click()
    await expect(mobileHistory.getByRole('list', { name: `Sessions spawned from ${parentTitle}`, exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 1100 })
    await stop(backend)
    backend = launch()
    await ready(`http://127.0.0.1:${apiPort}/api/health`)
    await page.reload()
    await connect()
    await expect(page).toHaveURL(auditUrl)
    await expect(conversation).toContainText('Reply: audit follow-up · done')
    await openInfo()
    await expect(parentLink).toHaveText(parentTitle)
    await page.keyboard.press('Escape')
    await page.goto(originalUrl)
    await send('inspect audit result')
    const resume = page.getByRole('button', { name: 'Resume pending messages', exact: true })
    await expect(resume).toBeVisible()
    await resume.click()
    await expect(conversation).toContainText('Reply: Canonical audit report accepted · done', { timeout: 20000 })
    const parent = (await providerThreads()).find(thread => thread.id === firstThread.id)
    const launches = parent.mcpCalls.filter(call => call.name === 'delegate_conversation_task' && !call.expectedError)
    expect(launches).toHaveLength(2)
    expect(launches[0].result).toEqual(launches[1].result)
    expect(parent.mcpCalls.find(call => call.expectedError).result.error.code).toBe('validation')
    expect(parent.mcpCalls.find(call => call.name === 'get_delegated_task').result.result.report).toBe('Offline authentication audit completed')
    console.log('CHECK: captured MCP delegation, deduplication, parent stop, canonical Carrier report, sidebar/broadcast/navigation/restart passed')
    await page.goto(auditUrl)
    await send('slow detached follow-up')
    await expect.poll(async () => (await providerThreads()).find(thread => thread.id === audit.id)?.turns.at(-1)?.status).toBe('inProgress')
    await openInfo()
    await expect(observer.getByRole('button', { name: expandName, exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Detach', exact: true }).click()
    try {
      await expect(page.getByRole('group', { name: 'Parent session' })).toHaveCount(0)
    } catch (error) {
      // Keep the original detachment assertion fatal while finishing independent checks.
      workflowFailures.push(error)
      console.error('PRODUCT FAILURE: Detach did not remove the parent relationship.\n' + await page.locator('body').innerText())
    }
    await page.keyboard.press('Escape')
    await expect(conversation).toContainText('Reply: slow detached follow-up · done', { timeout: 20000 })
    if (!workflowFailures.length) {
      await expect(observer.getByRole('button', { name: expandName, exact: true })).toHaveCount(0)
      await expect(observer.getByRole('button', { name: collapseName, exact: true })).toHaveCount(0)
      await expect(recent.getByRole('list', { name: `Sessions spawned from ${parentTitle}`, exact: true })).toHaveCount(0)
      await stop(backend)
      backend = launch()
      await ready(`http://127.0.0.1:${apiPort}/api/health`)
      await page.reload()
      await connect()
      await expect(page).toHaveURL(auditUrl)
      await openInfo()
      await expect(page.getByRole('group', { name: 'Parent session' })).toHaveCount(0)
      await expect(page.locator('.command-chat-context')).toContainText('Independent session')
      await page.keyboard.press('Escape')
      await send('continue independently')
      await expect(conversation).toContainText('Reply: continue independently · done')
      expect((await providerThreads()).find(thread => thread.id === audit.id).turns.at(-1).items.some(item => item.type === 'userMessage' && item.content[0].text === 'continue independently')).toBe(true)
      console.log('CHECK: active-work detach broadcast, original provider execution and detached relation survived restart')
    }
    await observer.close()

    // The current MCP contract rejects detached flags; an explicit independent
    // conversation is created through the ordinary new-chat UI instead.
    const beforeIndependent = (await providerThreads()).map(thread => thread.id)
    await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
    await prompt.fill('independent audit')
    await page.getByRole('button', { name: 'Start agent', exact: true }).click()
    await expect(conversation).toContainText('Reply: independent audit · done')
    const independent = (await providerThreads()).filter(thread => !beforeIndependent.includes(thread.id))
    expect(independent).toHaveLength(1)
    await openInfo()
    await expect(page.getByRole('group', { name: 'Parent session' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    console.log('CHECK: unsupported MCP detached flag rejected without another child; explicit independent conversation passed')
    await checkManagedChatContract(originalUrl)
  }

  await page.setViewportSize({ width: 390, height: 844 })
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token)
  expect(errors).toEqual([])
  await page.screenshot({ path: resolve(artifacts, 'conversation-mobile.png'), fullPage: true })
  if (workflowFailures.length) throw new AggregateError(workflowFailures, 'Full offline chat workflow failed product assertions; other checks continued.')
  await writeFile(resolve(artifacts, managedCore ? 'managed-core-run.json' : 'run.json'), JSON.stringify({ scope: managedCore ? 'Offline managed chat only; project/delegation workflow excluded' : 'Full offline chat workflow', checks: managedCore ? ['explicit Codex provider/work and review profiles', 'native model selection', 'original profile retained after reload', 'configured workspace', 'initial send', 'follow-up', 'incremental browser streaming', 'workspace file', 'approval', 'question', 'interrupt and subsequent send', 'lost-response retry without duplicate', 'backend restart', 'managed follow-up and reload', 'mobile accessibility'] : ['core managed workflow', 'folder picker missing-path validation and project rename', 'project session and history', 'configured workspace with distinct general sessions', 'captured MCP delegation and duplicate operation', 'child inherits captured access/model/workspace', 'child reporter does not inherit parent tools', 'parent Stop preserves child', 'canonical Carrier task report accepted through MCP', 'child broadcast survives delayed catalog in second browser', 'parent navigation', 'sidebar count/indentation/keyboard/persistence', 'child follow-up and backend restart', 'active-work detach broadcasts and survives restart with same native execution', 'mobile sidebar accessibility', 'unsupported detached flag rejected and explicit independent conversation', 'managed follow-up and reload'], runs: runs(), pageErrors: errors }, null, 2))
  console.log(managedCore ? 'Managed chat core qualification passed (offline); project/delegation workflow excluded.' : 'Full offline chat integration passed.')
} catch (error) {
  failed = true
  console.error(error)
  if (browser) console.error(await browser.contexts()[0]?.pages()[0]?.locator('body').innerText().catch(() => 'Page unavailable'))
  if (fixture) for (const profile of Object.values(fixture.profiles)) {
    console.error(await readFile(resolve(profile.home, 'fixture-errors.log'), 'utf8').catch(() => ''))
    console.error('Fixture thread evidence:', await readFile(resolve(profile.home, 'fixture-threads.json'), 'utf8').catch(() => 'unavailable'))
  }
  for (const profile of ['work', 'review']) console.error('Registry evidence:', JSON.stringify(await providerThreads(profile).catch(() => [])))
  console.error('Native fixture state locations:', (await readdir(work, { recursive: true })).filter(path => path.endsWith('fixture-threads.json')))
  for (const log of logs) console.error(log())
} finally {
  await browser?.close()
  spawnSync(resolve(binaries, 'uc'), ['stop', '--all', '--force'], { env, timeout: 10000, stdio: 'ignore' })
  spawnSync(resolve(binaries, 'uc'), ['daemon', 'stop'], { env, timeout: 10000, stdio: 'ignore' })
  for (const child of children.reverse()) await stop(child)
  await rm(work, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
