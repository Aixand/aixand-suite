import { buildTestServer, testAuthEnvironment, authenticateTestPage } from './isolated-test-server.mjs'
// Runs only against a disposable Undercurrent home; never touches existing sessions.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, access, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = resolve(web, '../aixand-server')
const binaries =
  process.env.UNDERCURRENT_BIN_DIR ??
  resolve(web, '../../undercurrent/target/debug')
for (const file of ['uc', 'uc-daemon', 'uc-session-host'])
  await access(resolve(binaries, file))
const work = await mkdtemp(resolve(tmpdir(), 'aixand-live-'))
const token = randomBytes(32).toString('hex')
const env = {
  ...process.env,
  UNDERCURRENT_HOME: resolve(work, 'undercurrent'),
  TERMINAL_CWD: work,
}
const children = []
let browser
let page
const traffic = []
let failed = false
function start(command, args, cwd, extra = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...env, ...testAuthEnvironment(), ...extra },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      logs = (logs + chunk).slice(-8000)
    })
  child.on('error', (error) => {
    logs += error.message
  })
  children.push(child)
  return () => logs
}
async function port() {
  const socket = createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const number = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return number
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
      { timeout: 20_000 }
    )
    .toBe(true)
}
const logs = []
try {
  const backendMain = buildTestServer(server, work)
  const apiPort = await port()
  const webPort = await port()
  const origin = `http://127.0.0.1:${webPort}`
  logs.push(start(resolve(binaries, 'uc-daemon'), [], work))
  await expect
    .poll(
      () =>
        spawnSync(resolve(binaries, 'uc'), ['daemon', 'status'], {
          env,
          timeout: 2000,
        }).status,
      { timeout: 20_000 }
    )
    .toBe(0)
  logs.push(
    start(process.execPath, [backendMain], server, {
      HOST: '127.0.0.1',
      PORT: String(apiPort),
      CORS_ORIGINS: origin,
    })
  )
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  logs.push(
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
      { AIXAND_SERVER_URL: `http://127.0.0.1:${apiPort}` }
    )
  )
  await ready(origin)
  browser = await chromium.launch()
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  })
  const errors = []
  let socketCount = 0
  let lastResize = null
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/api/terminals/ws')) return
    socketCount++
    socket.on('framesent', ({ payload }) => {
      const command = JSON.parse(payload.toString())
      if (command.op === 'resize') lastResize = command.args
    })
    socket.on('framereceived', ({ payload }) => {
      const { type, id, stream, start, offset, message, reason } = JSON.parse(
        payload.toString()
      )
      traffic.push({ type, id, stream, start, offset, message, reason })
      if (traffic.length > 60) traffic.shift()
    })
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols)
        if (new URL(url, location.href).pathname === '/api/terminals/ws')
          window.terminalTestSocket = this
      }
    }
  })
  await authenticateTestPage(page, `${origin}/#/terminals`)
  await page.goto(`${origin}/#/terminals`)
  await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Connected')
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await page.getByLabel('Session name').fill('live-browser-test')
  await page.getByRole('button', { name: 'Create terminal', exact: true }).click()
  await page
    .getByRole('button', { name: /^live-browser-test running/ })
    .waitFor()
  const primary = page.getByRole('region', {
    name: 'Terminal live-browser-test',
    exact: true,
  })
  const output = primary.locator('.xterm-accessibility-tree')
  async function command(text, pane = primary) {
    await expect(pane.locator('.tile-indicator')).toHaveClass(/is-live/)
    await expect(page.getByRole('dialog', { name: 'New terminal', exact: true })).toHaveCount(0)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await pane.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }
  await command("printf '\\n%s%s\\n' AIXAND_ LIVE_OK")
  await expect(output).toContainText('AIXAND_LIVE_OK')
  const myTerminals = page.getByRole('button', { name: 'My terminals', exact: true })
  await expect(myTerminals).toHaveCount(0)
  const beforeMark = JSON.parse(uc('--json', 'inspect', 'live-browser-test'))
  await page.getByRole('button', { name: 'Manage terminal live-browser-test', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add to My terminals', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(myTerminals.locator('.tw-section-count')).toHaveText('1')
  const marked = JSON.parse(uc('--json', 'inspect', 'live-browser-test'))
  expect(marked.summary.id).toBe(beforeMark.summary.id)
  expect(marked.process).toEqual(beforeMark.process)
  expect(marked.configuration.labels).toEqual({ ...beforeMark.configuration.labels, 'aixand.my_terminal': 'true' })
  expect(marked.configuration.metadata).toEqual(beforeMark.configuration.metadata)
  await command("printf '\\n%s%s\\n' MARKED_ STILL_LIVE")
  await expect(output).toContainText('MARKED_STILL_LIVE')
  await page.getByRole('button', { name: 'Toggle terminal inspector' }).click()
  const inspector = page.getByRole('complementary', { name: 'Terminal inspector' })
  await expect(inspector.locator('.inspector-facts')).toContainText('running')
  await inspector.getByRole('button', { name: 'JSON', exact: true }).click()
  await expect(inspector.locator('.inspector-json')).toContainText('environment_variable_names')
  await expect(inspector.locator('.inspector-json')).toContainText('live-browser-test')
  await inspector.getByRole('button', { name: 'Events', exact: true }).click()
  await expect(inspector.locator('.inspector-section')).not.toHaveCount(0)
  await command("printf '\\n%s%s\\n' INSPECTOR_ OPEN_OK")
  await expect(output).toContainText('INSPECTOR_OPEN_OK')
  await expect(inspector.getByRole('alert')).toHaveCount(0)
  await inspector.getByRole('button', { name: 'Close terminal inspector' }).click()
  // A second browser must get an independent SDK identity while the first lives.
  const secondPage = await browser.newPage()
  await authenticateTestPage(secondPage, `${origin}/#/terminals`)
  await secondPage.goto(`${origin}/#/terminals`)
  await expect(
    secondPage.getByRole('button', {
      name: /^live-browser-test running/,
    })
  ).toBeVisible()
  await expect(secondPage.getByRole('button', { name: 'My terminals', exact: true })
    .locator('.tw-section-count')).toHaveText('1')
  await secondPage.close()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() =>
    navigator.clipboard.writeText("printf '\\n%s%s\\n' '你好' '世界'")
  )
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.press('Control+Shift+v')
  await page.keyboard.press('Enter')
  await expect(output).toContainText('你好世界')
  await command('sleep 30')
  await page.keyboard.press('Control+c')
  await command("printf '\\n%s%s\\n' INTERRUPT_ OK")
  await expect(output).toContainText('INTERRUPT_OK')
  // Disconnect while a delayed command is running; resume from the parsed byte cursor.
  for (let round = 1; round <= 3; round++) {
    await command(
      `printf '\\n%s%s\\n' COMMAND_ STARTED${round}; sleep 1; printf '\\n%s%s\\n' DETACHED_ OUTPUT${round}`
    )
    await expect(output).toContainText(`COMMAND_STARTED${round}`)
    await page.evaluate(() => window.terminalTestSocket.close())
    await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Disconnected')
    await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Connected')
    await expect(output).toContainText(`DETACHED_OUTPUT${round}`)
  }
  const originalColumns = lastResize.columns
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.waitForTimeout(300) // ResizeObserver debounce.
  await command("printf 'GEOMETRY:'; stty size")
  await expect(output).toContainText(/GEOMETRY:\d+ \d+/)
  const text = await output.innerText()
  const match = text.match(/GEOMETRY:(\d+) (\d+)/)
  expect(match, text).not.toBeNull()
  expect(Number(match[1])).toBeGreaterThan(0)
  expect(Number(match[2])).toBeLessThan(originalColumns)
  expect(Number(match[2])).toBe(lastResize.columns)
  expect(Number(match[1])).toBe(lastResize.rows)

  // Both panes share one connection, with independent output and geometry.
  const connectionCount = socketCount
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Split right', exact: true }).click()
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await page.getByLabel('Session name').fill('live-second')
  await page.getByRole('button', { name: 'Create terminal', exact: true }).click()
  const second = page.getByRole('region', {
    name: 'Terminal live-second',
    exact: true,
  })
  await expect(second).toBeVisible()
  await command("printf '\\n%s%s\\n' SECOND_ PANE", second)
  await expect(second).toContainText('SECOND_PANE')
  await command("printf '\\n%s%s\\n' FIRST_ PANE")
  await expect(output).toContainText('FIRST_PANE')
  await expect(primary).not.toContainText('SECOND_PANE')
  await expect(second).not.toContainText('FIRST_PANE')
  const divider = page.getByRole('separator', { name: 'Resize columns' })
  const dividerBox = await divider.boundingBox()
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 100)
  await page.mouse.down()
  await page.mouse.move(dividerBox.x + 100, dividerBox.y + 100)
  await page.mouse.up()
  await expect(divider).not.toHaveAttribute('aria-valuenow', '50')
  await page.getByRole('button', { name: 'Maximize pane live-second' }).click()
  await expect(primary).toBeHidden()
  await page.getByRole('button', { name: 'Restore pane layout' }).click()
  await expect(primary).toBeVisible()
  await command(
    "printf '\\n%s%s\\n' BACKGROUND_ STARTED; sleep 1; printf '\\n%s%s\\n' BACKGROUND_ OUTPUT"
  )
  await expect(output).toContainText('BACKGROUND_STARTED')
  await page.getByRole('button', { name: 'New workspace tab' }).click()
  await expect(primary).toBeHidden()
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await page.getByLabel('Session name').fill('live-third')
  await page.getByRole('button', { name: 'Create terminal', exact: true }).click()
  const third = page.getByRole('region', {
    name: 'Terminal live-third',
    exact: true,
  })
  await expect(third).toBeVisible()
  await command("printf '\\n%s%s\\n' THIRD_ PANE", third)
  await expect(third).toContainText('THIRD_PANE')
  await page.getByRole('tab', { name: /Workspace 1/ }).click()
  await expect(output).toContainText('BACKGROUND_OUTPUT')
  await expect(second).toContainText('SECOND_PANE')
  await page.screenshot({ path: '/tmp/aixand-terminals-tiling.png' })
  await page.getByRole('button', { name: 'Close pane live-second' }).click()
  await expect(second).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /^live-second running/ })
  ).toBeVisible()
  await command("printf '\\n%s%s\\n' SURVIVING_ PANE")
  await expect(output).toContainText('SURVIVING_PANE')
  await page.getByRole('tab', { name: /Workspace 2/ }).click()
  await expect(third).toContainText('THIRD_PANE')
  await page
    .getByRole('button', { name: 'Close workspace', exact: true })
    .click()
  await expect(primary).toBeVisible()
  await expect(
    page.getByRole('button', { name: /^live-third running/ })
  ).toBeVisible()
  expect(socketCount).toBe(connectionCount)
  await command('exit')
  await page.getByRole('button', { name: 'Stopped and exited sessions', exact: true }).click({ timeout: 15_000 })
  await expect(
    page.getByRole('button', {
      name: /^live\-browser\-test\ exited\ ·\ exit\ 0/,
    })
  ).toBeVisible({ timeout: 15_000 })

  // Lifecycle controls operate on the same daemon session and reattach its new PTY.
  async function lifecycle(label) {
    await primary.getByRole('button', { name: 'Terminal actions for live-browser-test', exact: true }).click()
    if (label === 'Stop gracefully')
      await page.screenshot({ path: '/tmp/aixand-terminal-lifecycle.png' })
    await page.getByRole('menuitem', { name: label, exact: true }).click()
    await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 15_000 })
  }
  await lifecycle('Restart')
  await expect(page.getByRole('button', { name: /^live-browser-test running/ })).toBeVisible()
  await command("printf '\\n%s%s\\n' RESTARTED_ SHELL")
  await expect(output).toContainText('RESTARTED_SHELL')
  await expect(myTerminals.locator('.tw-section-count')).toHaveText('1')
  const beforeUnmark = JSON.parse(uc('--json', 'inspect', 'live-browser-test'))
  expect(beforeUnmark.configuration.labels['aixand.my_terminal']).toBe('true')
  await page.getByRole('button', { name: 'Manage terminal live-browser-test', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Remove from My terminals', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(myTerminals).toHaveCount(0)
  const unmarked = JSON.parse(uc('--json', 'inspect', 'live-browser-test'))
  expect(unmarked.process).toEqual(beforeUnmark.process)
  expect(unmarked.configuration.labels).toEqual(beforeMark.configuration.labels)
  expect(unmarked.configuration.metadata).toEqual(beforeMark.configuration.metadata)
  console.log('PASS: explicit My terminals marking persists across browsers and session restart; marking/removal preserves process identity, other labels, and private metadata.')
  await lifecycle('Force restart')
  await command("printf '\\n%s%s\\n' FORCE_RESTART_ OK")
  await expect(output).toContainText('FORCE_RESTART_OK')
  await primary.getByRole('button', { name: 'Terminal actions for live-browser-test', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Clear screen', exact: true }).click()
  await expect(output).not.toContainText('FORCE_RESTART_OK')
  await command("printf '\\n%s%s\\n' CLEAR_ STILL_LIVE")
  await expect(output).toContainText('CLEAR_STILL_LIVE')
  await lifecycle('Stop gracefully')
  await expect(page.getByRole('button', { name: /live-browser-test stopped/, exact: false })).toBeVisible()
  await lifecycle('Restart')
  await command("printf '\\n%s%s\\n' RESTART_AFTER_STOP_ OK")
  await expect(output).toContainText('RESTART_AFTER_STOP_OK')
  await lifecycle('Force stop')
  await expect(page.getByRole('button', { name: /live-browser-test stopped/, exact: false })).toBeVisible()
  await lifecycle('Remove')
  await expect(primary).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Manage terminal live-browser-test', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^live-second running/ })).toBeVisible()
  console.log('PASS: real graceful and forced stop, graceful and forced restart, restored PTY input, local screen clear, and removal of a finished session.')

  // Groups share the CLI registry and do not own pane layouts or process lifetimes.
  async function selectGroup(label, value) {
    if (label === 'Filter by group') {
      await page.getByRole('button', { name: /^Filter terminals:/ }).click()
      await page.getByRole('menuitemradio', { name: value, exact: true }).click()
      return
    }
    await page.getByRole('button', { name: new RegExp(label) }).click()
    await page.getByRole('option', { name: value, exact: true }).click()
  }
  function uc(...args) {
    const result = spawnSync(resolve(binaries, 'uc'), args, { env, encoding: 'utf8', timeout: 15_000 })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }
  const shellLabels = { app: 'aixand-suite', feature: 'terminal', 'session.kind': 'shell' }
  expect(JSON.parse(uc('--json', 'ls', '--name', 'live-second', '--projection', 'with-labels')).items[0].labels)
    .toMatchObject(shellLabels)
  await page.getByRole('button', { name: 'Manage groups', exact: true }).click()
  for (const name of ['backend', 'frontend']) {
    await page.getByLabel('Group name', { exact: true }).fill(name)
    await page.getByRole('button', { name: 'Create group', exact: true }).click()
    await expect(page.getByLabel('Group name', { exact: true })).toHaveValue('')
  }
  expect(JSON.parse(uc('--json', 'group', 'ls')).map(group => group.name)).toEqual(['backend', 'frontend'])
  await page.getByRole('button', { name: 'Close dialog' }).click()
  // CLI membership changes appear in the browser through the regular registry refresh.
  uc('group', 'add', 'backend', 'live-third')
  await selectGroup('Filter by group', 'backend · 1')
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await page.getByLabel('Session name').fill('group-live')
  await page.getByRole('button', { name: 'Create terminal', exact: true }).click()
  await expect(page.getByRole('button', { name: /^group\-live\ running/ })).toBeVisible()
  const grouped = page.getByRole('region', { name: 'Terminal group-live', exact: true })
  await command("printf 'GROUP_DIR:'; pwd", grouped)
  await expect(grouped).toContainText(`GROUP_DIR:${work}`)
  const registryPath = resolve(env.UNDERCURRENT_HOME, 'state/group/workspaces.json')
  const { readFile } = await import('node:fs/promises')
  async function registryGroup(name) {
    const registry = JSON.parse(await readFile(registryPath, 'utf8'))
    return Object.values(registry.namespaces)[0][name]
  }
  const saved = (await registryGroup('backend')).members.find(member => member.name === 'group-live')
  expect(saved.restore.slot).toBeTruthy()
  expect(saved.restore.labels).toMatchObject(shellLabels)
  expect(JSON.parse(uc('--json', 'ls', '--name', 'group-live', '--projection', 'with-labels')).items[0].labels)
    .toMatchObject(shellLabels)
  expect(JSON.parse(uc('--json', 'group', 'ls')).map(group => group.name)).toEqual(['backend', 'frontend'])
  await page.getByRole('button', { name: 'Manage terminal group-live', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Group', exact: true }).hover()
  await page.getByRole('menuitemradio', { name: 'frontend', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const moved = (await registryGroup('frontend')).members[0]
  expect(moved.id).toBe(saved.id)
  expect(moved.restore).toEqual(saved.restore)
  await expect(grouped.locator('.tile-group-badge')).toHaveText('frontend')
  await selectGroup('Filter by group', 'frontend · 1')
  await command('exit', grouped)
  await expect(page.getByRole('button', { name: /group-live exited/ })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Terminal options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Clean up finished terminals', exact: true }).click()
  await page.getByRole('button', { name: 'Clean up', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Removed')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('button', { name: /group-live unavailable/ })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Manage terminal group-live', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Restore shell', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^group\-live\ running/ })).toBeVisible()
  await page.getByRole('button', { name: /^group\-live\ running/ }).click()
  const restored = (await registryGroup('frontend')).members[0]
  expect(restored.id).not.toBe(saved.id)
  expect(restored.restore.slot).toBe(saved.restore.slot)
  expect(restored.restore.labels).toMatchObject(shellLabels)
  expect(JSON.parse(uc('--json', 'ls', '--name', 'group-live', '--projection', 'with-labels')).items[0].labels)
    .toMatchObject(shellLabels)
  await command("printf '\\n%s%s\\n' RESTORED_ GROUP", grouped)
  await expect(grouped).toContainText('RESTORED_GROUP')
  await page.screenshot({ path: '/tmp/aixand-groups-desktop.png' })
  await page.getByRole('button', { name: 'Manage groups', exact: true }).click()
  await page.getByRole('button', { name: 'Delete group frontend', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Delete group frontend', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByRole('button', { name: /^group\-live\ running/ })).toBeVisible()
  await expect(grouped.locator('.tile-group-badge')).toHaveCount(0)
  await command("printf '\\n%s%s\\n' AFTER_DELETE_ RUNNING", grouped)
  await expect(grouped).toContainText('AFTER_DELETE_RUNNING')
  console.log('PASS: real shared group registry, external CLI changes, group defaults, atomic moves, retained missing slots, explicit restoration, and deletion without stopping shells.')
  expect(errors).toEqual([])
  console.log(
    'PASS: real PTYs, UTF-8 paste, Ctrl-C, reconnect, multiple live panes on one WebSocket, resizing, background tabs, maximize, independent pane close, and shell exit.'
  )
} catch (error) {
  failed = true
  console.error(
    'Terminal alerts:',
    await page?.getByRole('alert').allTextContents()
  )
  console.error('Recent transport events:', traffic)
  console.error(logs.map((read) => read()).join('\n'))
  throw error
} finally {
  await browser?.close()
  // These CLI actions address only the newly created test home.
  spawnSync(resolve(binaries, 'uc'), ['stop', '--all', '--force'], {
    env,
    timeout: 15_000,
  })
  spawnSync(resolve(binaries, 'uc'), ['daemon', 'stop'], {
    env,
    timeout: 15_000,
  })
  for (const child of children.reverse()) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      /* already stopped */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* already stopped */
    }
  }
  if (failed) console.error(`Disposable test home retained: ${work}`)
  else await rm(work, { recursive: true, force: true })
}
