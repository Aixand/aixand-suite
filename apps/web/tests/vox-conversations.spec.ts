import { expect, test, type WebSocketRoute } from './fixtures'

test('Vox records startup timing before a call is created and ignores timings from other calls', async ({ page }) => {
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let finishStart: (() => void) | undefined
  await page.addInitScript(() => {
    localStorage.setItem('aixand.debug-mode', 'true')
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { throw new Error('Use typed input in this test.') } })
  })
  await page.routeWebSocket('**/api/carrier/ws', (route) => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const request = JSON.parse(String(raw))
      const result = request.op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: '/workspace' } : []
      route.send(JSON.stringify({ type: 'result', id: request.id, result }))
    })
  })
  await page.routeWebSocket('**/api/vox/ws', (route) => {
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const request = JSON.parse(String(raw))
      if (request.op !== 'start') { route.send(JSON.stringify({ type: 'result', id: request.id, result: {} })); return }
      function timing(id: string, stage: string) {
        route.send(JSON.stringify({ type: 'event', sessionId: id, event: { kind: 'startup-timing', stage, details: { elapsedMs: 12 } } }))
      }
      timing(sessionId, 'unrelated-call')
      timing(request.args.key, 'starting')
      timing(request.args.key, 'profile-selected')
      finishStart = () => route.send(JSON.stringify({ type: 'result', id: request.id,
        result: { id: request.args.key, profile: 'work', auth: null } }))
    })
  })
  await page.goto('/#/home')
  await page.getByRole('button', { name: 'Vox assistant', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Vox assistant', exact: true })
  await panel.getByRole('button', { name: 'Start call', exact: true }).click()
  await expect.poll(() => page.evaluate(() => JSON.parse(window.aixandVoxDiagnostics!.export()).events
    .filter((event: { event: string }) => event.event === 'call-startup-stage')
    .map((event: { details: { stage: string } }) => event.details.stage))).toEqual(['starting', 'profile-selected'])
  await expect(panel.getByRole('textbox', { name: 'Message Vox', exact: true })).toHaveCount(0)
  finishStart!()
  await expect(panel.getByRole('textbox', { name: 'Message Vox', exact: true })).toBeVisible()
})

test('Vox shows clickable conversations, their parent and children, and queued delivery in both call views', async ({ page }) => {
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const chatId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  let vox: WebSocketRoute
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { throw new Error('Use typed input in this test.') } })
  })
  await page.routeWebSocket('**/api/carrier/ws', (route) => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const request = JSON.parse(String(raw))
      const result = request.op === 'catalog' ? { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }],
        auths: [], capabilities: [], cwd: '/workspace' } : ['chat-list', 'project-list', 'sessions', 'models'].includes(request.op) ? [] : {}
      route.send(JSON.stringify({ type: 'result', id: request.id, result }))
    })
  })
  await page.routeWebSocket('**/api/vox/ws', (route) => {
    vox = route
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const request = JSON.parse(String(raw))
      route.send(JSON.stringify({ type: 'result', id: request.id, result: request.op === 'start' ? { id: sessionId, profile: 'work', auth: null } : {} }))
    })
  })
  await page.goto('/#/home')
  await page.getByRole('button', { name: 'Vox assistant', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Vox assistant', exact: true })
  await panel.getByRole('button', { name: 'Start call', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'Message Vox', exact: true })).toBeVisible()
  function emit(event: object) { vox.send(JSON.stringify({ type: 'event', sessionId, event })) }
  emit({ kind: 'tool', name: 'search_chats', status: 'completed', result: { chats: [{ id: chatId, title: 'Undercurrent discussion',
    url: `#/chat/${chatId}`, status: 'completed', children: [{ id: 'audit', title: 'Architecture audit', url: '#/chat/audit', status: 'running' }], childCount: 1 }] } })
  const links = panel.getByRole('navigation', { name: 'Chats found by Vox', exact: true })
  await expect(links.getByRole('link', { name: 'Undercurrent discussion', exact: true })).toHaveAttribute('href', `#/chat/${chatId}`)
  await expect(links.getByRole('link', { name: 'Architecture audit', exact: true })).toHaveAttribute('href', '#/chat/audit')
  emit({ kind: 'tool', name: 'read_chat', status: 'completed', result: { chat: { id: 'audit', title: 'Architecture audit', url: '#/chat/audit',
    parent: { id: chatId, title: 'Undercurrent discussion', url: `#/chat/${chatId}` } } } })
  await expect(links).toContainText('Parent:')
  await expect(links.getByRole('link', { name: 'Undercurrent discussion', exact: true })).toBeVisible()
  emit({ kind: 'tool', name: 'send_chat_message', status: 'completed', result: { chatId, title: 'Undercurrent discussion',
    url: `#/chat/${chatId}`, messageId: 'receipt', status: 'queued', paused: false } })
  await expect(links).toContainText('Message queued')
  await panel.getByRole('button', { name: 'Hide Vox', exact: true }).click()
  const minimized = page.getByRole('region', { name: 'Vox call updates', exact: true })
  await expect(minimized.getByRole('link', { name: 'Undercurrent discussion', exact: true })).toHaveAttribute('href', `#/chat/${chatId}`)
  await expect(minimized).toContainText('Message queued')
})
