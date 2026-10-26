import { expect, test, type Page, type WebSocketRoute } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { ChatSnapshot } from '../src/chats/model'

const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

async function existingChat(page: Page, failInitialOpen = false) {
  const chat: ChatSnapshot = {
    id: chatId, provider: 'codex', profile: 'work', auth: null, cwd: '/workspace', project: '', mode: 'chat',
    title: 'Existing conversation', status: 'completed', turnId: 'original-turn', createdAt: 1, updatedAt: 2, revision: 1,
    items: [{ id: 'original-message', type: 'userMessage', text: 'Original message', turnId: 'original-turn' }], requests: [],
  }
  const operations: { op: string; args: Record<string, unknown> }[] = []
  let socket: WebSocketRoute
  let recoveredStatus = 'completed'
  let failOpen = failInitialOpen
  let failedOpensRemaining = 0
  let serverEnded = false
  let interruptedByRestart = true
  let loseSendResponse = false
  const delivered = new Set<string>()
  await page.routeWebSocket('**/api/carrier/ws', (route) => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    socket = route
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw))
      operations.push(command)
      if (command.op === 'chat-open' && serverEnded) {
        serverEnded = false
        chat.status = interruptedByRestart ? 'interrupted' : 'completed'
        chat.statusReason = null
        chat.error = null
        chat.sessionRecovery = null
        if (interruptedByRestart) chat.interruptedTurn = { id: chat.turnId!, reason: 'runtime_ended' }
        chat.revision++
        route.send(JSON.stringify({ type: 'chat-updated', chat }))
        route.send(JSON.stringify({ type: 'result', id: command.id, result: chat }))
        return
      }
      if (command.op === 'chat-open' && (failOpen || failedOpensRemaining > 0)) {
        failedOpensRemaining--
        route.send(JSON.stringify({ type: 'error', id: command.id, code: 'manager', message: 'Agent server unavailable' }))
        return
      }
      if (command.op === 'chat-open' && ['offline', 'uncertain'].includes(chat.status)) {
        chat.status = recoveredStatus
        chat.statusReason = null
        chat.error = null
        chat.turnId = 'recovered-turn'
        chat.revision++
      }
      if (['chat-send', 'chat-steer', 'chat-queue'].includes(command.op)) {
        if (!delivered.has(command.args.key)) {
          delivered.add(command.args.key)
          chat.items.push({ id: command.args.key, type: 'userMessage', text: command.args.text })
          chat.status = 'completed'
          delete chat.interruptedTurn
          chat.revision++
        }
        if (loseSendResponse) {
          loseSendResponse = false
          route.send(JSON.stringify({ type: 'error', id: command.id, code: 'connection_lost', message: 'Response interrupted' }))
          return
        }
      }
      const result = command.op === 'catalog' ? { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: chat.cwd } :
        command.op === 'mcp-catalog' ? { servers: [] } : command.op === 'sessions' ? { runs: [], runtimeError: null } :
        command.op === 'project-discovery-list' ? { jobs: [], nextOffset: null } : command.op === 'chat-workflow-runs' ? { runs: [], nextOffset: null } :
        command.op === 'chat-list' ? [chat] : ['chat-open', 'chat-send', 'chat-steer', 'chat-queue'].includes(command.op) ? chat : []
      route.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto(`/#/chat/${chatId}`)
  if (!failInitialOpen) await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('Original message')
  return {
    chat, operations,
    offline(status = 'completed', uncertain = false) {
      recoveredStatus = status
      chat.status = uncertain ? 'uncertain' : 'offline'
      socket.send(JSON.stringify({ type: 'chat-event', chatId, revision: ++chat.revision, event: { kind: 'status', status: chat.status } }))
    },
    disconnect() { socket.close({ code: 1001, reason: 'Connection dropped' }) },
    failRecovery() { failOpen = true },
    failOpens(count: number) { failedOpensRemaining = count },
    allowRecovery() { failOpen = false; failedOpensRemaining = 0 },
    endServer(interrupted = true) { serverEnded = true; interruptedByRestart = interrupted },
    loseResponse() { loseSendResponse = true },
    loseChatConnection() {
      chat.status = 'offline'
      chat.statusReason = 'connection_lost'
      chat.error = 'The chat connection heartbeat timed out.'
      socket.send(JSON.stringify({ type: 'chat-event', chatId, revision: ++chat.revision,
        event: { kind: 'status', status: chat.status, statusReason: chat.statusReason, error: chat.error } }))
    },
    resumeProgress() {
      failOpen = false
      chat.status = 'running'
      chat.statusReason = null
      chat.error = null
      socket.send(JSON.stringify({ type: 'chat-updated', chat: { ...chat, revision: ++chat.revision } }))
      socket.send(JSON.stringify({ type: 'chat-event', chatId, revision: ++chat.revision,
        event: { kind: 'status', status: 'running', statusReason: null, error: null } }))
      socket.send(JSON.stringify({ type: 'chat-event', chatId, revision: ++chat.revision,
        event: { kind: 'delta', itemId: 'live-progress', itemType: 'agentMessage', turnId: chat.turnId, text: 'The same worker is still making progress.' } }))
    },
  }
}

test('transport loss reconnects quietly and fresh progress cancels retries without another turn', async ({ page }) => {
  await page.clock.install()
  const fixture = await existingChat(page)
  await page.clock.pauseAt(new Date())
  const before = fixture.operations.filter(row => row.op === 'chat-open').length
  fixture.loseChatConnection()
  const recovery = page.getByRole('group', { name: 'Chat connection' })
  await expect(recovery).toContainText('Reconnecting…')
  await expect(recovery.getByRole('alert')).toHaveCount(0)
  fixture.resumeProgress()
  await expect(recovery).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'Conversation status', exact: true })).toHaveText('Working')
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('still making progress')
  await page.clock.runFor(10000)
  expect(fixture.operations.filter(row => row.op === 'chat-open')).toHaveLength(before)
  expect(fixture.operations.filter(row => ['chat-create', 'chat-send', 'chat-steer', 'chat-queue'].includes(row.op))).toHaveLength(0)
})

test('new healthy progress clears an earlier failed-open banner and its stale notice', async ({ page }) => {
  const fixture = await existingChat(page, true)
  await expect(page.getByRole('group', { name: 'Chat connection' })).toContainText('Reconnecting…')
  await expect(page.locator('.command-notice')).not.toContainText('Agent server unavailable')
  fixture.resumeProgress()
  await expect(page.getByRole('group', { name: 'Chat connection' })).toHaveCount(0)
  await expect(page.locator('.command-notice')).not.toContainText('Agent server unavailable')
  await expect(page.getByRole('status', { name: 'Conversation status', exact: true })).toHaveText('Working')
})

test('Send restores an offline existing chat without a Resume button and sends once', async ({ page }) => {
  const fixture = await existingChat(page)
  fixture.offline()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Continue the conversation')
  await expect(page.getByRole('group', { name: 'Chat connection' })).toContainText('Reconnecting…')
  await expect(page.getByRole('button', { name: 'Resume conversation', exact: true })).toHaveCount(0)
  const before = fixture.operations.length
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(input).toHaveValue('')
  expect(fixture.operations.slice(before).filter((op) => ['chat-open', 'chat-send'].includes(op.op)).map((op) => op.op)).toEqual(['chat-open', 'chat-send'])
  expect(fixture.operations.filter((op) => op.op === 'chat-send')).toHaveLength(1)
  expect(fixture.operations.filter((op) => op.op === 'chat-create')).toHaveLength(0)
})

test('Enter uses the recovered active turn rather than a stale turn ID', async ({ page }) => {
  const fixture = await existingChat(page)
  fixture.offline('running')
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Focus on the tests')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  expect(fixture.operations.find((op) => op.op === 'chat-steer')?.args).toMatchObject({ chatId, expectedTurnId: 'recovered-turn', text: 'Focus on the tests' })
  expect(fixture.operations.filter((op) => op.op === 'chat-send')).toHaveLength(0)
})

test('Send waits for the browser connection to recover and retains the existing chat', async ({ page }) => {
  const fixture = await existingChat(page)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Send after reconnecting')
  fixture.disconnect()
  await expect(page.locator('.command-workspace-connection')).toBeVisible()
  await expect(page.getByRole('status', { name: 'Conversation status', exact: true })).toHaveText('Disconnected')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByRole('status', { name: 'Conversation status', exact: true })).toHaveText('Done')
  expect(fixture.operations.filter((op) => op.op === 'chat-send')).toHaveLength(1)
  expect(fixture.operations.find((op) => op.op === 'chat-send')?.args.chatId).toBe(chatId)
  expect(fixture.operations.filter((op) => op.op === 'chat-create')).toHaveLength(0)
})

test('failed recovery keeps the draft editable and does not submit a message', async ({ page }) => {
  const fixture = await existingChat(page)
  fixture.offline()
  fixture.failRecovery()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep this draft')
  await input.press('Enter')
  await expect(page.locator('.command-notice')).toContainText('Agent server unavailable')
  await expect(input).toHaveValue('Keep this draft')
  await expect(input).not.toHaveAttribute('readonly', '')
  expect(fixture.operations.filter((op) => ['chat-send', 'chat-steer', 'chat-queue'].includes(op.op))).toHaveLength(0)
})

test('an unresolved uncertain state is inspected before sending a new message', async ({ page }) => {
  const fixture = await existingChat(page)
  fixture.offline('uncertain', true)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('New instruction')
  await expect(page.getByRole('status', { name: 'Conversation status', exact: true })).toHaveText('Status unknown')
  await input.press('Enter')
  await expect(page.locator('.command-notice')).toContainText('Could not confirm')
  await expect(input).toHaveValue('New instruction')
  expect(fixture.operations.filter((op) => ['chat-send', 'chat-steer', 'chat-queue'].includes(op.op))).toHaveLength(0)
})

test('opening after server loss restores the saved conversation and keeps the draft without replay', async ({ page }) => {
  const fixture = await existingChat(page)
  const status = page.getByRole('status', { name: 'Conversation status', exact: true })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep my next instruction')
  fixture.endServer()
  fixture.offline()
  await expect(status).toHaveText('Stopped')
  await expect(page.getByRole('group', { name: 'Chat connection' })).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'Previous task interrupted' })).toContainText('continue here')
  await expect(page.getByText('This managed app-server has finished', { exact: true })).toHaveCount(0)
  await expect(input).toHaveValue('Keep my next instruction')
  await expect(status.locator('.chat-status-indicator')).toHaveCount(0)
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('Original message')
  await page.reload()
  await expect(status).toHaveText('Stopped')
  expect(fixture.operations.filter((op) => ['chat-send', 'chat-steer', 'chat-create'].includes(op.op))).toHaveLength(0)
  await input.fill('My next explicit task')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(status).toHaveText('Done')
  await expect(page.getByRole('status', { name: 'Previous task interrupted' })).toHaveCount(0)
  expect(fixture.operations.filter((op) => op.op === 'chat-send')).toHaveLength(1)
})

test('inspecting a lost send response restores history without submitting the request again', async ({ page }) => {
  const fixture = await existingChat(page)
  fixture.loseResponse()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Inspect this request')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const status = page.getByRole('status', { name: 'Conversation status', exact: true })
  await expect(status).toHaveText('Status unknown')
  fixture.endServer(false)
  await page.getByRole('button', { name: 'Inspect outcome', exact: true }).click()
  await expect(status).toHaveText('Status unknown')
  await expect(page.getByText('This managed app-server has finished', { exact: true })).toHaveCount(0)
  expect(fixture.operations.filter((op) => op.op === 'chat-send')).toHaveLength(1)
})

test('retry after reconnecting reuses the original request and delivers only one message', async ({ page }) => {
  const fixture = await existingChat(page)
  fixture.loseResponse()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Deliver exactly once')
  await input.press('Enter')
  await expect(page.getByRole('button', { name: 'Retry request', exact: true })).toBeVisible()
  fixture.offline('completed', true)
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect(input).toHaveValue('')
  const attempts = fixture.operations.filter((op) => op.op === 'chat-send')
  expect(attempts).toHaveLength(2)
  expect(attempts[1].args).toEqual(attempts[0].args)
  expect(fixture.chat.items.filter((item) => item.text === 'Deliver exactly once')).toHaveLength(1)
})

test('three failed retries show one warning at the top, and manual retry recovers without sending', async ({ page }, testInfo) => {
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  const fixture = await existingChat(page, true)
  const banner = page.getByRole('group', { name: 'Chat connection' })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await expect(banner).toContainText('Attempt 1 of 3')
  await input.fill('Keep this draft through recovery')
  expect(fixture.operations.filter(row => row.op === 'chat-open')).toHaveLength(1)
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    await expect(banner.getByRole('alert')).toHaveCount(0)
    await expect(banner.getByRole('button', { name: 'Retry chat connection' })).toHaveCount(0)
    await page.clock.runFor(delay)
    await expect.poll(() => fixture.operations.filter(row => row.op === 'chat-open').length).toBe(index + 2)
  }
  await expect(banner.getByRole('alert')).toHaveText('Chat connection unavailable.')
  await expect(banner).toContainText('after 3 attempts')
  await expect(page.locator('.command-compose-area .chat-connection-notice')).toHaveCount(0)
  expect((await banner.boundingBox())!.y).toBeLessThan((await input.boundingBox())!.y)
  await expect(page.locator('.command-notice')).not.toContainText('Agent server unavailable')
  await banner.getByText('Connection details', { exact: true }).click()
  await expect(banner).toContainText('Agent server unavailable')
  await page.clock.runFor(60000)
  expect(fixture.operations.filter(row => row.op === 'chat-open')).toHaveLength(4)
  await expect(page.getByRole('dialog', { name: 'Recover a chat' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('chat-connection-warning.png') })
  fixture.allowRecovery()
  await banner.getByRole('button', { name: 'Retry chat connection' }).click()
  await page.clock.runFor(1000)
  await expect(banner).toHaveCount(0)
  await expect(input).toHaveValue('Keep this draft through recovery')
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('Original message')
  expect(fixture.operations.filter(row => ['chat-create', 'chat-send', 'chat-steer', 'chat-queue', 'chat-backend-resume'].includes(row.op))).toHaveLength(0)
})

test('the third retry can recover a chat without ever showing a warning or losing its draft', async ({ page }) => {
  await page.clock.install()
  const fixture = await existingChat(page)
  await page.clock.pauseAt(new Date())
  fixture.failOpens(2)
  fixture.loseChatConnection()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep the existing conversation')
  const before = fixture.operations.filter(row => row.op === 'chat-open').length
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    await expect(page.getByRole('group', { name: 'Chat connection' }).getByRole('alert')).toHaveCount(0)
    await page.clock.runFor(delay)
    await expect.poll(() => fixture.operations.filter(row => row.op === 'chat-open').length).toBe(before + index + 1)
  }
  await expect(page.getByRole('group', { name: 'Chat connection' })).toHaveCount(0)
  await expect(input).toHaveValue('Keep the existing conversation')
  expect(fixture.operations.filter(row => ['chat-create', 'chat-send', 'chat-steer', 'chat-queue'].includes(row.op))).toHaveLength(0)
})

test('leaving a disconnected chat cancels its pending automatic retry', async ({ page }) => {
  await page.clock.install()
  const fixture = await existingChat(page)
  await page.clock.pauseAt(new Date())
  fixture.failRecovery()
  fixture.loseChatConnection()
  await expect(page.getByRole('group', { name: 'Chat connection' })).toContainText('Attempt 1 of 3')
  const before = fixture.operations.filter(row => row.op === 'chat-open').length
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await page.clock.runFor(60000)
  expect(fixture.operations.filter(row => row.op === 'chat-open')).toHaveLength(before)
  await expect(page.getByRole('group', { name: 'Chat connection' })).toHaveCount(0)
})

test('the top warning stays accessible on a narrow screen in dark mode', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('aixand.appearance', 'dark'))
  await page.clock.install()
  const fixture = await existingChat(page)
  await page.clock.pauseAt(new Date())
  fixture.failRecovery()
  fixture.loseChatConnection()
  const banner = page.getByRole('group', { name: 'Chat connection' })
  await expect(banner).toContainText('Attempt 1 of 3')
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    await page.clock.runFor(delay)
    await expect(banner).toContainText(index < 2 ? `Attempt ${index + 2} of 3` : 'Chat connection unavailable.')
  }
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('Original message')
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('My draft is still editable')
  await expect(input).toHaveValue('My draft is still editable')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('chat-connection-warning-mobile-dark.png') })
  await page.clock.resume()
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
})
