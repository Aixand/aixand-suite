import { openChatSettings, expect, test, type Page, type WebSocketRoute } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { BackgroundActivity, ChatLaunch, ChatSnapshot, ChatTerminal } from '../src/chats/model'
import type { Discovery } from '../src/projects/model'
import { toolCardEntries } from '../src/chats/toolCardEntries'

const reply = '## A clearer conversation\n\nTool activity is **separate** from the reply.\n\n- Readable messages\n- Expandable tool details\n\n```ts\nconst message = "Hello"\n```\n\n[View the project](https://example.com/project)'
const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function conversation(): ChatSnapshot {
  return {
    id: chatId, provider: 'codex', profile: 'work', auth: null, cwd: '/workspace/aixand', project: 'Aixand',
    mode: 'work', title: 'Improve the command page', status: 'completed', createdAt: 1, updatedAt: 2, revision: 1,
    items: [
      { id: 'user-1', type: 'userMessage', text: 'Improve the command page and separate the tools used.' },
      { id: 'intro', type: 'agentMessage', text: 'I’ll review the page and make the conversation easier to follow.' },
      { id: 'thinking', type: 'reasoning', text: 'Reviewing the conversation layout.' },
      { id: 'command', type: 'commandExecution', command: 'rg --files src/workspace', text: 'src/workspace/ChatPage.tsx\nsrc/workspace/chat.css', status: 'completed', exitCode: 0 },
      { id: 'files', type: 'fileChange', text: 'src/workspace/chat.css\n+ .command-transcript { gap: 24px; }', status: 'completed' },
      { id: 'tool', type: 'mcpToolCall', text: 'inspect_browser', status: 'completed' },
      { id: 'reply', type: 'agentMessage', text: reply },
    ], requests: [],
  }
}

function terminal(status: ChatTerminal['status']): ChatTerminal {
  return { key: '11111111-1111-4111-8111-111111111111', status, runId: 'terminal-run', sessionId: null,
    url: null, createdAt: 1, updatedAt: 2, error: status === 'unavailable' ? 'The terminal is unavailable. Reconnect to inspect it.' : null }
}

async function openConversation(page: Page, chat = conversation(), background?: BackgroundActivity, stopFailures = 0, backgroundProtocol = true) {
  if (background) chat.chatCapabilities = { queue: true, steer: true, workflows: false, ...chat.chatCapabilities, background: true }
  const ready = backgroundProtocol ? { type: 'ready', capabilities: { backgroundActivity: true } } : { type: 'ready' }
  let socket: WebSocketRoute
  const operations: { op: string; args: Record<string, unknown> }[] = []
  await page.routeWebSocket('**/api/carrier/ws', (route) => {
    route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    route.send(JSON.stringify(ready))
    socket = route
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'auth') { route.send(JSON.stringify(ready)); return }
      operations.push(message)
      if (!backgroundProtocol && message.op.startsWith('chat-background')) { route.close({ code: 1008, reason: 'Invalid agent request' }); return }
      if (message.op === 'chat-background-stop' && stopFailures-- > 0) {
        route.send(JSON.stringify({ type: 'error', id: message.id, code: 'uncertain', uncertain: true, message: 'Stop delivery is unconfirmed.' }))
        return
      }
      if (message.op === 'chat-background-stop' && background) background.processes = background.processes.filter(row => row.id !== message.args.processId)
      if (message.op === 'chat-terminal-open') { chat.terminal = terminal('queued'); chat.revision++ }
      if (message.op === 'chat-terminal-release') { chat.terminal = terminal('released'); chat.revision++ }
      const result = message.op === 'chat-background' ? background ?? {} : message.op === 'chat-background-stop' ? { terminated: true } :
        message.op === 'chat-background-process' ? { text: 'Development server listening on port 3000.' } :
        message.op === 'chat-background-agent' ? { items: [{ id: 'child-reply', type: 'agentMessage', text: 'Reviewing the background task.' }] } : message.op === 'catalog' ? {
        profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: chat.cwd,
      } : message.op === 'mcp-catalog' ? { servers: [] } :
        message.op === 'mcp-preview' ? { digest: '', project: null, states: [], selection: {} } :
        message.op === 'mcp-project-status' ? { states: [], jobs: [] } :
        message.op === 'project-files-list' ? { projectId: message.args.projectId, path: message.args.path ?? '', entries: [], total: 0, nextOffset: null, limited: false } :
        message.op === 'mcp-jobs' ? [] :
        message.op === 'chat-metadata' ? { metadata: { 'inputs.path': '/private/retained-inputs.json' } } : message.op === 'chat-list' ? [chat] : message.op === 'project-list' ? [{ id: 'project-ui', name: 'Aixand', path: chat.cwd }] :
        ['chat-open', 'chat-send', 'chat-steer', 'chat-queue', 'chat-terminal-open', 'chat-terminal-status', 'chat-terminal-release'].includes(message.op) ? chat : ['models', 'sessions', 'chat-launches'].includes(message.op) ? [] : {}
      route.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  await page.goto('/#/chat')
  const showHistory = page.getByRole('button', { name: 'Show chat history', exact: true })
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toBeVisible()
  if (await showHistory.isVisible()) await showHistory.click()
  await page.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('button', { name: /^Improve the command page/ }).click()
  await expect(page.getByRole('region', { name: 'Agent conversation', exact: true })).toBeVisible()
  return {
    operations,
    emit(event: object) { socket.send(JSON.stringify({ type: 'chat-event', chatId: chat.id, revision: ++chat.revision, event })) },
    disconnectAgent() { socket.send(JSON.stringify({ type: 'chat-event', event: { kind: 'connection', status: 'offline' } })) },
    emitDiscovery(discovery: Discovery) { socket.send(JSON.stringify({ type: 'project-discovery-updated', discovery })) },
    emitLaunch(launch: ChatLaunch) { socket.send(JSON.stringify({ type: 'launch-updated', launch })) },
  }
}

test('activity row stays visible through a turn and yields to approval requests', async ({ page }) => {
  const fixture = await openConversation(page)
  const activity = page.locator('.command-agent-activity')
  await expect(activity).toHaveCount(0)
  fixture.emit({ kind: 'status', status: 'running' })
  await expect(activity).toBeVisible()
  await expect(activity).toContainText('Working…')
  fixture.emit({ kind: 'item', item: { id: 'streaming-reply', type: 'agentMessage', text: 'Checking your project.' } })
  await expect(activity).toBeVisible()
  fixture.emit({ kind: 'item', item: { id: 'running-tool', type: 'commandExecution', command: 'npm test', text: '', status: 'inProgress' } })
  await expect(activity).toBeVisible()
  fixture.emit({ kind: 'request', request: { requestId: 'activity-approval', method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } } })
  await expect(activity).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Agent approval' })).toBeVisible()
  fixture.emit({ kind: 'requests', requests: [] })
  await expect(activity).toBeVisible()
  fixture.emit({ kind: 'status', status: 'completed' })
  await expect(activity).toHaveCount(0)
  fixture.emit({ kind: 'status', status: 'running' })
  await expect(activity).toBeVisible()
  fixture.disconnectAgent()
  await expect(activity).toHaveCount(0)
})

test('Ctrl U clears the current composer line and keeps other lines', async ({ page }) => {
  await openConversation(page)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Clear this prompt')
  await page.keyboard.press('Control+u')
  await expect(input).toHaveValue('')
  await input.fill('Keep first\nClear this line\nKeep last')
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(16, 16))
  await page.keyboard.press('Control+u')
  await expect(input).toHaveValue('Keep first\n\nKeep last')
  await expect(input).toBeFocused()
  await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(11)
})

test('Ctrl J inserts a newline at the caret without submitting', async ({ page }) => {
  const fixture = await openConversation(page)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('FirstSecond')
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 5))
  await page.keyboard.press('Control+j')
  await expect(input).toHaveValue('First\nSecond')
  await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(6)
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 12))
  await page.keyboard.press('Control+j')
  await expect(input).toHaveValue('First\n\n')
  await expect(input).toBeFocused()
  expect(fixture.operations.filter(command => command.op === 'chat-send')).toHaveLength(0)
})

test('spawn return states update while the parent is idle and reports retain their source', async ({ page }) => {
  const chat = conversation()
  const launch: ChatLaunch = { id: '11111111-1111-4111-8111-111111111111', originChatId: chat.id,
    chatId: '22222222-2222-4222-8222-222222222222', projectId: null, project: 'Aixand', title: 'Child audit',
    instruction: 'Audit authentication', phase: 'started', status: 'running', url: '#/chat/22222222-2222-4222-8222-222222222222',
    needsInput: false, resultPreview: '', createdAt: 1, updatedAt: 2, revision: 1,
    resultDelivery: { state: 'waiting', outcome: null, messageId: 'return-message', reportAvailable: false } }
  chat.launches = [launch]
  const fixture = await openConversation(page, chat)
  const card = page.getByRole('article', { name: 'Child audit', exact: true })
  await expect(card.getByLabel('Result delivery')).toHaveText('The result will return here automatically.')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  fixture.emitLaunch({ ...launch, status: 'completed', revision: 2,
    resultDelivery: { ...launch.resultDelivery!, state: 'queued', outcome: 'completed', reportAvailable: true } })
  await expect(card.getByLabel('Result delivery')).toHaveText('Result queued for this chat')
  const source = { kind: 'chat' as const, id: launch.chatId, title: launch.title, url: launch.url!,
    messageType: 'delegation_result' as const, delegationId: launch.id, outcome: 'completed' as const }
  const text = 'Application-delivered report.\n' + JSON.stringify({ kind: 'delegation.result', delegationId: launch.id, report: '**Audit complete:** all checks passed.' })
  fixture.emit({ kind: 'item', item: { id: 'returned-report', type: 'userMessage', text, source } })
  const report = page.getByRole('article', { name: 'Result from Child audit', exact: true })
  await expect(report).toContainText('Audit complete: all checks passed.')
  await expect(report).not.toContainText('delegation.result')
  await expect(report.getByRole('link', { name: 'Child audit', exact: true })).toHaveAttribute('href', launch.url!)
  fixture.emitLaunch({ ...launch, status: 'completed', revision: 3,
    resultDelivery: { ...launch.resultDelivery!, state: 'processed', outcome: 'completed', reportAvailable: true } })
  await expect(card.getByLabel('Result delivery')).toHaveText('Returned result processed')
})

test('paused returned reports are readable and removable but cannot be edited', async ({ page }) => {
  const chat = conversation()
  chat.queue = { paused: true, reason: 'Queue paused because you pressed Stop.', messages: [{ id: 'return-1', status: 'queued', revision: 1, createdAt: 1,
    source: { kind: 'chat', id: 'child', title: 'Security audit', url: '#/chat/child', messageType: 'delegation_result', delegationId: 'delegation-1' },
    text: 'Report delivered.\n' + JSON.stringify({ kind: 'delegation.result', delegationId: 'delegation-1', report: 'Review the **authentication finding**.' }) }] }
  await openConversation(page, chat)
  const queue = page.getByRole('region', { name: 'Queued messages', exact: true })
  await expect(queue).toContainText('authentication finding')
  await expect(queue).toContainText('Result from Security audit')
  await expect(queue.getByRole('button', { name: 'Resume queue', exact: true })).toBeVisible()
  await expect(queue.getByRole('button', { name: 'Remove queued message', exact: true })).toBeVisible()
  await expect(queue.getByRole('button', { name: 'Edit queued message', exact: true })).toHaveCount(0)
})

test('conversation details label full access without calling it workspace write', async ({ page }) => {
  const chat = { ...conversation(), accessMode: 'danger-full-access' as const, permissionMode: 'full-access' as const, approvalPolicy: 'never' as const }
  await openConversation(page, chat)
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  await expect(page.getByRole('dialog').getByText('Full access / YOLO', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog').getByText('Workspace write', { exact: true })).toHaveCount(0)
})

test('failed automatic approval keeps the error and manual response available', async ({ page }) => {
  const fixture = await openConversation(page)
  const requestId = 'a'.repeat(32)
  fixture.emit({ kind: 'request', request: { requestId, method: 'item/commandExecution/requestApproval',
    params: { command: 'npm test' }, autoApprovalError: 'Approval delivery lost' } })
  await expect(page.getByRole('alert')).toContainText('Automatic approval failed: Approval delivery lost')
  await page.getByRole('button', { name: 'Approve once', exact: true }).click()
  await expect.poll(() => fixture.operations.find(row => row.op === 'chat-answer')?.args).toMatchObject({ requestId, decision: 'accept' })
})

test('chat circles appear only while working and follow background requests', async ({ page }) => {
  const fixture = await openConversation(page)
  const status = page.getByRole('status', { name: 'Conversation status', exact: true })
  const historyStatus = page.locator('.command-history-sidebar .command-history-item .chat-status')
  await expect(status).toHaveText('Done')
  await expect(historyStatus).toHaveText('Done')
  await expect(status.locator('.chat-status-indicator')).toHaveCount(0)
  await expect(historyStatus.locator('.chat-status-indicator')).toHaveCount(0)
  await expect(page.locator('.command-history-meta, .chat-history-project-label, .command-history-child-count')).toHaveCount(0)
  fixture.emit({ kind: 'status', status: 'running' })
  await expect(status).toHaveText('Working')
  await expect(historyStatus).toHaveText('Working')
  await expect(status.locator('.chat-status-indicator')).toBeVisible()
  await expect(historyStatus.locator('.chat-status-indicator')).toBeVisible()
  await expect(status.locator('.chat-status-indicator')).toHaveCSS('animation-name', 'chat-status-pulse')
  await expect(status.locator('.bbb-visually-hidden')).toHaveCSS('position', 'absolute')
  await expect(page.locator('.command-chat-status')).toHaveCount(0)

  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  fixture.emit({ kind: 'request', request: { requestId: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } } })
  await expect(historyStatus).toHaveText('Waiting for you')
  await expect(historyStatus.locator('.chat-status-indicator')).toHaveCount(0)
  fixture.emit({ kind: 'requests', requests: [] })
  await expect(historyStatus).toHaveText('Working')
  await expect(historyStatus.locator('.chat-status-indicator')).toBeVisible()
  fixture.emit({ kind: 'status', status: 'completed' })
  await expect(historyStatus).toHaveText('Done')
  await expect(historyStatus.locator('.chat-status-indicator')).toHaveCount(0)
  fixture.disconnectAgent()
  await expect(historyStatus).toHaveText('Disconnected')

  await page.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('button', { name: /^Improve the command page/ }).click()
  for (const [state, label] of [['interrupted', 'Stopped'], ['failed', 'Failed'], ['uncertain', 'Status unknown'], ['running', 'Working'], ['completed', 'Done']]) {
    fixture.emit({ kind: 'status', status: state })
    await expect(status).toHaveText(label)
    await expect(historyStatus).toHaveText(label)
    await expect(status.locator('.chat-status-indicator')).toHaveCount(state === 'running' ? 1 : 0)
    await expect(historyStatus.locator('.chat-status-indicator')).toHaveCount(state === 'running' ? 1 : 0)
  }
  fixture.emit({ kind: 'status', status: 'offline', statusReason: 'session_ended' })
  await expect(status).toHaveText('Disconnected')
  await expect(historyStatus).toHaveText('Disconnected')
  fixture.disconnectAgent()
  await expect(status).toHaveText('Disconnected')
  await expect(historyStatus).toHaveText('Disconnected')
  fixture.emit({ kind: 'request', request: { requestId: 'resumed-approval', method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } } })
  await expect(status).toHaveText('Waiting for you')
  await expect(historyStatus).toHaveText('Waiting for you')
  fixture.emit({ kind: 'status', status: 'completed', statusReason: null })
  await expect(status).toHaveText('Done')
  await expect(historyStatus).toHaveText('Done')
  fixture.emit({ kind: 'terminal', terminal: terminal('running') })
  await expect(status).toHaveText('Done')
  await expect(historyStatus).toHaveText('Done')
  await expect(status.locator('.chat-status-indicator')).toHaveCount(0)
  await expect(historyStatus.locator('.chat-status-indicator')).toHaveCount(0)
  fixture.emit({ kind: 'status', status: 'running', turnId: 'terminal-turn' })
  await expect(status).toHaveText('Working')
  fixture.emit({ kind: 'request', request: { requestId: 'terminal-approval', method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } } })
  await expect(status).toHaveText('Waiting for you')
  await expect(historyStatus).toHaveText('Waiting for you')
})

test('typing stays responsive in a long conversation and preserves earlier content during streaming', async ({ page }) => {
  const chat = conversation()
  const formatted = `${reply}\n\n| Check | Result |\n| --- | --- |\n| Rendering | Complete |\n\n`.repeat(4)
  chat.items = Array.from({ length: 150 }, (_, index) => ({
    id: `message-${index}`, type: index % 2 ? 'agentMessage' : 'userMessage',
    text: index % 2 ? formatted : `Investigate step ${index}.`,
  }))
  const fixture = await openConversation(page, chat)
  await expect(page.locator('.command-chat-message')).toHaveCount(10)
  await expect(page.getByRole('button', { name: 'Load older messages', exact: true })).toBeAttached()
  const link = await page.getByRole('link', { name: 'View the project' }).first().elementHandle()
  const table = await page.locator('.command-table-scroll').first().elementHandle()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.focus()
  const timings = await input.evaluate(async (textarea) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    const samples: number[] = []
    for (const letter of 'Follow up now') {
      const started = performance.now()
      setValue.call(textarea, textarea.value + letter)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      samples.push(performance.now() - started)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    return samples.slice(2).sort((left, right) => left - right)
  })
  // Measure synchronous input work, excluding automation/network/frame delays.
  // A generous budget catches reparsing the entire transcript on each character.
  expect(timings[Math.floor(timings.length / 2)]).toBeLessThan(100)
  await expect(input).toHaveValue('Follow up now')
  expect(await link!.evaluate((element) => element.isConnected)).toBe(true)
  expect(await table!.evaluate((element) => element.isConnected)).toBe(true)

  fixture.emit({ kind: 'status', status: 'running', turnId: 'next-turn' })
  fixture.emit({ kind: 'delta', itemId: 'streaming-reply', itemType: 'agentMessage', text: 'A new streamed reply' })
  await expect(page.getByText('A new streamed reply', { exact: true })).toBeVisible()
  await input.pressSequentially(' please')
  await expect(input).toHaveValue('Follow up now please')
  expect(await link!.evaluate((element) => element.isConnected)).toBe(true)
  expect(await table!.evaluate((element) => element.isConnected)).toBe(true)
})

for (const theme of ['light', 'dark']) {
  test(`chat circles and single-line history fit narrow screens in ${theme} mode`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('aixand.appearance', value), theme)
    await page.setViewportSize({ width: 320, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const chat = conversation()
    chat.title += ' with a long conversation title that should truncate rather than wrap onto a second line'
    chat.status = 'running'
    chat.items[chat.items.length - 1].text = 'I’m checking the conversation status indicators.'
    const fixture = await openConversation(page, chat)
    const status = page.getByRole('status', { name: 'Conversation status', exact: true })
    await expect(status).toHaveText('Working')
    await expect(status.locator('.chat-status-indicator')).toHaveCSS('animation-name', 'none')
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    fixture.emit({ kind: 'status', status: 'waiting' })
    await expect(status).toHaveText('Waiting for you')
    const bounds = (await status.boundingBox())!
    const stopBounds = (await page.getByRole('button', { name: 'Stop', exact: true }).boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320)
    expect(bounds.x + bounds.width <= stopBounds.x || bounds.y >= stopBounds.y + stopBounds.height || bounds.y + bounds.height <= stopBounds.y).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const sendBounds = (await page.getByRole('button', { name: 'Add to current turn', exact: true }).boundingBox())!
    const callBounds = (await page.getByRole('button', { name: 'Vox assistant', exact: true }).boundingBox())!
    expect(sendBounds.y + sendBounds.height).toBeLessThanOrEqual(callBounds.y)
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: `artifacts/chat-status/${theme}-mobile.png`, fullPage: true })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await expect(page.getByRole('heading', { name: chat.title, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `artifacts/chat-status/${theme}-mobile-enlarged.png`, fullPage: true })
    await page.evaluate(() => { document.documentElement.style.fontSize = '' })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect(page.locator('.command-history-sidebar .chat-status')).toHaveText('Waiting for you')
    const historyTitle = page.locator('.command-history-sidebar .chat-history-title')
    await expect(historyTitle).toHaveAttribute('title', chat.title)
    await expect(historyTitle).toHaveCSS('white-space', 'nowrap')
    await expect(historyTitle).toHaveCSS('text-overflow', 'ellipsis')
    expect(await historyTitle.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
    expect(await historyTitle.evaluate(element => element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) + 1)).toBe(true)
    await expect(page.locator('.command-history-sidebar .chat-status-indicator')).toHaveCount(0)
    await page.screenshot({ path: `artifacts/chat-status/${theme}-desktop.png`, fullPage: true })
  })
}

function savedDiscovery(): Discovery {
  return { id: 'discovery-job', origin: { kind: 'chat', id: chatId }, sourceTurnId: 'first-turn', sourceCallId: 'discover-call',
    root: '/work/projects', requestedRoot: '/work/projects', mode: 'add', includeNested: false, exclude: [], defaultExclusions: [],
    state: 'completed', scanComplete: true, revision: 1, createdAt: 1, updatedAt: 1, url: null,
    stats: {}, warnings: [], reasons: [], registration: { selected: 5, added: 5, existing: 0, unavailable: 0, capacity: 195, projectIds: [] } }
}

test('discovery, spawned-session, and workflow cards stay with their original turns across updates and reloads', async ({ page }) => {
  const chat = conversation()
  chat.items = [
    { id: 'first-user', type: 'userMessage', text: 'Discover my projects', turnId: 'first-turn' },
    { id: 'discover-call', type: 'dynamicToolCall', text: 'discover_projects', status: 'completed', turnId: 'first-turn' },
    { id: 'first-reply', type: 'agentMessage', text: 'Projects discovered', turnId: 'first-turn' },
    { id: 'second-user', type: 'userMessage', text: 'Follow-up question', turnId: 'second-turn' },
    { id: 'launch-call', type: 'dynamicToolCall', text: 'start_project_chat', status: 'completed', turnId: 'second-turn' },
    { id: 'second-reply', type: 'agentMessage', text: 'Investigation started', turnId: 'second-turn' },
    { id: 'third-user', type: 'userMessage', text: 'Latest question', turnId: 'third-turn' },
    { id: 'third-reply', type: 'agentMessage', text: 'Latest answer', turnId: 'third-turn' },
  ]
  chat.discoveries = [savedDiscovery()]
  chat.launches = [{ id: 'launch-job', originChatId: chatId, sourceTurnId: 'second-turn', sourceCallId: 'launch-call',
    chatId: 'child-chat', projectId: 'project', project: 'Aixand', title: 'Saved investigation', instruction: 'Inspect the project',
    phase: 'started', status: 'completed', url: null, needsInput: false, resultPreview: 'Done', createdAt: 2, updatedAt: 2, revision: 1 }]
  chat.workflows = [{ key: 'workflow-job', id: 'JOB-1', originChatId: chatId, sourceTurnId: 'first-turn',
    projectId: 'project', project: 'Aixand', title: 'Saved workflow', state: 'completed', revision: 1, createdAt: 1, updatedAt: 1, steps: [] }]
  const fixture = await openConversation(page, chat)
  const discovery = page.getByRole('article', { name: 'Discovery under /work/projects', exact: true })
  const investigation = page.getByRole('article', { name: 'Saved investigation', exact: true })
  const workflow = page.getByRole('article', { name: 'Saved workflow', exact: true })
  async function expectBefore(card: typeof discovery, text: string) {
    await expect(card).toBeVisible()
    expect(await card.evaluate((element, text) => {
      const message = [...document.querySelectorAll('.command-chat-message')].find((node) => node.textContent?.includes(text))!
      return Boolean(element.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING)
    }, text)).toBe(true)
    await expect(card.locator('xpath=ancestor::*[@role="log"]')).toHaveCount(1)
    await expect(card.locator('xpath=ancestor::details')).toHaveCount(0)
  }
  await expectBefore(discovery, 'Follow-up question')
  await expectBefore(workflow, 'Follow-up question')
  await expectBefore(investigation, 'Latest question')
  chat.discoveries[0] = { ...chat.discoveries[0], revision: 2, registration: { ...chat.discoveries[0].registration!, added: 6 } }
  fixture.emitDiscovery(chat.discoveries[0])
  await expect(discovery).toContainText('Added 6 projects')
  await expectBefore(discovery, 'Follow-up question')
  await page.reload()
  await expect(discovery).toContainText('Added 6 projects')
  await expectBefore(discovery, 'Follow-up question')
  await expectBefore(workflow, 'Follow-up question')
  await expectBefore(investigation, 'Latest question')
})

test('legacy discovery cards use the original saved tool output rather than a later status request', async ({ page }) => {
  const chat = conversation()
  const job = { ...savedDiscovery(), sourceTurnId: undefined, sourceCallId: undefined }
  chat.discoveries = [job]
  chat.items = [
    { id: 'first', type: 'userMessage', text: 'Find my projects' },
    { id: 'original-call', type: 'dynamicToolCall', text: `discover_projects\n${JSON.stringify(job)}`, status: 'completed' },
    { id: 'reply', type: 'agentMessage', text: 'Original discovery reply' },
    { id: 'later', type: 'userMessage', text: 'Check progress later' },
    { id: 'status-call', type: 'dynamicToolCall', text: `get_project_discovery\n${JSON.stringify(job)}`, status: 'completed' },
  ]
  await openConversation(page, chat)
  const log = page.getByRole('log', { name: 'Conversation messages' })
  const entries = await log.locator(':scope > *').allTextContents()
  expect(entries.findIndex((text) => text.includes('Project discovery'))).toBeLessThan(entries.findIndex((text) => text.includes('Original discovery reply')))
  await expect(log.getByRole('article', { name: 'Discovery under /work/projects', exact: true })).toHaveCount(1)
})

test('cards whose origin was truncated are placed before the retained conversation', () => {
  const job = savedDiscovery()
  const entries = toolCardEntries([{ id: 'recent', type: 'userMessage', text: 'Latest message', turnId: 'latest-turn' }], [{ kind: 'discovery', value: job }])
  expect(entries.map((entry) => entry.kind)).toEqual(['card', 'message'])
  const legacy = { ...job, sourceTurnId: undefined, sourceCallId: undefined }
  const statusEntries = toolCardEntries([
    { id: 'recent', type: 'userMessage', text: 'Check the old discovery' },
    { id: 'status', type: 'dynamicToolCall', text: `get_project_discovery\n${JSON.stringify(legacy)}` },
  ], [{ kind: 'discovery', value: legacy }])
  expect(statusEntries.map((entry) => entry.kind)).toEqual(['card', 'message', 'activity'])
})

test('the toolbar title is compact and full conversation details open from the information button', async ({ page }) => {
  const chat = conversation()
  chat.title += ' with a longer title that stays available in the conversation information'
  chat.model = 'fixture-fast'
  await openConversation(page, chat)
  await expect(page).toHaveURL(`/#/chat/${chatId}`)
  await page.evaluate((id) => { window.location.hash = `/command/${id}` }, chatId)
  await expect(page).toHaveURL(`/#/chat/${chatId}`)
  await page.reload()
  await expect(page.getByRole('region', { name: 'Agent conversation', exact: true })).toBeVisible()
  const title = page.getByRole('heading', { name: chat.title, exact: true })
  expect(Array.from(await title.innerText())).toHaveLength(64)
  await expect(title).toHaveAttribute('title', chat.title)
  await expect(page.locator('.command-toolbar').getByRole('button', { name: 'New project', exact: true })).toHaveCount(0)
  const trigger = page.getByRole('button', { name: 'Conversation information', exact: true })
  const information = page.getByRole('dialog', { name: 'Conversation information', exact: true })
  await expect(information).toHaveCount(0)
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(information).toContainText(chat.title)
  await expect(information).toContainText(chat.profile)
  await expect(information).toContainText(chat.project)
  await expect(information).toContainText(chat.model)
  await expect(information.getByRole('button', { name: 'Spawn terminal', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(information).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('tools expand separately from formatted replies, and code and responses can be copied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openConversation(page)
  const activity = page.locator('.command-activity-group')
  await expect(activity).toHaveCount(1)
  await expect(activity.locator(':scope > summary')).toContainText('3 tools used')
  await expect(activity).not.toHaveAttribute('open', '')
  await expect(page.getByText('Reviewing the conversation layout.', { exact: true })).toBeHidden()
  await expect(page.getByRole('heading', { name: 'A clearer conversation' })).toBeVisible()
  await expect(page.locator('.command-message-content strong')).toHaveText('separate')
  await expect(page.getByRole('link', { name: 'View the project' })).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(page.getByRole('link', { name: 'View the project' })).toHaveAttribute('target', '_blank')
  await page.screenshot({ path: 'artifacts/command-ui/desktop.png', fullPage: true })
  await activity.locator(':scope > summary').press('Enter')
  await expect(activity.locator('.command-tool-activity')).toHaveCount(4)
  const command = activity.locator('.command-tool-activity').filter({ hasText: 'Ran a command' })
  await command.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(command.locator('pre')).toHaveText('src/workspace/ChatPage.tsx\nsrc/workspace/chat.css')
  await expect(command.locator('.command-tool-status')).toHaveText('Done')
  await page.getByRole('button', { name: 'Copy code', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('const message = "Hello"')
  await page.locator('.command-chat-message').filter({ has: page.getByRole('heading', { name: 'A clearer conversation' }) }).hover()
  await page.getByRole('button', { name: 'Copy response', exact: true }).last().click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(reply)
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Conversation information', exact: true })).toContainText('/workspace/aixand')
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Project directory')).toHaveCount(0)
  await page.screenshot({ path: 'artifacts/command-ui/desktop-expanded.png', fullPage: true })
})

test('Mermaid fences render inline alongside Markdown and code, with source copying', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const flowchart = 'flowchart LR\nA[Question] --> B[Answer]'
  const sequence = 'sequenceDiagram\nUser->>Agent: Hello\nAgent-->>User: Welcome'
  const chat = conversation()
  chat.items = [{ id: 'reply', type: 'agentMessage', text: [
    '## Diagrams', 'An inline `mermaid` example.',
    `\`\`\`mermaid\n${flowchart}\n\`\`\``,
    `~~~Mermaid\n${sequence}\n~~~`,
    '```ts\nconst answer = 42\n```', 'Explanation after the diagrams.',
  ].join('\n\n') }]
  await openConversation(page, chat)
  const response = page.getByRole('article', { name: 'work message', exact: true })
  const diagrams = response.getByRole('img', { name: 'Mermaid diagram', exact: true })
  await expect(diagrams).toHaveCount(2, { timeout: 15_000 })
  await expect(diagrams.first()).toContainText('Question')
  await expect(diagrams.last()).toContainText('Welcome')
  const ids = await diagrams.locator(':scope > svg').evaluateAll(nodes => nodes.map(node => node.id))
  expect(new Set(ids).size).toBe(2)
  await expect(response.getByRole('heading', { name: 'Diagrams', exact: true })).toBeVisible()
  await expect(response.locator('p code')).toHaveText('mermaid')
  await expect(response.getByText('Explanation after the diagrams.', { exact: true })).toBeVisible()
  await expect(response.locator('pre code.language-ts')).toHaveText('const answer = 42\n')
  await expect(response.locator('pre code.language-mermaid').first()).toBeHidden()
  await response.getByText('View source', { exact: true }).first().click()
  await expect(response.locator('pre code.language-mermaid').first()).toBeVisible()
  await expect(response.locator('pre code.language-mermaid').first()).toHaveText(flowchart)
  await response.getByRole('button', { name: 'Copy diagram source', exact: true }).first().click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(flowchart)
})

test('Mermaid diagrams recover from incomplete streamed definitions and preserve completed diagrams', async ({ page }) => {
  const chat = conversation()
  chat.status = 'running'
  chat.items = [{ id: 'reply', type: 'agentMessage', text: '```mermaid\nflowchart TD\nA[Start] --> B[' }]
  const fixture = await openConversation(page, chat)
  const response = page.getByRole('article', { name: 'work message', exact: true })
  const diagram = response.getByRole('img', { name: 'Mermaid diagram', exact: true })
  const fallback = response.getByText('Unable to render diagram. Showing the source.', { exact: true })
  await expect(fallback).toBeVisible({ timeout: 15_000 })
  await expect(response.locator('pre code')).toContainText('A[Start] --> B[')
  await expect(page.locator('body > div[aria-hidden="true"] svg')).toHaveCount(0)
  fixture.emit({ kind: 'delta', itemId: 'reply', itemType: 'agentMessage', text: 'End]\n' })
  await expect(diagram).toContainText('End')
  fixture.emit({ kind: 'delta', itemId: 'reply', itemType: 'agentMessage', text: 'B --> C[' })
  await expect(fallback).toBeVisible()
  await expect(diagram).toHaveCount(0)
  fixture.emit({ kind: 'delta', itemId: 'reply', itemType: 'agentMessage', text: 'Complete]\n```\n\nFinished.' })
  await expect(diagram).toContainText('Complete')
  const completed = await diagram.locator('svg').elementHandle()
  fixture.emit({ kind: 'status', status: 'completed' })
  fixture.emit({ kind: 'status', status: 'running' })
  fixture.emit({ kind: 'delta', itemId: 'next-reply', itemType: 'agentMessage', text: 'A new reply.' })
  await expect(page.getByText('A new reply.', { exact: true })).toBeVisible()
  expect(await completed!.evaluate(element => element.isConnected)).toBe(true)
})

test('Mermaid diagrams follow the chat theme, fit mobile screens, and disable active content', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aixand.appearance', 'light'))
  const chat = conversation()
  chat.items = [{ id: 'reply', type: 'agentMessage', text: [
    '```mermaid',
    '%%{init: {"securityLevel": "loose", "htmlLabels": true}}%%',
    'flowchart LR',
    'A["<img src=x onerror=window.mermaidExecuted=true>"] --> B[Safe]',
    'click B "javascript:window.mermaidExecuted=true"',
    '```',
  ].join('\n') }]
  await openConversation(page, chat)
  const diagram = page.getByRole('img', { name: 'Mermaid diagram', exact: true })
  await expect(diagram).toBeVisible({ timeout: 15_000 })
  await expect(diagram).toContainText('Safe')
  const lightStyle = await diagram.locator('svg > style').textContent()
  await page.getByRole('button', { name: /^Color mode:/ }).click()
  await page.keyboard.press('Escape')
  await expect(diagram).toBeVisible()
  await expect.poll(() => diagram.locator('svg > style').textContent()).not.toBe(lightStyle)
  await page.setViewportSize({ width: 320, height: 844 })
  await diagram.scrollIntoViewIfNeeded()
  const bounds = (await diagram.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(diagram.locator('script, iframe, img, foreignObject, [onerror], a[href]')).toHaveCount(0)
  expect(await page.evaluate(() => 'mermaidExecuted' in window)).toBe(false)
})

test('chat renders escaped paragraphs in user messages and streamed replies while preserving code escapes', async ({ page }) => {
  const chat = conversation()
  chat.status = 'running'
  chat.items = [
    { id: 'user-1', type: 'userMessage', text: String.raw`**Formatted request**\n\n- First task\n- Second task` },
    { id: 'reply', type: 'agentMessage', text: [
      String.raw`## Rendered response\n\nFirst paragraph.\n\nSecond paragraph.\nAnother line.`,
      '',
      'Keep `\\n\\n` literal in code.',
      '',
      '```js',
      String.raw`const separator = "\n\n";`,
      '```',
      '',
      '<pre><code>HTML code \\n\\n</code></pre>',
      '',
      String.raw`~~~txt\nEncoded code block\nSecond code line\n~~~`,
    ].join('\n') },
  ]
  const fixture = await openConversation(page, chat)
  const user = page.getByRole('article', { name: 'Your message', exact: true })
  await expect(user.locator('strong')).toHaveText('Formatted request')
  await expect(user.getByRole('listitem')).toHaveText(['First task', 'Second task'])
  const response = page.getByRole('article', { name: 'work message', exact: true })
  await expect(response.getByRole('heading', { name: 'Rendered response' })).toBeVisible()
  await expect(response.locator('.command-message-content > p').nth(0)).toHaveText('First paragraph.')
  await expect(response.locator('.command-message-content > p').nth(1)).toHaveText('Second paragraph.\nAnother line.', { useInnerText: true })
  await expect(response.locator('p code')).toHaveText(String.raw`\n\n`)
  await expect(response.locator('pre code').nth(0)).toHaveText(String.raw`const separator = "\n\n";`)
  await expect(response.locator('pre code').nth(1)).toHaveText(String.raw`HTML code \n\n`)
  await expect(response.locator('pre code').nth(2)).toHaveText('Encoded code block\nSecond code line\n')
  fixture.emit({ kind: 'delta', itemId: 'reply', itemType: 'agentMessage', text: String.raw`\n\nA streamed paragraph.` })
  await expect(response.locator('.command-message-content > p').last()).toHaveText('A streamed paragraph.')
})

test('messages sent from Vox or another conversation display their origin', async ({ page }) => {
  const chat = conversation()
  chat.items = [
    { id: 'vox-message', type: 'userMessage', text: 'Create a plan from the audit findings.', source: { kind: 'vox', id: 'voice-session', title: 'Vox' } },
    { id: 'chat-message', type: 'userMessage', text: 'Explain the security finding.', source: {
      kind: 'chat', id: 'source-chat', title: 'Original Undercurrent discussion', url: '#/chat/source-chat',
    } },
  ]
  await openConversation(page, chat)
  await expect(page.getByRole('article', { name: 'Sent via Vox', exact: true })).toContainText('Sent via Vox')
  await expect(page.getByRole('article', { name: 'Sent via Original Undercurrent discussion', exact: true })
    .getByRole('link', { name: 'Original Undercurrent discussion' })).toHaveAttribute('href', '#/chat/source-chat')
})

test('chat renders HTML formatting and copies HTML code without allowing active content', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const chat = conversation()
  chat.items = [
    { id: 'user-1', type: 'userMessage', text: '<p>A <strong>formatted request</strong><br>with a line break.</p>' },
    { id: 'reply', type: 'agentMessage', text: [
      '<h2>HTML response</h2>',
      '<p>A <strong>formatted reply</strong><br>with a line break.</p>',
      '<table><thead><tr><th>Status</th></tr></thead><tbody><tr><td>Ready</td></tr></tbody></table>',
      '<pre>const message = "HTML code";</pre>',
      '<script>window.chatHtmlExecuted = true</script>',
      '<img src="/missing-chat-image" onerror="window.chatHtmlExecuted = true">',
      '<a href="javascript:window.chatHtmlExecuted=true">Unsafe link</a>',
      '<iframe srcdoc="<script>parent.chatHtmlExecuted=true</script>"></iframe>',
    ].join('\n\n') },
  ]
  await openConversation(page, chat)
  const user = page.getByRole('article', { name: 'Your message', exact: true })
  await expect(user.locator('strong')).toHaveText('formatted request')
  await expect(user.locator('br')).toHaveCount(1)
  const response = page.getByRole('article', { name: 'work message', exact: true })
  await expect(response.getByRole('heading', { name: 'HTML response' })).toBeVisible()
  await expect(response.locator('strong').last()).toHaveText('formatted reply')
  await expect(response.locator('br')).toHaveCount(1)
  await expect(response.getByRole('table')).toContainText('Ready')
  await response.getByRole('button', { name: 'Copy code', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('const message = "HTML code";')
  await expect(response.locator('script, iframe, [onerror]')).toHaveCount(0)
  await expect(response.getByText('Unsafe link', { exact: true })).not.toHaveAttribute('href')
  expect(await page.evaluate(() => 'chatHtmlExecuted' in window)).toBe(false)
})

test('general chats hide directories and selecting then clearing a project restores the general chat layout', async ({ page }) => {
  const chat = conversation()
  chat.project = ''
  chat.mode = 'chat'
  chat.cwd = '/private/scratch/conversation-ui'
  await openConversation(page, chat)
  await expect(page.locator('.command-directory-context')).toHaveCount(0)
  await expect(page.getByLabel('Project directory')).toHaveCount(0)
  await expect(page.getByText(chat.cwd, { exact: true })).toHaveCount(0)
  await (await openChatSettings(page)).getByRole('button', { name: / Project$/ }).click()
  await page.getByRole('option', { name: /^Aixand/ }).click()
  await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible()
  await expect(page.locator('.command-composer-options > .command-context-picker--project')).toContainText('Aixand')
  await (await openChatSettings(page)).getByRole('button', { name: / Project$/ }).click()
  await page.getByRole('option', { name: /^No project/ }).click()
  await expect(page.getByRole('heading', { name: 'Where should we start?' })).toBeVisible()
  await expect(page.locator('.command-directory-context')).toHaveCount(0)
  await expect(page.getByLabel('Project directory')).toHaveCount(0)
})

test('streaming follows the latest reply, preserves reading position, and keeps Stop available', async ({ page }) => {
  const chat = conversation()
  chat.status = 'running'
  chat.items[chat.items.length - 1].text = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}. This response is being streamed.`).join('\n\n')
  const fixture = await openConversation(page, chat)
  const scroll = page.locator('.command-transcript-scroll')
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(5)
  await scroll.hover()
  await page.mouse.wheel(0, -700)
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
  await expect(page.getByRole('status', { name: 'Conversation status', exact: true })).toBeInViewport()
  await expect(page.getByRole('status', { name: 'Conversation status', exact: true })).toHaveText('Working')
  const position = await scroll.evaluate((element) => element.scrollTop)
  fixture.emit({ kind: 'delta', itemId: 'reply', itemType: 'agentMessage', text: '\n\nA newly streamed paragraph.' })
  await expect(page.getByText('A newly streamed paragraph.', { exact: true })).toHaveCount(1)
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(position)
  await page.getByRole('button', { name: 'Jump to latest' }).click()
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(5)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  expect(fixture.operations.some((message) => message.op === 'chat-interrupt')).toBe(true)
  fixture.emit({ kind: 'status', status: 'interrupted' })
  await expect(page.locator('.command-chat-status')).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'Conversation status', exact: true })).toHaveText('Stopped')
  await expect(page.locator('.chat-status-indicator')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
})

test('tool failures remain visible and requests can be answered', async ({ page }) => {
  const chat = conversation()
  chat.status = 'waiting'
  chat.items.splice(-1)
  chat.items.push({ id: 'failed-command', type: 'commandExecution', command: 'npm test', text: 'A test failed.', status: 'completed', exitCode: 1 })
  chat.requests.push({ requestId: 'question', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'scope', header: 'Scope', question: 'Which layout should I use?', options: [{ label: 'Compact', description: 'Keep the controls compact.' }] }] } })
  const fixture = await openConversation(page, chat)
  await expect(page.getByText('Needs attention', { exact: true })).toBeVisible()
  await page.locator('.command-activity-summary').click()
  await expect(page.getByText('Exit 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Compact', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Compact', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Send answers', exact: true }).click()
  expect(fixture.operations.find((message) => message.op === 'chat-answer')?.args.answers).toEqual({ scope: 'Compact' })
})

test('background activity stays above the input after the main turn finishes', async ({ page }) => {
  const keyWarnings: string[] = []
  page.on('console', message => {
    if (message.text().includes('Encountered two children with the same key')) keyWarnings.push(message.text())
  })
  const background: BackgroundActivity = {
    agentsAvailability: 'ready', processesAvailability: 'ready',
    agents: [{ id: 'native-child', parentId: chatId, title: 'Review tests', preview: 'Inspect test coverage', status: 'running', needsInput: false, canInspect: true, canStop: false, source: 'provider' }],
    processes: [{ id: 'process-42', command: 'npm run dev', cwd: '/workspace/aixand', status: 'running', canStop: true, source: 'provider' }],
  }
  const fixture = await openConversation(page, conversation(), background)
  const strip = page.getByRole('group', { name: 'Background activity', exact: true })
  await expect(strip).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep my draft')
  await strip.locator(':scope > summary').click()
  await expect(strip.getByText('npm run dev', { exact: true })).toBeVisible()
  expect((await strip.boundingBox())!.y).toBeLessThan((await input.boundingBox())!.y)
  await page.screenshot({ path: test.info().outputPath('background-panel.png') })
  await strip.getByRole('button', { name: 'View conversation', exact: true }).click()
  await expect(strip.getByText('Reviewing the background task.', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('Keep my draft')
  await strip.getByRole('button', { name: 'View output', exact: true }).click()
  await expect(strip.getByText('Development server listening on port 3000.', { exact: true })).toBeVisible()
  await strip.getByRole('button', { name: 'Stop process', exact: true }).click()
  await expect(strip.getByRole('region', { name: 'Background processes', exact: true })).toHaveCount(0)
  expect(fixture.operations.find(row => row.op === 'chat-background-stop')?.args.processId).toBe('process-42')
  await expect(input).toHaveValue('Keep my draft')
  expect(keyWarnings).toEqual([])
})

test('older backends keep the shared connection and running sidebar indicator without background polling', async ({ page }) => {
  await page.clock.install()
  const chat = conversation()
  chat.status = 'running'
  chat.turnId = 'active-turn'
  // A cached newer snapshot must not override an older gateway's protocol.
  chat.chatCapabilities = { queue: true, steer: true, workflows: false, background: true }
  const fixture = await openConversation(page, chat, undefined, 0, false)
  const history = page.getByRole('region', { name: 'Recent conversations', exact: true })
  await expect(history.locator('.chat-status-indicator')).toBeVisible()
  await page.clock.runFor(11000)
  expect(fixture.operations.filter(row => row.op.startsWith('chat-background'))).toEqual([])
  await expect(history.locator('.chat-status-indicator')).toBeVisible()
  await expect(page.getByText('Background status unavailable. Last known activity is shown.', { exact: true })).toHaveCount(0)
})

test('older retained workers are not polled through a newer backend', async ({ page }) => {
  await page.clock.install()
  const fixture = await openConversation(page)
  await page.clock.runFor(11000)
  expect(fixture.operations.filter(row => row.op.startsWith('chat-background'))).toEqual([])
})

test('question cards keep answers while navigating and display option descriptions', async ({ page }) => {
  const chat = conversation()
  chat.status = 'waiting'
  chat.requests = [{ requestId: 'questions', method: 'item/tool/requestUserInput', params: { questions: [
    { id: 'layout', header: 'Layout', question: 'Which layout?', isOther: true, options: [{ label: 'Compact', description: 'Use less space.' }] },
    { id: 'name', header: 'Name', question: 'What should we call it?' },
  ] } }]
  const fixture = await openConversation(page, chat)
  const form = page.getByRole('form', { name: 'Agent questions', exact: true })
  await expect(form.getByText('Use less space.', { exact: true })).toBeVisible()
  await form.getByRole('button', { name: 'Compact', exact: true }).click()
  await form.getByRole('button', { name: 'Next question', exact: true }).click()
  await form.getByRole('textbox', { name: 'Your answer', exact: true }).fill('Studio')
  await form.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(form.getByRole('button', { name: 'Compact', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await form.getByRole('button', { name: 'Next question', exact: true }).click()
  await expect(form.getByRole('textbox', { name: 'Your answer', exact: true })).toHaveValue('Studio')
  await form.getByRole('button', { name: 'Send answers', exact: true }).click()
  expect(fixture.operations.find(row => row.op === 'chat-answer')?.args.answers).toEqual({ layout: 'Compact', name: 'Studio' })
})

test('background Stop retries preserve operation identity', async ({ page }) => {
  const background: BackgroundActivity = { agentsAvailability: 'ready', processesAvailability: 'ready', agents: [],
    processes: [{ id: 'p', command: 'npm run dev', cwd: '/work', status: 'running', canStop: true, source: 'provider' }] }
  const fixture = await openConversation(page, conversation(), background, 1)
  const strip = page.getByRole('group', { name: 'Background activity', exact: true })
  await strip.locator(':scope > summary').click()
  await strip.getByRole('button', { name: 'Stop process', exact: true }).click()
  await expect(strip.getByRole('alert')).toHaveText('Stop delivery is unconfirmed.')
  await expect(strip.getByText('npm run dev', { exact: true })).toBeVisible()
  await strip.getByRole('button', { name: 'Stop process', exact: true }).click()
  await expect.poll(() => fixture.operations.filter(row => row.op === 'chat-background-stop').length).toBe(2)
  const attempts = fixture.operations.filter(row => row.op === 'chat-background-stop')
  expect(attempts[0].args.key).toBe(attempts[1].args.key)
})

test('background processes remain visible with disabled controls after disconnect', async ({ page }) => {
  const background: BackgroundActivity = { agentsAvailability: 'ready', processesAvailability: 'ready', agents: [],
    processes: [{ id: 'p', command: 'npm run dev', cwd: '/work', status: 'running', canStop: true, source: 'provider' }] }
  const fixture = await openConversation(page, conversation(), background)
  const strip = page.getByRole('group', { name: 'Background activity', exact: true })
  await strip.locator(':scope > summary').click()
  await expect(strip.getByText('npm run dev', { exact: true })).toBeVisible()
  fixture.disconnectAgent()
  await expect(strip.getByRole('button', { name: 'Stop process', exact: true })).toBeDisabled()
  await expect(strip.getByText('npm run dev', { exact: true })).toBeVisible()
  await expect(strip.getByText('Status unavailable', { exact: true })).toBeVisible()
})

test('native child questions can be answered from the background preview', async ({ page }) => {
  const chat = conversation()
  chat.status = 'waiting'
  chat.requests = [{ requestId: 'child-question', method: 'item/tool/requestUserInput', params: { threadId: 'child', questions: [
    { id: 'scope', header: 'Scope', question: 'Should I review tests?', options: [{ label: 'Yes', description: 'Include test coverage.' }] },
  ] } }]
  const background: BackgroundActivity = { agentsAvailability: 'ready', processesAvailability: 'ready', processes: [], agents: [
    { id: 'child', parentId: chatId, title: 'Reviewer', preview: '', status: 'waiting', needsInput: true, canInspect: true, canStop: false, source: 'provider' },
  ] }
  const fixture = await openConversation(page, chat, background)
  const strip = page.getByRole('group', { name: 'Background activity', exact: true })
  await strip.locator(':scope > summary').click()
  await strip.getByRole('button', { name: 'View conversation', exact: true }).click()
  await strip.getByRole('button', { name: 'Yes', exact: true }).click()
  await strip.getByRole('button', { name: 'Send answers', exact: true }).click()
  expect(fixture.operations.find(row => row.op === 'chat-answer')?.args).toMatchObject({ chatId, requestId: 'child-question', answers: { scope: 'Yes' } })
})

test('queued terminals preserve the web draft and allow sending without stopping the client', async ({ page }) => {
  const fixture = await openConversation(page)
  const prompt = page.getByRole('textbox', { name: 'Instructions', exact: true })
  const card = page.getByRole('group', { name: 'Conversation terminal', exact: true })
  await prompt.fill('Continue here while the terminal opens')
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  await card.getByRole('button', { name: 'Spawn terminal', exact: true }).click()
  await expect(page.locator('.command-terminal-status')).toHaveText('Your terminal will open after this turn finishes.')
  await expect(prompt).not.toHaveAttribute('readonly', '')
  await expect(prompt).toHaveValue('Continue here while the terminal opens')
  await prompt.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => fixture.operations.find((message) => message.op === 'chat-send')?.args.text).toBe('Continue here while the terminal opens')
  expect(fixture.operations.some((message) => message.op === 'chat-terminal-release')).toBe(false)
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  await card.getByRole('button', { name: 'Cancel terminal request', exact: true }).click()
  await expect(prompt).not.toHaveAttribute('readonly', '')
  expect(fixture.operations.find((message) => message.op === 'chat-terminal-open')?.args.chatId).toBe(chatId)
  expect(fixture.operations.find((message) => message.op === 'chat-terminal-release')?.args.key).toMatch(/^[a-f0-9-]{36}$/)
})

test('an unavailable terminal is reconciled without disabling a connected web conversation', async ({ page }) => {
  const chat = conversation()
  chat.terminal = terminal('unavailable')
  const fixture = await openConversation(page, chat)
  const prompt = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await expect(prompt).not.toHaveAttribute('readonly', '')
  await expect(page.locator('.command-terminal-status')).toContainText(chat.terminal.error!)
  expect(fixture.operations.some((message) => message.op === 'chat-terminal-status')).toBe(true)
  fixture.emit({ kind: 'terminal', terminal: terminal('exited') })
  await expect(prompt).not.toHaveAttribute('readonly', '')
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Spawn terminal', exact: true })).toBeVisible()
})

test('a terminal turn allows web steering, queued follow-ups, Stop, and approval responses', async ({ page }) => {
  const chat = conversation()
  chat.terminal = terminal('running')
  chat.status = 'running'
  chat.turnId = 'terminal-turn'
  const fixture = await openConversation(page, chat)
  const prompt = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await prompt.fill('Extra context from web')
  await prompt.press('Enter')
  await expect.poll(() => fixture.operations.find((message) => message.op === 'chat-steer')?.args).toMatchObject({
    chatId, text: 'Extra context from web', expectedTurnId: 'terminal-turn',
  })
  await (await openChatSettings(page)).getByRole('combobox', { name: 'Message timing', exact: true }).selectOption('queue')
  await prompt.fill('Next task from web')
  await prompt.press('Enter')
  await expect.poll(() => fixture.operations.find((message) => message.op === 'chat-queue')?.args.text).toBe('Next task from web')
  const request = { requestId: 'native-approval', method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } }
  fixture.emit({ kind: 'request', request })
  await page.getByRole('button', { name: 'Approve once', exact: true }).click()
  await expect.poll(() => fixture.operations.find((message) => message.op === 'chat-answer')?.args).toMatchObject({ requestId: request.requestId, decision: 'accept' })
  fixture.emit({ kind: 'requests', requests: [] })
  await expect(page.getByRole('button', { name: 'Approve once', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => fixture.operations.find((message) => message.op === 'chat-interrupt')?.args).toMatchObject({ chatId, expectedTurnId: 'terminal-turn' })
  expect(fixture.operations.some((message) => message.op === 'chat-terminal-release')).toBe(false)
})

for (const theme of ['light', 'dark']) {
  test(`conversation is accessible on mobile in ${theme} mode`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('aixand.appearance', value), theme)
    await page.setViewportSize({ width: 390, height: 844 })
    const chat = conversation()
    chat.terminal = terminal(theme === 'light' ? 'queued' : 'unavailable')
    chat.items[chat.items.length - 1].text = 'The conversation is easier to read.\n\nTool details stay in the activity card above.'
    await openConversation(page, chat)
    await page.locator('.command-transcript-scroll').evaluate((element) => { element.scrollTop = 0 })
    await page.screenshot({ path: `artifacts/command-ui/${theme}-mobile.png`, fullPage: true })
    await page.locator('.command-activity-summary').click()
    await page.locator('.command-tool-activity').filter({ hasText: 'Ran a command' }).locator('summary').click()
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(results.violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toBeVisible()
    const trigger = page.getByRole('button', { name: 'Conversation information', exact: true })
    await trigger.click()
    const information = page.getByRole('dialog', { name: 'Conversation information', exact: true })
    await expect(information).toContainText(chat.project)
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  })
}

test('conversation labels are visible and metadata loads only when requested', async ({ page }) => {
  const chat = conversation()
  chat.labels = { app: 'aixand-suite', 'workflow.run_id': 'run-42' }
  const { operations } = await openConversation(page, chat)
  expect(operations.filter((request) => request.op === 'chat-metadata')).toHaveLength(0)
  await page.getByRole('button', { name: 'Conversation information', exact: true }).click()
  await expect(page.getByLabel('Conversation labels')).toContainText('workflow.run_id: run-42')
  expect(operations.filter((request) => request.op === 'chat-metadata')).toHaveLength(0)
  await page.getByRole('button', { name: 'Show metadata', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Conversation information' })).toContainText('/private/retained-inputs.json')
  expect(operations.filter((request) => request.op === 'chat-metadata')).toHaveLength(1)
});

test('your messages use labeled right aligned bubbles beside open assistant replies', async ({ page }) => {
  const chat = conversation()
  chat.items = [chat.items[0], { id: 'answer', type: 'agentMessage', text: 'Here is my reply.' }]
  await openConversation(page, chat)
  const user = page.getByRole('article', { name: 'Your message', exact: true })
  const assistant = page.getByRole('article', { name: 'work message', exact: true })
  await expect(user.locator('.command-message-label')).toHaveText('You')
  await expect(user).toContainText('Improve the command page and separate the tools used.')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(async () => {
      const u = await user.boundingBox(), a = await assistant.boundingBox()
      return !!u && !!a && u.x > a.x && Math.abs(u.x + u.width - a.x - a.width) < 2
    }).toBe(true)
    const colors = await user.evaluate(element => ({ user: getComputedStyle(element).backgroundColor,
      assistant: getComputedStyle(document.querySelector('.command-chat-message--agentMessage')!).backgroundColor }))
    expect(colors.user).not.toBe(colors.assistant)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})
