import { test, expect, mockAuthentication, type Page, type WebSocketRoute } from './fixtures'
import type { ChatSnapshot } from '../src/chats/model'

const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

test('two clients share input during streaming and reconnect without live refreshes', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  const pages = await Promise.all(contexts.map(context => context.newPage()))
  const sockets = new Set<WebSocketRoute>()
  const requests: string[] = []
  let holdOpen = false
  let heldOpen: (() => void) | undefined
  const chat: ChatSnapshot = {
    id: chatId, provider: 'codex', profile: 'work', auth: null, cwd: '/workspace', project: '', mode: 'chat',
    title: 'Shared conversation', status: 'running', turnId: 'turn', createdAt: 1, updatedAt: 2, revision: 1,
    items: [{ id: 'original', type: 'userMessage', text: 'Initial shared question', turnId: 'turn' }],
    requests: [], queue: { paused: false, messages: [] }, chatCapabilities: { queue: true, steer: true, workflows: false },
  }
  const broadcast = () => {
    for (const socket of sockets) socket.send(JSON.stringify({ type: 'chat-updated', chat }))
  }
  async function configure(page: Page) {
    await mockAuthentication(page)
    await page.routeWebSocket('**/api/carrier/ws', route => {
      route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {})
    })
    await page.routeWebSocket('**/api/agents/ws', route => {
      sockets.add(route)
      route.onClose(() => sockets.delete(route))
      route.send(JSON.stringify({ type: 'ready' }))
      route.onMessage(raw => {
        const command = JSON.parse(String(raw))
        requests.push(command.op)
        if (['chat-send', 'chat-steer'].includes(command.op)) {
          chat.items.push({ id: String(command.args.key), type: 'userMessage', text: command.args.text, turnId: 'turn' })
          chat.revision++; broadcast()
        }
        const result = command.op === 'catalog' ? {
          profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: '/workspace',
        } : command.op === 'sessions' ? { runs: [], runtimeError: null } :
          command.op === 'mcp-catalog' ? { servers: [] } :
          command.op === 'project-discovery-list' ? { jobs: [], nextOffset: null } :
          command.op === 'chat-workflow-runs' ? { runs: [], nextOffset: null } :
          command.op === 'chat-list' ? [chat] :
          ['chat-open', 'chat-send', 'chat-steer'].includes(command.op) ? chat : []
        const response = JSON.stringify({ type: 'result', id: command.id, result })
        if (command.op === 'chat-open' && holdOpen) heldOpen = () => route.send(response)
        else route.send(response)
      })
    })
  }
  async function expectOnce(text: string) {
    for (const page of pages) await expect(page.getByRole('log', { name: 'Conversation messages' })
      .locator('.command-chat-message--userMessage').filter({ hasText: text })).toHaveCount(1)
  }
  try {
    await Promise.all(pages.map(configure))
    await Promise.all(pages.map(page => page.goto(`${baseURL}/#/chat/${chatId}`)))
    await expectOnce('Initial shared question')
    const opens = requests.filter(op => op === 'chat-open').length
    const navigations = [0, 0]
    pages.forEach((page, index) => page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations[index]++ }))
    for (const [index, text] of ['Sent from the first client', 'Sent from the second client'].entries()) {
      const input = pages[index].getByRole('textbox', { name: 'Instructions', exact: true })
      await input.fill(text); await input.press('Enter')
      await expectOnce(text)
      broadcast()
      chat.items.push({ id: `reply-${index}`, type: 'agentMessage', text: 'Reply is streaming', turnId: 'turn' })
      chat.revision++; broadcast()
      await expectOnce(text)
    }
    expect(requests.filter(op => op === 'chat-open')).toHaveLength(opens)
    expect(navigations).toEqual([0, 0])
    holdOpen = true
    const reconnect = pages[1].reload()
    await expect.poll(() => Boolean(heldOpen)).toBe(true)
    const input = pages[0].getByRole('textbox', { name: 'Instructions', exact: true })
    await input.fill('Input while the other client reconnects'); await input.press('Enter')
    heldOpen!(); holdOpen = false
    await reconnect
    await expectOnce('Input while the other client reconnects')
    await expectOnce('Sent from the first client')
    await expectOnce('Sent from the second client')
    broadcast()
    await expectOnce('Sent from the second client')
  } finally {
    await Promise.all(contexts.map(context => context.close()))
  }
})
