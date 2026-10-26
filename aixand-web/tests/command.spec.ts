import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type WebSocketRoute } from './fixtures'
import type { Monitor, MonitorDetail } from '../src/command/model'
import type { ChatSnapshot } from '../src/chats/model'

const id = '11111111-1111-4111-8111-111111111111'
const chatId = '22222222-2222-4222-8222-222222222222'
const actorId = '33333333-3333-4333-8333-333333333333'
const watchedId = '44444444-4444-4444-8444-444444444444'
const ordinaryId = '55555555-5555-4555-8555-555555555555'
function monitor(): Monitor {
  return { id, title: 'Finish checkout', instruction: 'Finish and verify checkout against the specification.', instructionRevision: 1,
    generation: 1, state: 'waiting', progress: 'Waiting for implementation.', memory: 'The audit follows implementation.', evidence: [],
    conversationChatId: chatId, sourceChatId: chatId, supervisorChatId: actorId, watchedChatIds: [watchedId],
    permissionMode: 'workspace-write', limits: { maxEvaluations: 100, maxActionsPerEvaluation: 30 },
    evaluations: 2, createdAt: 1, updatedAt: 2, revision: 1, url: `#/chat/${chatId}/supervision/${id}` }
}
function chat(id: string, title: string): ChatSnapshot {
  return { id, title, provider: 'codex', profile: 'work', auth: null, cwd: '/workspace', project: '', mode: 'chat',
    status: 'completed', createdAt: 1, updatedAt: 2, revision: 1, workspaceTools: true,
    items: [{ id: 'user-' + id, type: 'userMessage', text: 'Supervise checkout until its requirements are verified.' },
      { id: 'answer-' + id, type: 'agentMessage', text: 'I will supervise the implementation and arrange an independent audit.' }], requests: [] }
}
async function fixture(page: Page, route = `/#/chat/${chatId}`, legacyActor = false) {
  let current = { ...monitor(), ...(legacyActor ? { sourceChatId: null, conversationChatId: actorId } : {}) }
  const source = { ...chat(chatId, 'Finish checkout'), project: 'Checkout' }
  const actor = { ...chat(actorId, 'Background evaluation'), automationId: id, automationSupervisor: true }
  const watched = chat(watchedId, 'Checkout implementation')
  const ordinary = { ...chat(ordinaryId, 'Discuss API design'), project: 'Checkout' }
  const chats = [source, actor, watched, ordinary]
  const requests: { op: string; args: Record<string, unknown> }[] = []
  let socket!: WebSocketRoute
  const detail = (): MonitorDetail => ({ monitor: current, watches: [{ id: 'watch', kind: 'chat', targetId: watchedId }],
    activity: [{ sequence: 1, kind: 'created', text: 'Supervision accepted.', createdAt: 1 }] })
  await page.routeWebSocket('**/api/carrier/ws', connection => { connection.send(JSON.stringify({ type: 'ready' })); connection.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', connection => {
    socket = connection
    connection.send(JSON.stringify({ type: 'ready' }))
    connection.onMessage(raw => {
      const request = JSON.parse(String(raw)); requests.push(request)
      if (request.op === 'command-pause') current = { ...current, state: 'paused', revision: current.revision + 1 }
      if (request.op === 'command-resume') current = { ...current, state: 'scheduled', revision: current.revision + 1 }
      if (request.op === 'command-cancel') current = { ...current, state: 'cancelled', revision: current.revision + 1 }
      if (request.op === 'command-update') current = { ...current, instruction: current.instruction + '\n' + (request.args.direction ?? ''), revision: current.revision + 1 }
      const selected = chats.find(row => row.id === request.args?.chatId) ?? source
      if (request.op === 'chat-send') {
        selected.items = [...selected.items, { id: 'followup', type: 'userMessage', text: request.args.text }]
        selected.revision++
      }
      const result = request.op === 'command-list' ? { monitors: [current] } : request.op.startsWith('command-') ? detail()
        : request.op === 'catalog' ? { profiles: [{ id: 'codex/work', provider: 'codex', profile: 'work', auth: null, active_runs: 0 }], auths: [], cwd: '/workspace' }
          : request.op === 'chat-list' ? chats : ['chat-open', 'chat-send', 'chat-steer', 'chat-queue'].includes(request.op) ? selected
            : request.op === 'mcp-catalog' ? { servers: [] } : ['models', 'project-list', 'agent-operations', 'sessions', 'chat-launches'].includes(request.op) ? [] : {}
      connection.send(JSON.stringify({ type: 'result', id: request.id, result }))
    })
  })
  await page.goto(route)
  return { requests, update(state: Monitor['state'], progress: string) {
    current = { ...current, state, progress, revision: current.revision + 1 }
    socket.send(JSON.stringify({ type: 'command-updated', monitor: current }))
  }, progress(text: string) {
    source.supervisionUpdates = [{ id: 'progress', type: 'agentMessage', text, afterItemId: 'answer-' + chatId, supervisionUpdate: true }]
    source.revision++
    socket.send(JSON.stringify({ type: 'chat-updated', chat: source }))
  } }
}

test('supervision lives in the normal chat with history badges and a filter', async ({ page }) => {
  await fixture(page)
  await expect(page.getByRole('heading', { name: 'Finish checkout', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Supervising: open supervision' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Command', exact: true })).toHaveCount(0)
  const recent = page.getByRole('region', { name: 'Recent conversations' })
  await expect(recent.getByRole('button', { name: /^Finish checkout/ })).toContainText('Supervising')
  await expect(recent.getByRole('button', { name: /^Background evaluation/ })).toHaveCount(0)
  const filter = page.getByRole('button', { name: 'Show supervising chats', exact: true })
  await expect(page.locator('.chat-history-section-heading').filter({ has: page.getByRole('heading', { name: 'Recent', exact: true }) }).getByRole('button')).toHaveAccessibleName('Show supervising chats')
  await expect(filter).toHaveAttribute('aria-pressed', 'false')
  await filter.focus()
  await expect(filter).toBeFocused()
  await filter.press('Space')
  await expect(filter).toHaveAttribute('aria-pressed', 'true')
  await expect(recent.getByRole('button', { name: /^Discuss API design/ })).toHaveCount(0)
  await expect(recent.getByRole('button', { name: /^Finish checkout/ })).toBeVisible()
  await page.getByRole('button', { name: 'Checkout, 2 conversations', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Checkout conversations', exact: true })
    .getByRole('button', { name: /^Discuss API design/ })).toBeVisible()
  await page.getByRole('button', { name: 'Search history', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search history', exact: true }).fill('Discuss API design')
  await expect(page.getByRole('menuitem', { name: /Discuss API design/ })).toBeVisible()
  await page.getByRole('dialog', { name: 'Search history', exact: true }).getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Search history', exact: true })).toHaveCount(0)
  await filter.click()
  await expect(filter).toHaveAttribute('aria-pressed', 'false')
  await expect(recent.getByRole('button', { name: /^Discuss API design/ })).toBeVisible()
})

test('the badge opens the brief and supervision can be paused, resumed, steered and stopped', async ({ page }) => {
  const f = await fixture(page)
  await page.getByRole('button', { name: 'Supervising: open supervision' }).click()
  const panel = page.getByRole('dialog', { name: 'Supervision', exact: true })
  await expect(panel.getByText('Finish and verify checkout against the specification.', { exact: true })).toBeVisible()
  await expect(panel.getByRole('link', { name: 'Checkout implementation' })).toHaveAttribute('href', `#/chat/${watchedId}`)
  await panel.getByRole('button', { name: 'Pause supervision', exact: true }).click()
  await panel.getByRole('button', { name: 'Resume supervision', exact: true }).click()
  await panel.getByRole('textbox', { name: 'Update the brief' }).fill('Also verify keyboard navigation.')
  await panel.getByRole('button', { name: 'Save direction' }).click()
  await expect(panel.getByRole('textbox', { name: 'Update the brief' })).toHaveValue('')
  expect(f.requests.find(request => request.op === 'command-update')?.args).toMatchObject({ monitorId: id, direction: 'Also verify keyboard navigation.' })
  await panel.getByRole('button', { name: 'Stop supervision', exact: true }).click()
  await expect(panel.getByText('Stopped', { exact: true })).toBeVisible()
})

test('normal conversations remain writable and receive durable supervision updates', async ({ page }) => {
  const f = await fixture(page)
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('What remains to be done?')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('article', { name: 'Your message', exact: true }).last()).toContainText('What remains to be done?')
  expect(f.requests.some(request => request.op === 'chat-send')).toBe(true)
  f.progress('The independent audit found two remaining gaps.')
  await expect(page.getByRole('article', { name: 'Supervision update', exact: true })).toContainText('two remaining gaps')
  await page.reload()
  await expect(page.getByRole('article', { name: 'Supervision update', exact: true })).toContainText('two remaining gaps')
})

test('live supervision labels reflect responsibility while the provider turn is idle', async ({ page }) => {
  const f = await fixture(page)
  await expect(page.getByRole('button', { name: 'Supervising: open supervision' })).toBeVisible()
  const filter = page.getByRole('button', { name: 'Show supervising chats', exact: true })
  const recent = page.getByRole('region', { name: 'Recent conversations', exact: true })
  await filter.click()
  f.update('needs_input', 'Choose the acceptance criteria.')
  await expect(page.getByRole('button', { name: 'Needs you: open supervision' })).toBeVisible()
  await expect(recent.getByRole('button', { name: /^Finish checkout/ })).toBeVisible()
  f.update('paused', 'Supervision is paused.')
  await expect(recent.getByRole('button', { name: /^Finish checkout/ })).toContainText('Paused')
  f.update('completed', 'Checkout verified with an independent audit.')
  await expect(page.getByRole('button', { name: 'Completed: open supervision' })).toBeVisible()
  await expect(page.getByLabel('Supervision status')).toContainText('Checkout verified')
  await expect(recent).toContainText('No chats with ongoing supervision.')
  await filter.click()
  await expect(recent.getByRole('button', { name: /^Finish checkout/ })).toContainText('Completed')
})

test('watched chats identify their supervisor without a supervising badge of their own', async ({ page }) => {
  await fixture(page, `/#/chat/${watchedId}`)
  await expect(page.getByLabel('Supervised by')).toContainText('Finish checkout')
  await expect(page.getByRole('button', { name: 'Supervising: open supervision' })).toHaveCount(0)
})

test('legacy links resolve to Chat and its supervision panel', async ({ page }) => {
  await fixture(page, `/#/command/monitors/${id}`)
  await expect(page).toHaveURL(new RegExp(`/chat/${chatId}/supervision/${id}$`))
  await expect(page.getByRole('dialog', { name: 'Supervision', exact: true })).toBeVisible()
  const visits = await page.evaluate(() => JSON.parse(localStorage.getItem('aixand.home.visits.v1') ?? '{}'))
  expect(visits).toHaveProperty('chat:' + chatId)
  expect(Object.keys(visits).some(key => key.includes('/supervision/'))).toBe(false)
  await page.goto('/#/command')
  await expect(page).toHaveURL(/\/chat\/supervising$/)
  await expect(page.getByRole('button', { name: 'Show supervising chats', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.goto(`/#/command/${chatId}`)
  await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`))
})

test('execution-chat directions update the mandate instead of steering an autonomous turn', async ({ page }) => {
  const f = await fixture(page, `/#/chat/${actorId}`, true)
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Also verify mobile accessibility.')
  await page.getByRole('button', { name: 'Send direction', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('')
  expect(f.requests.find(request => request.op === 'command-update')?.args.direction).toBe('Also verify mobile accessibility.')
  expect(f.requests.some(request => ['chat-send', 'chat-steer'].includes(request.op))).toBe(false)
})

test('supervision supports mobile layout and accessible chat and panel controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  await expect(page.getByRole('button', { name: 'Supervising: open supervision' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.getByRole('button', { name: 'Show chat history', exact: true }).click()
  const history = page.getByRole('dialog', { name: 'Chat history', exact: true })
  const filter = history.getByRole('button', { name: 'Show supervising chats', exact: true })
  await filter.click()
  await expect(filter).toHaveAttribute('aria-pressed', 'true')
  await expect(history.getByRole('region', { name: 'Recent conversations', exact: true })
    .getByRole('button', { name: /^Discuss API design/ })).toHaveCount(0)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await history.getByRole('button', { name: 'Close sheet', exact: true }).click()
  await expect(history).toHaveCount(0)
  await page.getByRole('button', { name: 'Supervising: open supervision' }).click()
  await expect(page.getByRole('dialog', { name: 'Supervision', exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})
