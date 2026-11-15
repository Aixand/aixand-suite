import { expect, test, type Page, type WebSocketRoute } from './fixtures'
import type { ChatItem, ChatSnapshot } from '../src/chats/model'

async function cachedChats(page: Page, { turns = 20, large = false, reconnecting = false } = {}) {
  const chats: ChatSnapshot[] = Array.from({ length: 7 }, (_, index) => ({
    id: `${String(index + 1).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    provider: 'codex', profile: 'work', auth: null, cwd: '/workspace', project: '', mode: 'chat',
    title: `Cached conversation ${index + 1}`, status: 'completed', turnId: `turn-${turns - 1}`,
    createdAt: 100 - index, updatedAt: 100 - index, revision: 1, requests: [],
    items: Array.from({ length: turns * 2 }, (_, item) => ({
      id: `${index}-item-${item}`, turnId: `turn-${Math.floor(item / 2)}`,
      type: item % 2 ? 'agentMessage' : 'userMessage',
      text: item % 2 ? `Response ${index + 1}/${Math.floor(item / 2)}${large ? '\n' + 'Long retained output. '.repeat(1000) : ''}` : `Request ${index + 1}/${Math.floor(item / 2)}`,
    })),
  }))
  const operations: { op: string; args: Record<string, string> }[] = []
  const held: (() => void)[] = []
  let holdHistory = false, holdOpens = false
  let socket: WebSocketRoute
  await page.routeWebSocket('**/api/carrier/ws', route => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', route => {
    socket = route
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage(raw => {
      const command = JSON.parse(String(raw))
      operations.push(command)
      const chat = chats.find(chat => chat.id === command.args.chatId)
      let result: unknown = []
      if (command.op === 'catalog') result = { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: '/workspace' }
      else if (command.op === 'sessions') result = { runs: [], runtimeError: null }
      else if (command.op === 'mcp-catalog') result = { servers: [] }
      else if (command.op === 'project-discovery-list') result = { jobs: [], nextOffset: null }
      else if (command.op === 'chat-workflow-runs') result = { runs: [], nextOffset: null }
      else if (command.op === 'chat-list') result = chats.map(({ items: _items, requests: _requests, ...summary }) => summary)
      else if (command.op === 'chat-open') result = { ...chat, syncing: reconnecting, items: chat!.items.slice(-10), historyCursor: chat!.items.length > 10 ? chat!.items.at(-10)!.id : null }
      else if (command.op === 'chat-history') {
        const forward = Boolean(command.args.after)
        const boundary = chat!.items.findIndex(item => item.id === (command.args.after ?? command.args.before))
        const start = forward ? boundary + 1 : Math.max(0, boundary - 10)
        const end = forward ? Math.min(chat!.items.length, start + 10) : boundary
        const items = chat!.items.slice(start, end)
        result = { items, cursor: start ? items[0].id : null, after: end < chat!.items.length ? items.at(-1)!.id : null }
      }
      const response = JSON.stringify({ type: 'result', id: command.id, result })
      const send = () => route.send(response)
      if (command.op === 'chat-history' && holdHistory || command.op === 'chat-open' && holdOpens) held.push(send)
      else send()
    })
  })
  await page.goto('/#/chat')
  await expect(page.getByRole('region', { name: 'Recent conversations', exact: true })).toContainText(chats[0].title)
  async function go(index: number) {
    await page.evaluate(id => { location.hash = `/chat/${id}` }, chats[index].id)
    await expect(page.getByRole('heading', { name: chats[index].title, exact: true })).toBeVisible()
    await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText(`Response ${index + 1}/${turns - 1}`)
  }
  return { chats, operations, held, go,
    finishReconnect(index: number) {
      const chat = chats[index]
      socket.send(JSON.stringify({ type: 'chat-updated', chat: { ...chat, revision: ++chat.revision, syncing: false, items: chat.items.slice(-10), historyCursor: chat.items.at(-10)!.id } }))
    },
    holdHistory() { holdHistory = true }, holdOpens() { holdOpens = true },
    emit(index: number, event: { kind: string; item?: ChatItem; itemId?: string; itemType?: string; text?: string; turnId?: string; request?: ChatSnapshot['requests'][number] }) {
      const chat = chats[index]
      if (event.kind === 'item') chat.items.push(event.item!)
      if (event.kind === 'delta') {
        let item = chat.items.find(item => item.id === event.itemId)
        if (!item) { item = { id: event.itemId!, type: event.itemType!, text: '', turnId: event.turnId }; chat.items.push(item) }
        item.text += event.text
      }
      if (event.kind === 'request') { chat.requests.push(event.request!); chat.status = 'waiting' }
      socket.send(JSON.stringify({ type: 'chat-event', chatId: chat.id, revision: ++chat.revision, event }))
    },
  }
}

test('opens only five turns and reuses the five most recently visited chats', async ({ page }) => {
  const fixture = await cachedChats(page)
  for (let index = 0; index < 5; index++) await fixture.go(index)
  await expect(page.locator('.command-chat-message')).toHaveCount(10)
  const opens = (index: number) => fixture.operations.filter(op => op.op === 'chat-open' && op.args.chatId === fixture.chats[index].id).length
  await fixture.go(0)
  expect(opens(0)).toBe(1)
  await fixture.go(5)
  await fixture.go(4)
  expect(opens(4)).toBe(1)
  await fixture.go(1)
  expect(opens(1)).toBe(2)
  await fixture.go(0)
  expect(opens(0)).toBe(1)
  expect(fixture.operations.filter(op => op.op === 'chat-open').every(op => op.args.recent)).toBe(true)
  await expect(page.getByRole('log', { name: 'Conversation messages' })).not.toContainText('Request 1/0')
})

test('older turns load once, preserve the reading position, and reset to recent turns after switching', async ({ page }) => {
  const fixture = await cachedChats(page)
  await fixture.go(0)
  fixture.holdHistory()
  const position = await page.locator('[data-transcript-entry="0-item-38"]').evaluate(element => element.getBoundingClientRect().top)
  const older = page.getByRole('button', { name: 'Load older messages', exact: true })
  await older.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); button.click() })
  await expect(page.getByText('Loading messages…', { exact: true })).toBeVisible()
  expect(fixture.held).toHaveLength(1)
  await expect.poll(async () => Math.abs(await page.locator('[data-transcript-entry="0-item-38"]').evaluate(element => element.getBoundingClientRect().top) - position)).toBeLessThan(1)
  fixture.held.shift()!()
  await expect(page.locator('.command-chat-message')).toHaveCount(20)
  const after = await page.locator('[data-transcript-entry="0-item-38"]').evaluate(element => element.getBoundingClientRect().top)
  expect(Math.abs(after - position)).toBeLessThan(8)
  expect(fixture.operations.filter(op => op.op === 'chat-history')).toHaveLength(1)
  await fixture.go(1)
  await fixture.go(0)
  await expect(page.locator('.command-chat-message')).toHaveCount(10)
})

test('a delayed history page cannot replace the destination conversation', async ({ page }) => {
  const fixture = await cachedChats(page)
  await fixture.go(0)
  fixture.holdHistory()
  await page.getByRole('button', { name: 'Load older messages' }).evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => fixture.held.length).toBe(1)
  await fixture.go(1)
  await expect(page.getByRole('log', { name: 'Conversation messages' })).not.toContainText('Request 1/')
  await fixture.go(0)
  fixture.held.shift()!()
  await expect(page.locator('.command-chat-message')).toHaveCount(10)
})

test('evicted chats recover drafts, streamed replies, and pending approvals', async ({ page }) => {
  const fixture = await cachedChats(page)
  await fixture.go(0)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep my draft')
  for (let index = 1; index <= 5; index++) await fixture.go(index)
  fixture.emit(0, { kind: 'delta', itemId: 'latest-reply', itemType: 'agentMessage', text: 'Arrived while evicted', turnId: 'background-turn' })
  fixture.emit(0, { kind: 'request', request: { requestId: 'background-approval', method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } } })
  await fixture.go(0)
  await expect(input).toHaveValue('Keep my draft')
  await expect(page.getByText('Arrived while evicted', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve once', exact: true })).toBeVisible()
})

test('cached messages appear while a stale cache refresh is still pending', async ({ page }) => {
  const fixture = await cachedChats(page)
  await fixture.go(0)
  await fixture.go(1)
  fixture.holdOpens()
  await page.evaluate(() => { const now = Date.now(); Date.now = () => now + 20000 })
  await fixture.go(0)
  await expect.poll(() => fixture.held.length).toBe(1)
  await expect(page.locator('.command-chat-message')).toHaveCount(10)
  fixture.held.shift()!()
})

test('reconnecting displays recent messages and allows drafting while waiting for current state', async ({ page }) => {
  const fixture = await cachedChats(page, { reconnecting: true })
  await fixture.go(0)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep editing while reconnecting')
  await input.press('Enter')
  await expect(input).toHaveValue('Keep editing while reconnecting')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  expect(fixture.operations.some(op => op.op === 'chat-send')).toBe(false)
  fixture.finishReconnect(0)
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
})

test('streamed events received during a cold open win over its delayed snapshot', async ({ page }) => {
  const fixture = await cachedChats(page)
  fixture.holdOpens()
  await page.evaluate(id => { location.hash = `/chat/${id}` }, fixture.chats[0].id)
  await expect.poll(() => fixture.held.length).toBe(1)
  fixture.emit(0, { kind: 'delta', itemId: 'in-flight-reply', itemType: 'agentMessage', text: 'Newer than the opening snapshot', turnId: 'new-turn' })
  fixture.held.shift()!()
  await expect(page.getByText('Newer than the opening snapshot', { exact: true })).toBeVisible()
})

test('history only evicts distant messages after fifty turns, supports newer pages, and returns to live messages', async ({ page }) => {
  const fixture = await cachedChats(page, { turns: 70 })
  await fixture.go(0)
  for (let index = 0; index < 11; index++) {
    await page.getByRole('button', { name: 'Load older messages', exact: true }).evaluate((button: HTMLButtonElement) => button.click())
    await expect.poll(() => fixture.operations.filter(op => op.op === 'chat-history').length).toBe(index + 1)
    await expect(page.getByText('Loading messages…', { exact: true })).toHaveCount(0)
    if (index < 9) {
      await expect(page.getByRole('button', { name: 'Load newer messages', exact: true })).toHaveCount(0)
      await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('Response 1/69')
    }
  }
  await expect(page.getByRole('button', { name: 'Load newer messages', exact: true })).toBeAttached()
  await expect(page.getByRole('log', { name: 'Conversation messages' })).not.toContainText('Response 1/69')
  const retained = await page.locator('.command-transcript').evaluate(element => element.textContent!.length)
  expect(retained * 2).toBeLessThan(8 * 1024 * 1024)
  await expect(page.locator('.command-chat-message')).toHaveCount(100)
  await page.getByRole('button', { name: 'Load newer messages', exact: true }).evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => fixture.operations.some(op => op.op === 'chat-history' && op.args.after)).toBe(true)
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('Response 1/69')
  await expect(page.locator('.command-chat-message')).toHaveCount(10)
  await expect.poll(() => page.getByLabel('Conversation scroll area', { exact: true }).evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(80)
})

test('loaded history keeps real heights and recent replies while scrolling in both directions', async ({ page }) => {
  const fixture = await cachedChats(page, { turns: 40, large: true })
  await fixture.go(0)
  for (let index = 0; index < 4; index++) {
    await page.getByRole('button', { name: 'Load older messages', exact: true }).evaluate((button: HTMLButtonElement) => button.click())
    await expect.poll(() => fixture.operations.filter(op => op.op === 'chat-history').length).toBe(index + 1)
    await expect(page.getByText('Loading messages…', { exact: true })).toHaveCount(0)
  }
  await expect(page.locator('[data-transcript-entry]')).toHaveCount(50)
  await expect(page.locator('.command-chat-message')).toHaveCount(50)
  await expect(page.getByRole('button', { name: 'Load newer messages', exact: true })).toHaveCount(0)
  const scroll = page.getByLabel('Conversation scroll area', { exact: true })
  const height = await scroll.evaluate(element => element.scrollHeight)
  await page.getByLabel('Conversation scroll area', { exact: true }).evaluate(element => { element.scrollTop = 0 })
  await expect(page.getByText('Request 1/15', { exact: true })).toBeVisible()
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight)).toBe(height)
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(page.getByText(/^Response 1\/39/)).toBeInViewport()
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight)).toBe(height)
  expect(fixture.operations.filter(op => op.op === 'chat-history')).toHaveLength(4)
  expect(fixture.operations.some(op => op.op === 'chat-history' && op.args.after)).toBe(false)
})

test('jump to latest stays hidden when activity toggles without leaving the bottom', async ({ page }) => {
  const fixture = await cachedChats(page, { turns: 1 })
  await fixture.go(0)
  fixture.emit(0, { kind: 'item', item: { id: 'activity', type: 'commandExecution', command: 'pwd', text: '/workspace', status: 'completed' } })
  const summary = page.locator('.command-activity-group > summary')
  await summary.click()
  await expect(page.getByText('Ran a command', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toHaveCount(0)
  await summary.press('Space')
  await expect(page.getByText('Ran a command', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toHaveCount(0)
})

test('live updates and viewport resizing keep the bottom pinned until the reader scrolls away', async ({ page }) => {
  const fixture = await cachedChats(page)
  fixture.chats[0].status = 'running'
  await fixture.go(0)
  const scroll = page.getByLabel('Conversation scroll area', { exact: true })
  const jump = page.getByRole('button', { name: 'Jump to latest', exact: true })
  const gap = () => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
  for (let index = 0; index < 4; index++) {
    fixture.emit(0, { kind: 'delta', itemId: 'streaming', itemType: 'agentMessage', text: `Streaming update ${index}\n\n` + 'More output.\n\n'.repeat(12), turnId: 'live' })
    await expect.poll(gap).toBeLessThan(2)
    await expect(jump).toHaveCount(0)
    await page.setViewportSize({ width: 1440, height: 950 - index * 80 })
    await expect.poll(gap).toBeLessThan(2)
    await expect(jump).toHaveCount(0)
  }
  await scroll.evaluate(element => { element.scrollTop -= 300 })
  await expect(jump).toBeVisible()
  const top = await scroll.evaluate(element => element.scrollTop)
  fixture.emit(0, { kind: 'delta', itemId: 'streaming', text: 'New output while reading.\n\n'.repeat(20) })
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('New output while reading.')
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(top)
  await expect(jump).toBeVisible()
  await jump.click()
  await expect.poll(gap).toBeLessThan(2)
  await expect(jump).toHaveCount(0)
  fixture.emit(0, { kind: 'delta', itemId: 'streaming', text: 'Following again.\n\n'.repeat(20) })
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('Following again.')
  await expect.poll(gap).toBeLessThan(2)
  await expect(jump).toHaveCount(0)
})

test('switching conversations focuses the composer without stealing focus during streamed updates', async ({ page }) => {
  const fixture = await cachedChats(page)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await expect(input).toBeFocused()
  for (const index of [0, 1, 0]) {
    await fixture.go(index)
    await expect(input).toBeFocused()
  }
  const scroll = page.getByLabel('Conversation scroll area', { exact: true })
  await scroll.focus()
  fixture.emit(0, { kind: 'delta', itemId: 'focus-reply', itemType: 'agentMessage', text: 'A new streamed reply.', turnId: 'focus-turn' })
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('A new streamed reply.')
  await expect(scroll).toBeFocused()
})


test('nested code scrolling does not pause live following or re-show jump after clicking', async ({ page }) => {
  const fixture = await cachedChats(page)
  fixture.chats[0].status = 'running'
  await fixture.go(0)
  fixture.emit(0, { kind: 'item', item: { id: 'code-reply', type: 'agentMessage', text: '```text\n' + 'Scrollable code line\n'.repeat(100) + '```', turnId: 'live' } })
  const scroll = page.getByLabel('Conversation scroll area', { exact: true })
  const code = page.locator('.command-code-block pre').last()
  const jump = page.getByRole('button', { name: 'Jump to latest', exact: true })
  const gap = () => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)
  await expect(code).toBeVisible()
  await expect.poll(gap).toBeLessThan(2)
  await code.evaluate(element => { element.scrollTop = 250 })
  await code.hover()
  await page.mouse.wheel(0, -100)
  await expect.poll(() => code.evaluate(element => element.scrollTop)).toBeLessThan(250)
  await expect.poll(gap).toBeLessThan(2)
  await expect(jump).toHaveCount(0)
  fixture.emit(0, { kind: 'delta', itemId: 'after-code', itemType: 'agentMessage', text: 'Following after nested scroll.\n\n'.repeat(20), turnId: 'live' })
  await expect(page.getByRole('log')).toContainText('Following after nested scroll.')
  await expect.poll(gap).toBeLessThan(2)
  await expect(jump).toHaveCount(0)

  await scroll.evaluate(element => { element.scrollTop -= 400 })
  await expect(jump).toBeVisible()
  await jump.click()
  await expect.poll(gap).toBeLessThan(2)
  await expect(jump).toHaveCount(0)
  // A wheel event from a nested scroller must not cancel the completed jump.
  await code.dispatchEvent('wheel', { deltaY: -100, bubbles: true })
  fixture.emit(0, { kind: 'delta', itemId: 'after-code', text: 'Still following.\n\n'.repeat(20) })
  await expect(page.getByRole('log')).toContainText('Still following.')
  await expect.poll(gap).toBeLessThan(2)
  await expect(jump).toHaveCount(0)
})
