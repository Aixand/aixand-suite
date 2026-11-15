import { openComposerNotices, setChatMessageTiming, expect, test, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { CarrierMessage } from '../src/carrier/client'
import type { ChatSnapshot } from '../src/chats/model'
import { activeMention, inboxTokens, removeInboxReference } from '../src/chats/inboxReferences'
import { mockHomeOverview } from './home-helpers'

const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
async function inboxChat(page: Page, { fresh = false, running = true } = {}) {
  if (fresh) await mockHomeOverview(page)
  const operations: { op: string; args: Record<string, unknown> }[] = []
  const carrierOperations: { op: string; args: Record<string, unknown> }[] = []
  let failNext = ''
  let missing = false
  const mailboxes = [{ id: 'user', name: 'Main inbox', address: 'suite/local/user', role: 'human' }, { id: 'workflow-1', name: 'Review workflow', address: 'workflow/collector', role: 'workflow' }]
  const messages: CarrierMessage[] = ['42', '43'].map((id) => ({ id, title: 'Review / mobile', body: `Full body for message ${id}\nSecond line`, content: `Full body for message ${id}\nSecond line`,
    sender: `sender-${id}`, source: `sender-${id}`, recipient: 'suite/local/user', created_at: '2026-10-12T08:00:00Z', reply_to: null, acknowledged_at: null,
    read: false, archived: false, direction: 'incoming', metadata: null }))
  const chat: ChatSnapshot = { id: chatId, provider: 'codex', profile: 'work', auth: null, cwd: '/workspace', project: '', mode: 'chat', title: 'Inbox context',
    status: running ? 'running' : 'idle', turnId: running ? 'original-turn' : null, createdAt: 1, updatedAt: 2, revision: 1,
    items: [], requests: [], queue: { paused: false, reason: null, messages: [] } }
  const service = { connected: true, syncing: false, error: null, last_sync: 1, instance: 'test-dataset', outgoing_history: true, agent_configured: false, providers: [], version: 1 }
  await page.routeWebSocket('**/api/carrier/ws', (route) => {
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw)); carrierOperations.push(command)
      const offset = Number(command.args?.offset ?? 0)
      const limit = Number(command.args?.limit ?? 20)
      const result = command.op === 'mailboxes' ? mailboxes :
        command.op === 'snapshot' ? { status: service, counts: { Inbox: 2, Unread: 2 }, messages: [], total: 0, next_offset: null } :
          command.op === 'status' ? service : command.op === 'message_search' ? { instance: service.instance, messages: messages.slice(offset, offset + limit).map((message) => ({ ...message, body: undefined, content: undefined, preview: message.body.slice(0, 80) })), total: messages.length, next_offset: offset + limit < messages.length ? offset + limit : null } :
            command.op === 'message_get' ? messages.find((message) => message.id === String(command.args.id)) : []
      if (command.op === 'message_get' && missing) route.send(JSON.stringify({ type: 'error', id: command.id, code: 'missing_message', message: 'Referenced message is no longer in this inbox. Select it again.' }))
      else route.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw)); operations.push(command)
      if (command.op === failNext) { failNext = ''; route.send(JSON.stringify({ type: 'error', id: command.id, code: 'connection_lost', message: 'Connection interrupted' })); return }
      if (command.op === 'chat-queue') chat.queue!.messages.push({ id: command.args.key, text: command.args.text, revision: 1, status: 'queued', createdAt: 3 })
      if (['chat-send', 'chat-steer'].includes(command.op)) chat.items.push({ id: command.args.key, type: 'userMessage', text: command.args.text })
      const result = command.op === 'catalog' ? { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: chat.cwd } :
        command.op === 'mcp-catalog' ? { servers: [] } : command.op === 'chat-workflow-runs' ? { runs: [], nextOffset: null } :
          command.op === 'chat-list' ? fresh ? [] : [chat] : ['chat-create', 'chat-open', 'chat-send', 'chat-steer', 'chat-queue'].includes(command.op) ? chat : []
      route.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto(fresh ? '/#/chat' : `/#/chat/${chatId}`)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await expect(input).toBeVisible()
  return { operations, carrierOperations, messages, mailboxes, input, fail(op: string) { failNext = op }, removeMessage() { missing = true } }
}

async function selectMessage(page: Page, messageIndex = 0) {
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Summarize @')
  await expect(page.getByRole('option', { name: /Inbox Include/ })).toBeVisible()
  await input.press('Enter')
  await expect(input).toHaveValue('Summarize @inbox/')
  await expect(page.getByRole('option', { name: /Main inbox/ })).toBeVisible()
  await input.press('Enter')
  await expect(input).toHaveValue('Summarize @inbox/user:')
  const options = page.getByRole('option', { name: /Review \/ mobile/ })
  await expect(options).toHaveCount(2)
  if (messageIndex === 1) await page.screenshot({ path: 'artifacts/chat-inbox/desktop-picker.png', animations: 'disabled' })
  if (messageIndex) await input.press('ArrowDown')
  await input.press('Enter')
  await expect(input).toHaveValue(`Summarize @inbox/user:review-mobile~${42 + messageIndex} `)
  await expect(page.getByRole('button', { name: /^\d+ references?$/ })).toBeVisible()
  await expect(page.getByRole('listbox', { name: 'Inbox reference suggestions' })).toHaveCount(0)
  return input
}

test('a draft retains inbox references across navigation and sends the latest typed text', async ({ page }) => {
  const fixture = await inboxChat(page, { fresh: true, running: false })
  const input = await selectMessage(page)
  const draft = await input.inputValue()
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(input).toHaveValue(draft)
  await page.getByRole('link', { name: 'Chat', exact: true }).click()
  await expect(input).toHaveValue(draft)
  await expect(page.getByRole('button', { name: 'Preview inbox message: Review / mobile' })).toBeVisible()
  await input.pressSequentially('including the final character!')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(page.getByRole('group', { name: 'Inbox message references' })).toHaveCount(0)
  const sent = fixture.operations.find((command) => command.op === 'chat-send')!.args.text as string
  expect(sent).toContain('including the final character!')
  expect(sent).toContain('Full body for message 42')
})

test('selecting a profile mention preserves selected inbox references and resolves them when sending', async ({ page }) => {
  const fixture = await inboxChat(page, { fresh: true, running: false })
  const input = await selectMessage(page)
  await input.pressSequentially('@profile:work')
  await page.getByRole('option', { name: /^work / }).click()
  await expect(page.getByRole('button', { name: 'work Profile', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Preview inbox message: Review / mobile' })).toBeVisible()
  await input.press('Enter')
  await expect(input).toHaveValue('')
  expect(fixture.operations.find((command) => command.op === 'chat-create')?.args.profile).toBe('work')
  const sent = fixture.operations.find((command) => command.op === 'chat-send')!.args.text as string
  expect(sent).toContain('Full body for message 42')
  expect(sent).not.toContain('@profile:')
})

test('suggestions, empty drafts, resizing, and new conversation resets update the composer immediately', async ({ page }) => {
  const { input, operations } = await inboxChat(page, { fresh: true, running: false })
  const suggestions = page.getByRole('group', { name: 'Chat suggestions' })
  const send = page.getByRole('button', { name: 'Start agent', exact: true })
  await expect(suggestions).toBeVisible()
  await expect(send).toBeDisabled()
  await page.getByRole('button', { name: 'Explore an idea', exact: true }).click()
  await expect(input).toHaveValue('Help me think through this idea:\n')
  await expect(suggestions).toHaveCount(0)
  await expect(send).toBeEnabled()
  await input.fill('first line\nsecond line\nthird line')
  const expandedHeight = await input.evaluate((element) => element.clientHeight)
  await input.fill('   ')
  await expect(send).toBeDisabled()
  await expect(suggestions).toBeVisible()
  expect(await input.evaluate((element) => element.clientHeight)).toBeLessThan(expandedHeight)
  await input.press('Enter')
  expect(operations.some((command) => command.op === 'chat-create')).toBe(false)
  await input.fill('Discard this draft')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(send).toBeDisabled()
  await expect(suggestions).toBeVisible()
})

test('hierarchical keyboard suggestions select the exact duplicate title, preview, and steer with full content', async ({ page }) => {
  const fixture = await inboxChat(page)
  const input = await selectMessage(page, 1)
  expect(fixture.operations.filter((command) => ['chat-send', 'chat-steer', 'chat-queue'].includes(command.op))).toHaveLength(0)
  await page.getByRole('button', { name: 'Preview inbox message: Review / mobile' }).click()
  const dialog = page.getByRole('dialog', { name: 'Review / mobile' })
  await expect(dialog).toContainText('Full body for message 43')
  await page.screenshot({ path: 'artifacts/chat-inbox/desktop-preview.png', animations: 'disabled' })
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await input.press('Enter')
  await expect(input).toHaveValue('')
  const text = fixture.operations.find((command) => command.op === 'chat-steer')!.args.text as string
  expect(text).toContain('Full body for message 43\\nSecond line')
  expect(text).not.toContain('Full body for message 42')
  expect(text).toContain('sender-43')
  expect(fixture.carrierOperations.filter((command) => ['set_message_state', 'acknowledge', 'conversation'].includes(command.op))).toHaveLength(0)
  expect(fixture.carrierOperations.filter((command) => command.op === 'message_get').every((command) => command.args.instance === 'test-dataset')).toBe(true)
})

test('queued content and retries keep the original snapshot and operation key', async ({ page }) => {
  const fixture = await inboxChat(page)
  await setChatMessageTiming(page, 'queue')
  const input = await selectMessage(page)
  fixture.fail('chat-queue')
  await input.press('Enter')
  await expect(page.getByRole('button', { name: 'Retry request', exact: true })).toBeVisible()
  fixture.messages[0].body = 'Changed after first attempt'
  fixture.removeMessage()
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect(input).toHaveValue('')
  const attempts = fixture.operations.filter((command) => command.op === 'chat-queue')
  expect(attempts).toHaveLength(2)
  expect(attempts[1].args).toEqual(attempts[0].args)
  expect(attempts[1].args.text).toContain('Full body for message 42')
  expect(fixture.carrierOperations.filter((command) => command.op === 'message_get')).toHaveLength(1)
})

test('a failed chat creation retains resolved references until the initial send succeeds', async ({ page }) => {
  const fixture = await inboxChat(page, { fresh: true, running: false })
  const input = await selectMessage(page)
  fixture.fail('chat-create')
  await input.press('Enter')
  await expect(page.getByRole('button', { name: 'Retry request', exact: true })).toBeVisible()
  fixture.removeMessage()
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect(input).toHaveValue('')
  expect(fixture.operations.find((command) => command.op === 'chat-send')!.args.text).toContain('Full body for message 42')
  expect(fixture.carrierOperations.filter((command) => command.op === 'message_get')).toHaveLength(1)
})

test('typing at the caret preserves surrounding text and resolves multiple selected messages once each', async ({ page }) => {
  const fixture = await inboxChat(page)
  const prefix = 'Compare @inbox/main-inbox:'
  await fixture.input.fill(`${prefix} with the current plan.`)
  await fixture.input.evaluate((input, caret) => input.setSelectionRange(caret, caret), prefix.length)
  await page.getByRole('option', { name: /Review \/ mobile/ }).first().click()
  await expect(fixture.input).toHaveValue(/with the current plan\.$/)
  await fixture.input.press('End')
  await fixture.input.pressSequentially(' and @inbox/user:')
  await expect(page.getByRole('option', { name: /Review \/ mobile/ })).toHaveCount(2)
  await fixture.input.press('ArrowDown')
  await fixture.input.press('Enter')
  const chips = page.getByRole('group', { name: 'Inbox message references' })
  await expect(chips.getByRole('button', { name: /Preview inbox message/ })).toHaveCount(2)
  const prompt = await fixture.input.inputValue()
  const repeatedToken = prompt.match(/@inbox\/user:[^\s]+/)![0]
  await fixture.input.fill(`${prompt} Also consider ${repeatedToken}`)
  await fixture.input.press('Enter')
  await expect(fixture.input).toHaveValue('')
  const text = fixture.operations.find((command) => command.op === 'chat-steer')!.args.text as string
  expect(text).toContain('with the current plan.')
  expect(text).toContain('Full body for message 42')
  expect(text).toContain('Full body for message 43')
  expect(fixture.carrierOperations.filter((command) => command.op === 'message_get')).toHaveLength(2)
})

test('message suggestions page through the saved inbox', async ({ page }) => {
  const fixture = await inboxChat(page)
  for (let index = 0; index < 19; index++) fixture.messages.push({ ...fixture.messages[0], id: String(100 + index), title: `Older message ${index}` })
  await fixture.input.fill('@inbox/user:')
  await page.getByRole('option', { name: /More messages/ }).click()
  await expect(page.getByRole('option', { name: /Older message 18/ })).toBeVisible()
  await fixture.input.press('Enter')
  await expect(page.getByRole('button', { name: 'Preview inbox message: Older message 18' })).toBeVisible()
  expect(fixture.carrierOperations.filter((command) => command.op === 'message_search').map((command) => command.args.offset)).toEqual([0, 20])
})

test('inbox navigation waits for a colon before searching messages and preserves the search text', async ({ page }) => {
  const fixture = await inboxChat(page)
  await fixture.input.fill('@inbox/main-inbox')
  await expect(page.getByRole('option', { name: /Main inbox/ })).toBeVisible()
  expect(fixture.carrierOperations.filter(command => command.op === 'message_search')).toHaveLength(0)
  await fixture.input.fill('@inbox/main-inbox:review/mobile:details')
  await expect(page.getByRole('option', { name: /Review \/ mobile/ })).toHaveCount(2)
  expect(fixture.carrierOperations.find(command => command.op === 'message_search')?.args).toMatchObject({
    mailbox: 'user', search: 'review/mobile:details',
  })
  await fixture.input.press('Enter')
  await expect(fixture.input).toHaveValue('@inbox/user:review-mobile~42 ')
})

test.describe('touch inbox references', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })
  test('tapping each suggestion keeps the composer focused', async ({ page }) => {
    const fixture = await inboxChat(page)
    await fixture.input.fill('@')
    await page.getByRole('option', { name: /Inbox Include/ }).tap()
    await expect(fixture.input).toBeFocused()
    await page.getByRole('option', { name: /Main inbox/ }).tap()
    await expect(fixture.input).toBeFocused()
    await page.getByRole('option', { name: /Review \/ mobile/ }).first().tap()
    await expect(fixture.input).toBeFocused()
    await expect(page.getByRole('button', { name: /^\d+ references?$/ })).toBeVisible()
  })
})

test('missing, unresolved, and oversized references keep the draft editable; removing a chip removes the mention', async ({ page }) => {
  const fixture = await inboxChat(page)
  const input = await selectMessage(page)
  fixture.messages[0].body = 'x'.repeat(32000)
  await input.press('Enter')
  await openComposerNotices(page)
  await expect(page.locator('.command-composer-status').getByRole('alert').filter({ hasText: 'exceed 32,000' })).toBeVisible()
  await expect(input).not.toHaveAttribute('readonly', '')
  fixture.removeMessage()
  await input.press('Enter')
  await openComposerNotices(page)
  await expect(page.locator('.command-composer-status').getByRole('alert').filter({ hasText: 'no longer' })).toBeVisible()
  await page.getByRole('button', { name: '1 reference', exact: true }).click()
  await page.getByRole('button', { name: 'Remove inbox message: Review / mobile' }).click()
  await expect(input).toHaveValue('Summarize  ')
  await input.fill('Summarize @inbox/user:unselected')
  await input.press('Escape')
  await input.press('Enter')
  await openComposerNotices(page)
  await expect(page.locator('.command-composer-status').getByRole('alert').filter({ hasText: 'Choose a message' })).toBeVisible()
  expect(fixture.operations.filter((command) => ['chat-send', 'chat-steer', 'chat-queue', 'chat-create'].includes(command.op))).toHaveLength(0)
})

for (const theme of ['light', 'dark']) test(`caret suggestions work on mobile in ${theme}, leave email and code alone, and expose accessible options`, async ({ page }) => {
  await page.addInitScript((value) => localStorage.setItem('aixand.appearance', value), theme)
  await page.setViewportSize({ width: 390, height: 844 })
  const fixture = await inboxChat(page)
  await fixture.input.fill('Email hello@example.com')
  await expect(page.getByRole('listbox', { name: 'Inbox reference suggestions' })).toHaveCount(0)
  await fixture.input.fill('Example `@inbox/user:example`')
  await expect(page.getByRole('listbox', { name: 'Inbox reference suggestions' })).toHaveCount(0)
  await fixture.input.fill('@inbox/')
  await expect(page.getByRole('option', { name: /Main inbox/ })).toBeVisible()
  await page.screenshot({ path: `artifacts/chat-inbox/mobile-picker-${theme}.png`, animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const report = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(report.violations).toEqual([])
  await fixture.input.press('Escape')
  await expect(page.getByRole('listbox', { name: 'Inbox reference suggestions' })).toHaveCount(0)
})

test('reference parsing preserves code examples and removes only the exact selected message', () => {
  const token = '@inbox/user:review~42'
  const text = `${token} @inbox/user:review~420\n\`\`\`text\n${token}\n\`\`\`\n\`${token}\``
  expect(inboxTokens(text)).toEqual([token, '@inbox/user:review~420'])
  expect(removeInboxReference(text, token)).toBe(text.slice(token.length))
  expect(activeMention('Contact hello@example.com', 25)).toBeNull()
  expect(activeMention('```text\n@inbox/', 15)).toBeNull()
  expect(activeMention('Summarize @inbox/user:review then compare', 22)).toMatchObject({ start: 10, end: 28 })
})

test('explicit inbox navigation refreshes names beyond the universal search snapshot', async ({ page }) => {
  const f = await inboxChat(page)
  await expect.poll(() => f.carrierOperations.filter(command => command.op === 'mailboxes').length).toBe(1)
  f.mailboxes.push({ id: 'new-inbox', name: 'New inbox', address: 'suite/local/new', role: 'human' })
  await f.input.fill('@inbox/new-inbox')
  await page.getByRole('option', { name: /^New inbox / }).click()
  await expect(f.input).toHaveValue('@inbox/new-inbox:')
  await expect(page.getByRole('option', { name: /Review \/ mobile/ })).toHaveCount(2)
})
