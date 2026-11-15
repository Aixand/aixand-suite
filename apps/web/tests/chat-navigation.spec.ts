import { openComposerNotices, setChatMessageTiming, expect, test, type Page, type WebSocketRoute } from './fixtures'
import type { ChatSnapshot } from '../src/chats/model'
import { workspaceLink } from '../src/components/ContentLink'
import { mockHomeOverview } from './home-helpers'

const firstId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const secondId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
type Command = { id: string; op: string; args: Record<string, string> }

async function delayedChats(page: Page, { running = false, fresh = false, count = 2, child = false, firstMessage = 'First conversation' } = {}) {
  const first: ChatSnapshot = {
    id: firstId, provider: 'codex', profile: 'work', auth: null, cwd: '/workspace', project: '', mode: 'chat',
    title: 'First conversation', status: running ? 'running' : 'completed', turnId: 'first-turn', createdAt: 1, updatedAt: 2, revision: 1,
    items: [{ id: 'original', type: 'userMessage', text: firstMessage }], requests: [], queue: { paused: false, messages: [] },
  }
  const second: ChatSnapshot = { ...first, id: secondId, title: 'Second conversation', status: 'completed', turnId: 'second-turn', updatedAt: 1,
    items: [{ id: 'second', type: 'userMessage', text: 'Second conversation' }], queue: { paused: false, messages: [] } }
  const chats = new Map([[firstId, first], [secondId, second]])
  for (let index = 3; index <= count; index++) {
    const id = `${index.toString(16).padStart(8, '0')}-eeee-4eee-8eee-${index.toString(16).padStart(12, '0')}`
    chats.set(id, { ...first, id, title: `Conversation ${index}`, createdAt: 0, updatedAt: 0, status: 'completed' })
  }
  const childId = 'fffffffe-ffff-4fff-8fff-ffffffffffff'
  if (child) {
    chats.set(childId, { ...second, id: childId, title: 'Attached conversation', parentChatId: secondId, createdAt: 0, updatedAt: 0 })
    const siblingId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    chats.set(siblingId, { ...second, id: siblingId, title: 'Other attached conversation', parentChatId: secondId, createdAt: 0, updatedAt: 0 })
  }
  const operations: Command[] = []
  const held: { command: Command; finish: (error?: string) => void }[] = []
  const errors: string[] = []
  let socket: WebSocketRoute
  page.on('pageerror', (error) => errors.push(error.message))
  const service = { connected: true, syncing: false, error: null, last_sync: 1, instance: 'test', outgoing_history: true,
    agent_configured: false, providers: [], version: 1 }
  await page.routeWebSocket('**/api/carrier/ws', (route) => {
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw))
      const result = command.op === 'snapshot' ? { status: service, counts: {}, messages: [], total: 0, next_offset: null } :
        command.op === 'status' ? service : []
      route.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    socket = route
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const command: Command = JSON.parse(String(raw))
      operations.push(command)
      if (['chat-create', 'chat-send', 'chat-steer', 'chat-queue'].includes(command.op)) {
        held.push({ command, finish(error) {
          if (error) {
            route.send(JSON.stringify({ type: 'error', id: command.id, code: 'connection_lost', message: error }))
            return
          }
          let chat = chats.get(command.args.chatId)
          if (command.op === 'chat-create') {
            chat = { ...first, id: command.args.key, title: 'New conversation', status: 'ready', createdAt: Date.now(), revision: 1, items: [], queue: { paused: false, messages: [] } }
            chats.set(chat.id, chat)
          } else if (command.op === 'chat-queue') {
            chat!.queue!.messages.push({ id: command.args.key, text: command.args.text, status: 'queued', revision: 1, createdAt: 3 })
          } else {
            if (!chat!.items.some((item) => item.id === command.args.key)) chat!.items.push({ id: command.args.key, type: 'userMessage', text: command.args.text })
            if (chat!.title === 'New conversation') chat!.title = command.args.text
            chat!.status = 'running'
          }
          chat!.revision++
          chat!.updatedAt = Date.now()
          route.send(JSON.stringify({ type: 'result', id: command.id, result: chat }))
        } })
        return
      }
      if (command.op === 'chat-mark-read') {
        const chat = chats.get(command.args.chatId)!
        if (chat.latestCompletedTurnId === command.args.turnId) chat.lastReadTurnId = command.args.turnId
        chat.revision++
        route.send(JSON.stringify({ type: 'result', id: command.id, result: chat }))
        return
      }
      if (command.op === 'chat-interrupt') {
        const chat = chats.get(command.args.chatId)!
        chat.status = 'interrupted'
        route.send(JSON.stringify({ type: 'chat-event', chatId: chat.id, revision: ++chat.revision, event: { kind: 'status', status: chat.status } }))
      }
      if (command.op === 'chat-delete') {
        chats.delete(command.args.chatId)
        route.send(JSON.stringify({ type: 'chat-deleted', chatId: command.args.chatId }))
      }
      const result = command.op === 'catalog' ? { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: first.cwd } :
        command.op === 'mcp-catalog' ? { servers: [] } : command.op === 'sessions' ? { runs: [], runtimeError: null } :
        command.op === 'project-discovery-list' ? { jobs: [], nextOffset: null } : command.op === 'chat-workflow-runs' ? { runs: [], nextOffset: null } :
        command.op === 'chat-delete-preview' ? { chatId: command.args.chatId, childCount: 0, previewToken: 'a'.repeat(64) } :
        command.op === 'chat-list' ? fresh ? [] : [...chats.values()].sort((a, b) => b.updatedAt - a.updatedAt) : command.op === 'chat-open' ? chats.get(command.args.chatId) : []
      route.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto(fresh ? '/#/chat' : `/#/chat/${firstId}`)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await expect(input).toBeVisible()
  if (!fresh) await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible()
  function emitStatus(id: string, status: string) {
    const chat = chats.get(id)!
    chat.status = status
    chat.updatedAt = Date.now()
    socket.send(JSON.stringify({ type: 'chat-event', chatId: id, revision: ++chat.revision, event: { kind: 'status', status } }))
  }
  function emitCreated(chat: ChatSnapshot) {
    chats.set(chat.id, chat)
    socket.send(JSON.stringify({ type: 'chat-created', chat }))
  }
  return { operations, errors, held, input, first, second, chats, childId, emitStatus, emitCreated }
}

async function navigateToChat(page: Page) {
  await page.getByRole('link', { name: 'Chat', exact: true }).click()
}

async function openChat(page: Page, title: string) {
  await page.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('button', { name: new RegExp(`^${title}`) }).click()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}

function recentTitles(page: Page) {
  return page.getByRole('region', { name: 'Recent conversations', exact: true })
    .locator(':scope > ul > li > .command-history-row .command-history-item .chat-history-title')
}

const initialRecent = ['First conversation', 'Second conversation', ...Array.from({ length: 18 }, (_, index) => `Conversation ${index + 3}`)]

for (const form of ['hash', 'root', 'absolute', 'path', 'legacy', 'html'] as const) {
  test(`${form} chat links switch conversations without reloading or opening a tab`, async ({ page, context, baseURL }) => {
    const href = form === 'root' ? `/#/chat/${secondId}` : form === 'absolute' ? `${baseURL}/?from=report#/chat/${secondId}` :
      form === 'path' ? `/chat/${secondId}` : form === 'legacy' ? `#/command/${secondId}` : `#/chat/${secondId}`
    const fixture = await delayedChats(page, { firstMessage: form === 'html'
      ? `<a href="${href}" target="_blank">Open linked chat</a>` : `[Open linked chat](${href})` })
    const link = page.getByRole('log', { name: 'Conversation messages' }).getByRole('link', { name: 'Open linked chat' })
    await expect(link).not.toHaveAttribute('target')
    await fixture.input.fill('Keep this unsent draft')
    const document = await page.locator('#main-content').elementHandle()
    const documents: string[] = []
    page.on('request', request => { if (request.isNavigationRequest() && request.resourceType() === 'document') documents.push(request.url()) })
    const connections = fixture.operations.filter(operation => operation.op === 'catalog').length
    await link.click()
    await expect(page).toHaveURL(new RegExp(`#/chat/${secondId}$`))
    await expect(page.getByRole('heading', { name: 'Second conversation', exact: true })).toBeVisible()
    expect(await document!.evaluate(element => element.isConnected)).toBe(true)
    expect(documents).toEqual([])
    expect(context.pages()).toHaveLength(1)
    expect(fixture.operations.filter(operation => operation.op === 'catalog')).toHaveLength(connections)
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'First conversation', exact: true })).toBeVisible()
    await expect(fixture.input).toHaveValue('Keep this unsent draft')
    await page.goForward()
    await expect(page.getByRole('heading', { name: 'Second conversation', exact: true })).toBeVisible()
  })
}

test('workspace link normalization leaves external sites and independent pages alone', () => {
  const base = 'https://suite.example/?source=browser#/chat/first'
  expect(workspaceLink('https://other.example/#/chat/second', base)).toBeUndefined()
  expect(workspaceLink('//other.example/chat/second', base)).toBeUndefined()
  expect(workspaceLink('/recovery.html#/chat/second', base)).toBeUndefined()
  expect(workspaceLink('/api/chats/second', base)).toBeUndefined()
  expect(workspaceLink('mailto:person@example.com', base)).toBeUndefined()
  expect(workspaceLink(undefined, base)).toBeUndefined()
  expect(workspaceLink('/#/workflows/runs/run-1', base)).toBe('#/workflows/runs/run-1')
  expect(workspaceLink('/agents/prompts?view=history', base)).toBe('#/agents/prompts?view=history')
})

test('Alt arrows switch conversations in last sent order and retain drafts', async ({ page }) => {
  const fixture = await delayedChats(page)
  await fixture.input.fill('Retain this draft')
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.getByRole('heading', { name: 'Second conversation', exact: true })).toBeVisible()
  await fixture.input.fill('Newest prompt')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.held.length).toBe(1)
  fixture.held[0].finish()
  await expect(fixture.input).toHaveValue('')
  fixture.emitStatus(firstId, 'running')
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.getByRole('heading', { name: 'First conversation', exact: true })).toBeVisible()
  await expect(fixture.input).toHaveValue('Retain this draft')
  await page.keyboard.press('Alt+ArrowUp')
  await expect(page.getByRole('heading', { name: 'Second conversation', exact: true })).toBeVisible()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(page.getByRole('heading', { name: 'Second conversation', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.getByRole('heading', { name: 'Second conversation', exact: true })).toBeVisible()
})

for (const op of ['chat-send', 'chat-steer', 'chat-queue']) {
  test(`Recent moves the chat to the top after ${op} and ignores background status updates`, async ({ page }) => {
    const fixture = await delayedChats(page, { running: op !== 'chat-send', count: 21 })
    await expect(recentTitles(page)).toHaveText(initialRecent)
    if (op !== 'chat-send') fixture.emitStatus(secondId, 'running')
    await openChat(page, 'Second conversation')
    await expect(recentTitles(page)).toHaveText(initialRecent)
    if (op === 'chat-queue') await setChatMessageTiming(page, 'queue')
    await fixture.input.fill('Continue this conversation')
    await fixture.input.press('Enter')
    await expect.poll(() => fixture.held.length).toBe(1)
    expect(fixture.held[0].command.op).toBe(op)
    fixture.held[0].finish()
    await expect(fixture.input).toHaveValue('')
    await expect(recentTitles(page)).toHaveText(['Second conversation', 'First conversation', ...initialRecent.slice(2)])
    const outside = [...fixture.chats.values()].find((chat) => chat.title === 'Conversation 21')!
    fixture.emitStatus(outside.id, 'running')
    fixture.emitStatus(secondId, 'completed')
    await expect(page.getByRole('region', { name: 'Recent conversations', exact: true })
      .getByRole('button', { name: /^Second conversation/ })).toContainText('Done')
    await expect(recentTitles(page)).toHaveText(['Second conversation', 'First conversation', ...initialRecent.slice(2)])
    expect(fixture.errors).toEqual([])
  })
}

test('Recent adds a new conversation at the top and keeps it there as the agent responds', async ({ page }) => {
  const fixture = await delayedChats(page, { count: 21 })
  await expect(recentTitles(page)).toHaveText(initialRecent)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await fixture.input.fill('A brand new conversation')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.held.length).toBe(1)
  expect(fixture.held[0].command.op).toBe('chat-create')
  fixture.held[0].finish()
  await expect.poll(() => fixture.held.length).toBe(2)
  await expect(recentTitles(page)).toHaveText(['New conversation', ...initialRecent.slice(0, 19)])
  fixture.held[1].finish()
  await expect(fixture.input).toHaveValue('')
  const expected = ['A brand new conversation', ...initialRecent.slice(0, 19)]
  await expect(recentTitles(page)).toHaveText(expected)
  fixture.emitStatus(firstId, 'running')
  await expect(page.getByRole('region', { name: 'Recent conversations', exact: true })
    .getByRole('button', { name: /^First conversation/ })).toContainText('Working')
  await expect(recentTitles(page)).toHaveText(expected)
  expect(fixture.errors).toEqual([])
})

test('sending restores an older conversation at the top and saves its order across navigation and reload', async ({ page }) => {
  const fixture = await delayedChats(page, { count: 21 })
  await expect(recentTitles(page)).toHaveText(initialRecent)
  await page.getByRole('button', { name: 'Search history', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search history', exact: true }).fill('Conversation 21')
  await page.getByRole('menuitem', { name: /Conversation 21/ }).click()
  await expect(recentTitles(page)).toHaveText(initialRecent)
  await fixture.input.fill('Resume this older conversation')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.held.length).toBe(1)
  fixture.held[0].finish()
  await expect(fixture.input).toHaveValue('')
  const expected = ['Conversation 21', ...initialRecent.slice(0, 19)]
  await expect(recentTitles(page)).toHaveText(expected)
  await openChat(page, 'Second conversation')
  fixture.emitStatus(secondId, 'running')
  await expect(page.getByRole('region', { name: 'Recent conversations', exact: true })
    .getByRole('button', { name: /^Second conversation/ })).toContainText('Working')
  await expect(recentTitles(page)).toHaveText(expected)
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await navigateToChat(page)
  await expect(recentTitles(page)).toHaveText(expected)
  await page.reload()
  await expect(recentTitles(page)).toHaveText(expected)
  const history = page.getByRole('region', { name: 'Recent conversations', exact: true })
  await history.getByRole('button', { name: /^Conversation 21/ }).hover()
  await history.getByRole('button', { name: 'Conversation actions for Conversation 21', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'Delete conversation?' }).getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await expect(recentTitles(page)).toHaveText(initialRecent)
  await page.reload()
  await expect(recentTitles(page)).toHaveText(initialRecent)
  expect(fixture.errors).toEqual([])
})

test('opening an attached conversation already in Recent keeps its parent and siblings in place', async ({ page }) => {
  const fixture = await delayedChats(page, { count: 21, child: true })
  await expect(recentTitles(page)).toHaveText(initialRecent)
  await page.getByRole('button', { name: 'Expand sessions spawned from Second conversation', exact: true }).click()
  const children = page.getByRole('list', { name: 'Sessions spawned from Second conversation', exact: true }).locator('.command-history-item .chat-history-title')
  const expectedChildren = ['Attached conversation', 'Other attached conversation']
  await expect(children).toHaveText(expectedChildren)
  await openChat(page, 'Other attached conversation')
  await expect(children).toHaveText(expectedChildren)
  await openChat(page, 'Attached conversation')
  await expect(recentTitles(page)).toHaveText(initialRecent)
  await expect(children).toHaveText(expectedChildren)
  fixture.emitStatus(fixture.childId, 'running')
  await expect(page.getByRole('region', { name: 'Recent conversations', exact: true })
    .getByRole('button', { name: /^Attached conversation/ })).toContainText('Working')
  await expect(recentTitles(page)).toHaveText(initialRecent)
  await expect(children).toHaveText(expectedChildren)
  expect(fixture.errors).toEqual([])
})

test('refresh preserves Recent when the open chat has fallen out, and sending brings it back', async ({ page }) => {
  const fixture = await delayedChats(page)
  const titles = ['First conversation', 'Second conversation']
  for (let index = 1; index <= 20; index++) {
    const id = `${index.toString(16).padStart(8, 'b')}-bbbb-4bbb-8bbb-${index.toString(16).padStart(12, 'b')}`
    const title = `New conversation ${index}`
    fixture.emitCreated({ ...fixture.first, id, title, createdAt: Date.now(), updatedAt: Date.now() })
    titles.unshift(title)
    await expect(recentTitles(page)).toHaveText(titles.slice(0, 20))
  }
  await page.reload()
  await expect(page.getByRole('heading', { name: 'First conversation', exact: true })).toBeVisible()
  await expect(recentTitles(page)).toHaveText(titles.slice(0, 20))
  await fixture.input.fill('Resume the conversation that fell out of Recent')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.held.length).toBe(1)
  fixture.held[0].finish()
  await expect(fixture.input).toHaveValue('')
  const expected = ['First conversation', ...titles.slice(0, 19)]
  await expect(recentTitles(page)).toHaveText(expected)
  await page.reload()
  await expect(recentTitles(page)).toHaveText(expected)
  expect(fixture.errors).toEqual([])
})

for (const op of ['chat-send', 'chat-steer', 'chat-queue']) {
  test(`${op} allows a new conversation and its delayed response preserves the new draft`, async ({ page }) => {
    const fixture = await delayedChats(page, { running: op !== 'chat-send' })
    if (op === 'chat-queue') await setChatMessageTiming(page, 'queue')
    await fixture.input.fill('Send from the first conversation')
    await fixture.input.press('Enter')
    await expect.poll(() => fixture.held.length).toBe(1)
    expect(fixture.held[0].command.op).toBe(op)
    if (op !== 'chat-send') await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(page).toHaveURL(/#\/chat$/)
    await fixture.input.fill('Keep this new conversation draft')
    fixture.held[0].finish()
    await openChat(page, 'First conversation')
    await expect(fixture.input).toHaveValue('')
    await expect(fixture.input).not.toHaveAttribute('readonly', '')
  await page.getByRole('link', { name: 'Home', exact: true }).click()
    await navigateToChat(page)
    await expect(page).toHaveURL(/#\/chat$/)
    await expect(fixture.input).toHaveValue('Keep this new conversation draft')
    expect(fixture.errors).toEqual([])
  })
}

test('two chats send independently and retain separate drafts while switching', async ({ page }) => {
  const fixture = await delayedChats(page)
  await fixture.input.fill('First pending send')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.held.length).toBe(1)
  await openChat(page, 'Second conversation')
  await fixture.input.fill('Second pending send')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.held.length).toBe(2)
  fixture.held[0].finish()
  await expect(page).toHaveURL(new RegExp(secondId))
  await expect(fixture.input).toHaveValue('')
  await expect(page.getByRole('region', { name: 'Pending messages' })).toContainText('Second pending send')
  await expect(fixture.input).not.toHaveAttribute('readonly', '')
  await fixture.input.fill('Keep the second chat draft')
  await openChat(page, 'First conversation')
  await expect(fixture.input).not.toHaveAttribute('readonly', '')
  await fixture.input.fill('Keep the first chat draft')
  fixture.held[1].finish()
  await openChat(page, 'Second conversation')
  await expect(fixture.input).toHaveValue('Keep the second chat draft')
  await openChat(page, 'First conversation')
  await expect(fixture.input).toHaveValue('Keep the first chat draft')
  expect(fixture.errors).toEqual([])
})

test('background failures retain the draft and retry receipt across page navigation', async ({ page }) => {
  await mockHomeOverview(page)
  const fixture = await delayedChats(page)
  await fixture.input.fill('Retry exactly this message')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.held.length).toBe(1)
  await openChat(page, 'Second conversation')
  await fixture.input.fill('Keep the second chat draft')
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  fixture.held[0].finish('Response interrupted')
  await navigateToChat(page)
  await openChat(page, 'First conversation')
  await expect(fixture.input).toHaveValue('')
  await expect(page.getByRole('region', { name: 'Pending messages' })).toContainText('Retry exactly this message')
  await openComposerNotices(page)
  const status = page.locator('.command-composer-status')
  await status.getByRole('button', { name: 'Message delivery is unconfirmed.', exact: true }).click()
  await expect(page.locator('.command-composer-status-popover').getByText('Response interrupted', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Retry request', exact: true }).click()
  await expect.poll(() => fixture.held.length).toBe(2)
  expect(fixture.held[1].command.args).toEqual(fixture.held[0].command.args)
  fixture.held[1].finish()
  await expect(fixture.input).toHaveValue('')
  await openChat(page, 'Second conversation')
  await expect(fixture.input).toHaveValue('Keep the second chat draft')
  expect(fixture.errors).toEqual([])
})

test('creating a chat finishes in the background while another new chat starts', async ({ page }) => {
  const fixture = await delayedChats(page, { fresh: true })
  await fixture.input.fill('First new chat')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.held.length).toBe(1)
  expect(fixture.held[0].command.op).toBe('chat-create')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await fixture.input.fill('Second new chat')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.held.length).toBe(2)
  fixture.held[0].finish()
  await expect.poll(() => fixture.held.length).toBe(3)
  expect(fixture.held[2].command.args.text).toBe('First new chat')
  fixture.held[2].finish()
  await expect(fixture.input).toHaveValue('Second new chat')
  await expect(fixture.input).toHaveAttribute('readonly', '')
  fixture.held[1].finish()
  await expect.poll(() => fixture.held.length).toBe(4)
  expect(fixture.held[3].command.args.text).toBe('Second new chat')
  fixture.held[3].finish()
  await expect(page).toHaveURL(new RegExp(fixture.held[1].command.args.key))
  await expect(fixture.input).toHaveValue('')
  expect(fixture.errors).toEqual([])
})

test('a delayed send does not navigate back after leaving the chat page', async ({ page }) => {
  const fixture = await delayedChats(page)
  await fixture.input.fill('Finish in the background')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.held.length).toBe(1)
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  fixture.held[0].finish()
  await navigateToChat(page)
  await openChat(page, 'First conversation')
  await expect(fixture.input).toHaveValue('')
  expect(fixture.errors).toEqual([])
})

test('Stop remains usable while a queue request is pending', async ({ page }) => {
  const fixture = await delayedChats(page, { running: true })
  await setChatMessageTiming(page, 'queue')
  await fixture.input.fill('A later message')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.held.length).toBe(1)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => fixture.operations.filter((op) => op.op === 'chat-interrupt').length).toBe(1)
  await expect(fixture.input).not.toHaveAttribute('readonly', '')
  await fixture.input.fill('Keep composing after Stop')
  fixture.held[0].finish()
  await expect(fixture.input).toHaveValue('Keep composing after Stop')
})

test('direct chat navigation preserves the pending request and the destination draft', async ({ page }) => {
  const fixture = await delayedChats(page)
  await fixture.input.fill('First pending send')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.held.length).toBe(1)
  await page.evaluate((id) => { location.hash = `/chat/${id}` }, secondId)
  await expect(page.getByRole('heading', { name: 'Second conversation', exact: true })).toBeVisible()
  await fixture.input.fill('Keep the destination draft')
  fixture.held[0].finish()
  await navigateToChat(page)
  await expect(page.getByRole('heading', { name: 'Where should we start?', exact: true })).toBeVisible()
  await openChat(page, 'Second conversation')
  await expect(fixture.input).toHaveValue('Keep the destination draft')
  expect(fixture.errors).toEqual([])
})


test('unread completion survives refresh and clears automatically when the latest reply is viewed', async ({ page }) => {
  const fixture = await delayedChats(page)
  fixture.second.latestCompletedTurnId = 'second-turn'
  fixture.second.items.push({ id: 'reply', type: 'agentMessage', text: 'Finished the second task.' })
  fixture.second.revision++
  fixture.emitCreated(fixture.second)
  const row = () => page.getByRole('region', { name: 'Recent conversations', exact: true })
    .getByRole('button', { name: /^Second conversation/ })
  await expect(row()).toHaveAttribute('data-unread', 'true')
  await expect(row().locator('.chat-unread-indicator')).toBeVisible()
  await expect(row()).toContainText('Finished · Unread')
  await page.reload()
  await expect(row()).toHaveAttribute('data-unread', 'true')
  await openChat(page, 'Second conversation')
  await expect(row()).not.toHaveAttribute('data-unread')
  await expect.poll(() => fixture.operations.filter(op => op.op === 'chat-mark-read').length).toBe(1)
  await page.reload()
  await expect(row()).not.toHaveAttribute('data-unread')
  expect(fixture.errors).toEqual([])
})

test('a completed reply stays unread while viewing older messages', async ({ page }) => {
  const fixture = await delayedChats(page, { running: true })
  fixture.first.items = Array.from({ length: 40 }, (_, index) => ({ id: `reply-${index}`, type: 'agentMessage', text: `Paragraph ${index}\n\n` + 'A long response. '.repeat(60) }))
  fixture.first.revision++
  fixture.emitCreated(fixture.first)
  const scroll = page.getByLabel('Conversation scroll area', { exact: true })
  await expect(scroll).toBeVisible()
  await scroll.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
  await expect(page.getByRole('button', { name: /Jump to latest/i })).toBeVisible()
  fixture.first.status = 'completed'
  fixture.first.latestCompletedTurnId = 'first-turn'
  fixture.first.revision++
  fixture.emitCreated(fixture.first)
  const row = page.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('button', { name: /^First conversation/ })
  await expect(row).toHaveAttribute('data-unread', 'true')
  expect(fixture.operations.filter(op => op.op === 'chat-mark-read')).toHaveLength(0)
  await page.getByRole('button', { name: /Jump to latest/i }).click()
  await expect(row).not.toHaveAttribute('data-unread')
})


test('completion in a hidden app stays unread until the app becomes visible and focused', async ({ page }) => {
  const fixture = await delayedChats(page, { running: true })
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }))
  fixture.first.status = 'completed'
  fixture.first.latestCompletedTurnId = 'first-turn'
  fixture.first.revision++
  fixture.emitCreated(fixture.first)
  const row = page.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('button', { name: /^First conversation/ })
  await expect(row).toHaveAttribute('data-unread', 'true')
  expect(fixture.operations.filter(op => op.op === 'chat-mark-read')).toHaveLength(0)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
  await expect(row).not.toHaveAttribute('data-unread')
})
