import { openComposerNotices, openChatSettings, setChatMessageTiming, expect, test, type Page, type WebSocketRoute } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { ChatSnapshot } from '../src/chats/model'

const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
async function runningChat(page: Page, sdk = false, steering = false) {
  const chat: ChatSnapshot = {
    id: chatId, provider: 'codex', profile: 'work', auth: null, cwd: '/workspace', project: '', mode: 'chat',
    title: 'Investigate the chat', status: 'running', turnId: 'original-turn', createdAt: 1, updatedAt: 2, revision: 1,
    items: [{ id: 'original-message', type: 'userMessage', text: 'Investigate the chat' }], requests: [],
    queue: { paused: false, reason: null, messages: [] },
    ...(sdk ? { provider: 'claude', backend: 'claude-sdk', backendRoute: 'managed', chatCapabilities: { queue: true, steer: steering, workflows: true } } : {}),
  }
  const operations: { op: string; args: Record<string, unknown> }[] = []
  let socket: WebSocketRoute
  let rejectNextEdit = false
  let rejectNextQueue = false
  let holdNext = false
  let acknowledge: (() => void) | undefined
  await page.routeWebSocket('**/api/carrier/ws', (route) => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    socket = route
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw))
      operations.push(command)
      const args = command.args ?? {}
      if (command.op === 'chat-queue' && rejectNextQueue) {
        rejectNextQueue = false
        route.send(JSON.stringify({ type: 'error', id: command.id, code: 'manager', message: 'This conversation already has 20 queued messages' }))
        return
      }
      if (command.op === 'chat-queue-edit' && rejectNextEdit) {
        rejectNextEdit = false
        route.send(JSON.stringify({ type: 'error', id: command.id, code: 'manager', message: 'This queued message changed. Review it before trying again.' }))
        return
      }
      if (command.op === 'chat-queue') chat.queue!.messages.push({ id: args.key, text: args.text, revision: 1, status: 'queued', createdAt: 3 })
      if (command.op === 'chat-queue-edit') chat.queue!.messages = chat.queue!.messages.map((message) => message.id === args.messageId ? { ...message, text: args.text, revision: message.revision + 1 } : message)
      if (command.op === 'chat-queue-remove') chat.queue!.messages = chat.queue!.messages.filter((message) => message.id !== args.messageId)
      if (command.op === 'chat-queue-resume') chat.queue!.paused = false
      if (command.op === 'chat-interrupt') { chat.status = 'interrupted'; chat.queue!.paused = true; chat.queue!.reason = 'Queue paused because you pressed Stop.' }
      if (command.op === 'chat-steer') chat.items.push({ id: args.key, type: 'userMessage', text: args.text })
      if (['chat-queue', 'chat-queue-edit', 'chat-queue-remove', 'chat-queue-resume', 'chat-interrupt', 'chat-steer'].includes(command.op)) {
        chat.revision++
        route.send(JSON.stringify({ type: 'chat-event', chatId, revision: chat.revision, event: { kind: 'queue', queue: chat.queue } }))
        if (command.op === 'chat-interrupt') route.send(JSON.stringify({ type: 'chat-event', chatId, revision: ++chat.revision, event: { kind: 'status', status: chat.status } }))
      }
      const result = command.op === 'catalog' ? { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: chat.cwd } :
        command.op === 'mcp-catalog' ? { servers: [] } : command.op === 'chat-workflow-runs' ? { workflows: [], nextOffset: null } :
          command.op === 'chat-list' ? [chat] : command.op === 'chat-open' || ['chat-steer', 'chat-queue', 'chat-queue-edit', 'chat-queue-remove', 'chat-queue-resume'].includes(command.op) ? chat :
            ['models', 'sessions', 'project-list', 'chat-launches', 'mcp-jobs'].includes(command.op) ? [] : {}
      const reply = () => route.send(JSON.stringify({ type: 'result', id: command.id, result }))
      if (holdNext && ['chat-send', 'chat-steer', 'chat-queue'].includes(command.op)) { holdNext = false; acknowledge = reply }
      else reply()
    })
  })
  await page.goto(`/#/chat/${chatId}`)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  return {
    chat, operations, hold() { holdNext = true }, acknowledge() { acknowledge?.(); acknowledge = undefined },
    rejectEdit() { rejectNextEdit = true }, rejectQueue() { rejectNextQueue = true },
    emitQueue() { socket.send(JSON.stringify({ type: 'chat-event', chatId, revision: ++chat.revision, event: { kind: 'queue', queue: chat.queue } })) },
    finishTurn() {
      chat.status = 'completed'
      socket.send(JSON.stringify({ type: 'chat-event', chatId, revision: ++chat.revision, event: { kind: 'status', status: chat.status } }))
    },
  }
}

test('composer switches between Stop and Send as the draft changes', async ({ page }) => {
  const fixture = await runningChat(page)
  const composer = page.locator('form.command-composer')
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await expect(composer.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
  await input.fill('A follow-up instruction')
  await expect(composer.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(composer.getByRole('button', { name: 'Add to current turn', exact: true })).toBeEnabled()
  await input.fill('   ')
  await expect(composer.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
  await input.press('Enter')
  expect(fixture.operations.filter(row => row.op === 'chat-interrupt')).toHaveLength(0)
  await composer.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => fixture.operations.filter(row => row.op === 'chat-interrupt').length).toBe(1)
  expect(fixture.operations.find(row => row.op === 'chat-interrupt')?.args).toMatchObject({ chatId, expectedTurnId: 'original-turn' })
  await expect(composer.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
})

test('multiple SDK follow-ups stay separate while acknowledgements are pending', async ({ page }) => {
  const fixture = await runningChat(page, true, true)
  fixture.hold()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('First correction'); await input.press('Enter')
  await expect(input).toHaveValue('')
  await input.fill('Second correction'); await input.press('Enter')
  await input.fill('Still composing a third message')
  await expect(page.getByRole('region', { name: 'Pending messages' })).toContainText('Second correction')
  expect(fixture.operations.filter(row => row.op === 'chat-steer')).toHaveLength(1)
  fixture.acknowledge()
  await expect.poll(() => fixture.operations.filter(row => row.op === 'chat-steer').length).toBe(2)
  await expect(input).toHaveValue('Still composing a third message')
  await expect(page.getByRole('region', { name: 'Pending messages' })).toHaveCount(0)
  const sends = fixture.operations.filter(row => row.op === 'chat-steer')
  expect(sends.map(row => row.args.text)).toEqual(['First correction', 'Second correction'])
  expect(sends[0].args.key).not.toBe(sends[1].args.key)
})

test('reload preserves an unacknowledged request without automatically resending', async ({ page }) => {
  const fixture = await runningChat(page, true, true)
  fixture.hold()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep this delivery identity'); await input.press('Enter')
  await expect.poll(() => fixture.operations.filter(row => row.op === 'chat-steer').length).toBe(1)
  const original = fixture.operations.find(row => row.op === 'chat-steer')!
  await page.reload()
  const pending = page.getByRole('region', { name: 'Pending messages' })
  await expect(pending).toContainText('Keep this delivery identity')
  expect(fixture.operations.filter(row => row.op === 'chat-steer')).toHaveLength(1)
  await pending.getByRole('button', { name: 'Retry request' }).click()
  await expect(pending).toHaveCount(0)
  expect(fixture.operations.filter(row => row.op === 'chat-steer')[1].args).toEqual(original.args)
})

test('Stop holds browser-pending messages until an explicit resume', async ({ page }) => {
  const fixture = await runningChat(page, true, true)
  fixture.hold()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('First correction'); await input.press('Enter')
  await input.fill('Keep this for later'); await input.press('Enter')
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  fixture.acknowledge()
  const pending = page.getByRole('region', { name: 'Pending messages' })
  await expect(pending).toContainText('paused after Stop')
  expect(fixture.operations.filter(row => row.op === 'chat-steer')).toHaveLength(1)
  expect(fixture.operations.filter(row => row.op === 'chat-send')).toHaveLength(0)
})

test('Enter adds context to the active turn while keeping Stop available', async ({ page }) => {
  const fixture = await runningChat(page)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Focus on the mobile composer')
  await expect(page.getByRole('button', { name: 'Add to current turn', exact: true })).toBeEnabled()
  await input.press('Enter')
  await expect(input).toHaveValue('')
  expect(fixture.operations.find((command) => command.op === 'chat-steer')?.args).toMatchObject({ chatId, expectedTurnId: 'original-turn', text: 'Focus on the mobile composer' })
  expect(fixture.operations.filter((command) => command.op === 'chat-send')).toHaveLength(0)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
})

test('SDK active turns queue input and never offer same-turn steering', async ({ page }) => {
  const fixture = await runningChat(page, true)
  const settings = await openChatSettings(page)
  const timing = settings.getByRole('button', { name: / Message timing$/ })
  await expect(timing).toContainText('Send after this turn')
  await timing.click()
  await expect(page.getByRole('option', { name: /^Add to current turn/ })).toHaveCount(0)
  await expect(page.getByRole('option', { name: /^Send after this turn/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(timing).toBeFocused()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Run this after completion')
  await input.press('Enter')
  await expect(page.getByRole('region', { name: 'Queued messages', exact: true })).toContainText('Run this after completion')
  expect(fixture.operations.some((row) => row.op === 'chat-steer')).toBe(false)
  expect(fixture.operations.filter((row) => row.op === 'chat-queue')).toHaveLength(1)
})

test('queued messages stay outside the active transcript and can be edited, refreshed, and removed', async ({ page }) => {
  const fixture = await runningChat(page)
  await setChatMessageTiming(page, 'queue')
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Review the tests afterward')
  await input.press('Enter')
  const queue = page.getByRole('region', { name: 'Queued messages', exact: true })
  await expect(queue).toContainText('Review the tests afterward')
  await expect(page.getByRole('log', { name: 'Conversation messages' })).not.toContainText('Review the tests afterward')
  await queue.getByRole('button', { name: 'Edit queued message', exact: true }).click()
  await queue.getByRole('textbox', { name: 'Edit queued message', exact: true }).fill('Review only the mobile tests')
  await queue.getByRole('button', { name: 'Save message', exact: true }).click()
  await expect(queue).toContainText('Review only the mobile tests')
  await page.reload()
  await expect(queue).toContainText('Review only the mobile tests')
  await queue.getByRole('button', { name: 'Remove queued message', exact: true }).click()
  await expect(queue).toHaveCount(0)
  expect(fixture.operations.find((command) => command.op === 'chat-queue-remove')?.args.expectedRevision).toBe(2)
})

test('Stop pauses retained messages and the queue resumes only on request', async ({ page }) => {
  const fixture = await runningChat(page)
  await setChatMessageTiming(page, 'queue')
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('A later task')
  await page.getByRole('button', { name: 'Send after this turn', exact: true }).click()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  const queue = page.getByRole('region', { name: 'Queued messages', exact: true })
  await expect(queue).toContainText('Queue paused')
  expect(fixture.operations.filter((command) => command.op === 'chat-queue-resume')).toHaveLength(0)
  await queue.getByRole('button', { name: 'Resume queue', exact: true }).click()
  await expect(queue).not.toContainText('Queue paused')
  expect(fixture.operations.filter((command) => command.op === 'chat-queue-resume')).toHaveLength(1)
})

test('a rejected queue request preserves an editable draft', async ({ page }) => {
  const fixture = await runningChat(page)
  await setChatMessageTiming(page, 'queue')
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Another task')
  fixture.rejectQueue()
  await input.press('Enter')
  await openComposerNotices(page)
  await expect(page.locator('.command-composer-status').getByRole('alert').filter({ hasText: 'already has 20 queued messages' })).toBeVisible()
  await expect(input).toHaveValue('Another task')
  await expect(input).not.toHaveAttribute('readonly', '')
  await input.fill('A shorter task')
  await input.press('Enter')
  await expect(page.getByRole('region', { name: 'Queued messages', exact: true })).toContainText('A shorter task')
})

test('failed queue edits retain their retry key and can be dismissed to review the current message', async ({ page }) => {
  const fixture = await runningChat(page)
  fixture.chat.queue!.messages.push({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', text: 'A queued task', status: 'queued', revision: 1, createdAt: 3 })
  fixture.emitQueue()
  const queue = page.getByRole('region', { name: 'Queued messages', exact: true })
  await queue.getByRole('button', { name: 'Edit queued message', exact: true }).click()
  await queue.getByRole('textbox', { name: 'Edit queued message', exact: true }).fill('Revised task')
  fixture.rejectEdit()
  await queue.getByRole('button', { name: 'Save message', exact: true }).click()
  await expect(queue.getByRole('alert')).toContainText('changed')
  await queue.getByRole('button', { name: 'Retry queue update', exact: true }).click()
  await expect(queue).toContainText('Revised task')
  const edits = fixture.operations.filter((command) => command.op === 'chat-queue-edit')
  expect(edits[0].args.key).toBe(edits[1].args.key)
})

test('message timing supports keyboard selection without sending or losing the draft', async ({ page }) => {
  const fixture = await runningChat(page)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep these instructions while choosing when to send')
  const timing = page.locator('.command-composer-options').getByRole('button', { name: / Message timing$/ })
  await timing.focus()
  await timing.press('ArrowDown')
  await expect(page.getByRole('option', { name: /^Add to current turn/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(timing).toContainText('Send after this turn')
  await expect(timing).toBeFocused()
  await expect(input).toHaveValue('Keep these instructions while choosing when to send')
  await expect(page.getByRole('button', { name: 'Send after this turn', exact: true })).toBeEnabled()
  const settings = await openChatSettings(page)
  await settings.getByRole('button', { name: / Message timing$/ }).click()
  await expect(page.getByRole('option', { name: /^Send after this turn/ })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('option', { name: /^Add to current turn/ }).click()
  await expect(settings).not.toBeVisible()
  await expect(timing).toContainText('Add to current turn')
  await expect(input).toHaveValue('Keep these instructions while choosing when to send')
  expect(fixture.operations.filter(row => ['chat-send', 'chat-steer', 'chat-queue'].includes(row.op))).toHaveLength(0)
})

test('message timing says Send now after the active turn finishes with messages still queued', async ({ page }) => {
  const fixture = await runningChat(page)
  fixture.chat.queue!.messages.push({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', text: 'A queued task', status: 'queued', revision: 1, createdAt: 3 })
  fixture.emitQueue()
  const timing = page.locator('.command-composer-options').getByRole('button', { name: / Message timing$/ })
  await expect(timing).toContainText('Add to current turn')
  fixture.finishTurn()
  await expect(timing).toContainText('Send now')
  await timing.click()
  await expect(page.getByRole('option', { name: /^Send now/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('option', { name: /^Add to current turn/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(timing).toBeFocused()
  const settings = await openChatSettings(page)
  await expect(settings.getByRole('button', { name: / Message timing$/ })).toContainText('Send now')
})

for (const theme of ['light', 'dark']) for (const width of [320, 390]) {
  test(`message timing and queue editing fit ${width}px screens in ${theme} mode`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aixand.appearance', value), theme)
    await page.setViewportSize({ width, height: 844 })
    const fixture = await runningChat(page)
    fixture.chat.queue!.messages.push({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', text: 'A queued task', status: 'queued', revision: 1, createdAt: 3 })
    fixture.emitQueue()
    const queue = page.getByRole('region', { name: 'Queued messages', exact: true })
    await expect(queue).toBeVisible()
    const timing = page.locator('.command-composer-options').getByRole('button', { name: / Message timing$/ })
    const timingBox = await timing.boundingBox()
    const settingsBox = await page.getByRole('button', { name: 'Chat settings', exact: true }).boundingBox()
    expect(timingBox!.y + timingBox!.height).toBeLessThanOrEqual(settingsBox!.y)
    await timing.click()
    await expect(page.getByRole('option', { name: /^Add to current turn/ })).toContainText('Give the agent more context while it works.')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const listBox = await page.getByRole('listbox').boundingBox()
    expect(listBox!.x).toBeGreaterThanOrEqual(0)
    expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(width)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    if (width === 390) await page.screenshot({ path: `artifacts/chat-composer/${theme}-message-timing-mobile.png`, fullPage: true })
    await page.getByRole('option', { name: /^Send after this turn/ }).click()
    await queue.getByRole('button', { name: 'Edit queued message', exact: true }).click()
    await expect(queue.getByRole('textbox', { name: 'Edit queued message', exact: true })).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  })
}
