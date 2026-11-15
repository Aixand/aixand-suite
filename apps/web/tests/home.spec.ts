import AxeBuilder from '@axe-core/playwright'
import { mockAuthentication, openChatSettings, expect, test, type Page, type WebSocketRoute } from './fixtures'
import type { ChatSnapshot, ChatWorkflow } from '../src/chats/model'
import type { Monitor } from '../src/command/model'
import type { CarrierMessage } from '../src/carrier/client'
import type { Session } from '../src/terminals/connection'
import { homeWork } from '../src/workspace/home/work'
import { WORK_VISITS_KEY } from '../src/workspace/home/history'

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

const now = Date.now()
const day = 86400000
const chatId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`
function chat(n: number, status = 'waiting', updatedAt = now - 600000): ChatSnapshot {
  return { id: chatId(n), title: `Conversation ${n}`, provider: 'codex', profile: 'work', auth: null,
    cwd: '/workspace', project: 'Studio', mode: 'chat', status, createdAt: updatedAt - 1000, updatedAt,
    revision: 1, items: [], requests: status === 'waiting' ? [{ requestId: 'question', method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'choice', header: 'Direction', question: 'Which direction should I take?' }] } }] : [],
    queue: { paused: false, messages: [] } }
}
function terminal(id: string, state = 'requested', disposition = 'affirmative'): Session {
  return { id, name: id, lifecycle: { state: 'running' }, started_at_millis: now - day * 4, updated_at_millis: now - 30000,
    foreground: { interaction: { state, modality: 'text', basis: { disposition, source: 'structured', confidence_basis_points: 10000, evidence_observed_at_millis: now - day * 3 } } } }
}
function workflow(): ChatWorkflow {
  return { key: 'release/key', id: 'release-id', originChatId: chatId(99), projectId: 'studio', project: 'Studio', title: 'Ship the release', state: 'running',
    createdAt: now - day * 3, updatedAt: now - 300000, revision: 1,
    steps: [{ id: 'review', title: 'Review', dependsOn: [], state: 'waiting', chat_id: chatId(2) }] }
}
function message(id: string, acknowledged = false): CarrierMessage {
  return { id, title: `Review report ${id}`, source: 'Reviewer', sender: 'reviewer', recipient: 'user', body: 'Review this report.', content: 'Review this report.',
    direction: 'incoming', created_at: new Date(now - 60000).toISOString(), read: false, archived: false,
    reply_to: null, acknowledged_at: acknowledged ? new Date(now).toISOString() : null, metadata: null }
}
function input(overrides: Partial<Parameters<typeof homeWork>[0]> = {}): Parameters<typeof homeWork>[0] {
  return { chats: [], snapshots: {}, workflows: [], drafts: [], terminals: [], messages: [], visits: {}, now, ...overrides }
}

test('only confirmed terminal requests need input; idle prompts, inferred prompts, and servers stay quiet', () => {
  const execution = { state: 'active', basis: { disposition: 'affirmative', source: 'structured', confidence_basis_points: 10000, evidence_observed_at_millis: now } }
  const work = homeWork(input({ terminals: [terminal('old request'), terminal('idle', 'available'), terminal('guess', 'requested', 'inference'),
    { ...terminal('server', 'none'), labels: { 'session.kind': 'server' }, foreground: { execution } },
    { ...terminal('legacy server', 'none'), labels: { feature: 'app-server' }, foreground: { execution } },
    { ...terminal('profile server', 'none'), profile: 'server', labels: { app: 'aixand-suite' }, foreground: { execution } },
    { ...terminal('job', 'none'), labels: { 'session.kind': 'job' } }] }))
  expect(work.needs.map(row => row.title)).toEqual(['old request'])
  expect(work.running.map(row => row.title)).toEqual(['job'])
})

test('workflows, child conversations, and their terminals become a single actionable item', () => {
  const child = { ...chat(2), terminal: { key: 't', status: 'running' as const, runId: 'r', sessionId: 'child-terminal', url: null, createdAt: now, updatedAt: now } }
  const work = homeWork(input({ chats: [child], snapshots: { [child.id]: child }, workflows: [workflow()], terminals: [terminal('child-terminal')] }))
  expect(work.needs).toHaveLength(1)
  expect(work.needs[0]).toMatchObject({ kind: 'workflow', title: 'Ship the release', reason: 'Which direction should I take?', action: 'Answer question', route: `chat/${child.id}` })
  expect(work.recent).toHaveLength(0)
})

test('deleted workflow history stays out of Home while surviving children remain accessible', () => {
  const child = chat(2)
  const run = { ...workflow(), originConversationDeleted: true }
  const work = homeWork(input({ chats: [child], workflows: [run], visits: { [`workflow:${run.key}`]: now } }))
  expect(work.needs.map(row => row.key)).toEqual([`chat:${child.id}`])
  expect(work.recent).toEqual([])
  expect(work.running).toEqual([])
  const stale = homeWork(input({ chats: [chat(1)], workflows: [workflow()], deletedIds: new Set([chatId(1), chatId(99)]) }))
  expect([...stale.needs, ...stale.recent, ...stale.running]).toEqual([])
})

test('deleted or finished workflow tasks never produce a stale answer link', () => {
  for (const task of [{ conversationDeleted: true }, { executionState: 'completed', reportState: 'pending' }, { state: 'stopped' }, { state: 'failed' }]) {
    const run = { ...workflow(), steps: [{ ...workflow().steps[0], ...task }] }
    const work = homeWork(input({ chats: [chat(2)], workflows: [run] }))
    expect(work.needs).toEqual([])
    expect(work.running[0]).toMatchObject({ kind: 'workflow', route: 'workflows/runs/release%2Fkey' })
  }
  const work = homeWork(input({ workflows: [{ ...workflow(), state: 'completed' }] }))
  expect(work.needs).toEqual([])
  expect(work.recent).toEqual([])
  expect(work.running).toEqual([])
})

test('a completed chat or ended session overrides a stale waiting workflow step', () => {
  for (const update of [{ status: 'completed' }, { status: 'offline', statusReason: 'session_ended' as const }]) {
    const child = { ...chat(2), ...update }
    const work = homeWork(input({ chats: [child], snapshots: { [child.id]: child }, workflows: [workflow()] }))
    expect(work.needs).toEqual([])
    expect(work.running[0]).toMatchObject({ kind: 'workflow', route: 'workflows/runs/release%2Fkey' })
    expect(homeWork(input({ chats: [child] })).recent).toEqual([])
  }
})

test('ended chats and workflows stay off Home, including visited results and stale child processes', () => {
  for (const state of ['completed', 'delivered', 'done', 'finished', 'failed', 'failure-delivered', 'cancelled', 'canceled', 'interrupted', 'stopped', 'exited', 'terminated', 'killed']) {
    const endedChat = { ...chat(1, state), terminal: { key: 't', status: 'running' as const, runId: 'r', sessionId: 'stale-chat-terminal', url: null, createdAt: now, updatedAt: now } }
    const child = { ...chat(2), terminal: { ...endedChat.terminal, sessionId: 'stale-child-terminal' } }
    const run = { ...workflow(), state }
    const work = homeWork(input({ chats: [endedChat, child], snapshots: { [endedChat.id]: endedChat, [child.id]: child }, workflows: [run],
      terminals: [terminal('stale-chat-terminal'), terminal('stale-child-terminal'), { ...terminal('stale-workflow-terminal'), labels: { 'workflow.run_id': run.id! } }],
      visits: { [`chat:${endedChat.id}`]: now, [`workflow:${run.key}`]: now, 'terminal:stale-chat-terminal': now, 'terminal:stale-child-terminal': now } }))
    expect([...work.needs, ...work.recent, ...work.running], state).toEqual([])
  }
})

test('ended terminals stay off Home even with recent visits, failed exits, or stale input requests', () => {
  for (const state of ['exited', 'stopped', 'failed', 'completed', 'cancelled', 'terminated', 'killed']) {
    for (const code of [0, 1, null]) {
      const session = { ...terminal('ended-process'), lifecycle: { state, code }, labels: { 'session.kind': 'job' } }
      const work = homeWork(input({ terminals: [session], visits: { 'terminal:ended-process': now } }))
      expect([...work.needs, ...work.recent, ...work.running], `${state}: ${code}`).toEqual([])
    }
  }
})

test('private supervision workers do not appear as conversations on Home', () => {
  const actor = { ...chat(1, 'completed'), automationSupervisor: true }
  const work = homeWork(input({ chats: [actor], snapshots: { [actor.id]: actor }, visits: { [`chat:${actor.id}`]: now } }))
  expect([...work.needs, ...work.recent, ...work.running]).toEqual([])
})

test('old unanswered requests stay visible while ended work and acknowledged unread mail stay off Home', () => {
  const work = homeWork(input({ chats: [chat(1, 'waiting', now - day * 30), chat(2, 'failed', now - day * 2), chat(3, 'failed'), chat(4, 'completed')],
    messages: [message('1', true), message('2')], visits: { [`chat:${chatId(3)}`]: now } }))
  expect(work.needs.map(row => row.key)).toEqual([`chat:${chatId(1)}`, 'message:2'])
  expect(work.recent).toEqual([])
  expect(homeWork(input({ chats: [chat(4, 'completed')], visits: { [`chat:${chatId(4)}`]: now } })).recent).toEqual([])
})

test('live terminal requests promote their owner, ended children stay hidden, and recent work is bounded', () => {
  const owner = { ...chat(1, 'running'), terminal: { key: 't', status: 'running' as const, runId: 'r', sessionId: 'private-input', url: null, createdAt: now, updatedAt: now } }
  const request = terminal('private-input')
  request.foreground!.interaction.modality = 'secret'
  const work = homeWork(input({ chats: [owner], terminals: [request] }))
  expect(work.needs).toHaveLength(1)
  expect(work.needs[0]).toMatchObject({ key: `chat:${owner.id}`, route: 'terminals/private-input', reason: 'Private input is requested in the terminal.' })
  expect(work.running).toHaveLength(0)
  const failed = { ...terminal('step-process', 'none'), labels: { 'workflow.run_id': 'release-id' }, lifecycle: { state: 'exited', code: 1 } }
  const failedWork = homeWork(input({ workflows: [{ ...workflow(), steps: [] }], terminals: [failed] }))
  expect(failedWork.needs).toEqual([])
  expect(failedWork.running[0]).toMatchObject({ kind: 'workflow', route: 'workflows/runs/release%2Fkey' })
  expect(homeWork(input({ chats: Array.from({ length: 12 }, (_, n) => chat(n + 1, 'ready')) })).recent).toHaveLength(5)
})

type Command = { op: string; args: Record<string, unknown> }
async function services(page: Page, options: { empty?: boolean; extra?: number; hold?: boolean; carrierUnavailable?: boolean; monitors?: Monitor[]; failAnswerOnce?: boolean } = {}) {
  await page.route('**/api/auth/onboarding/status', route => route.fulfill({ json: { needed: false } }))
  const chats = options.empty ? [] : [chat(1, 'waiting', now - day * 8), chat(2), chat(3, 'completed'), chat(4, 'running'), chat(5, 'ready'),
    ...Array.from({ length: options.extra ?? 0 }, (_, i) => chat(i + 10))]
  const workflows = options.empty ? [] : [workflow(), { ...workflow(), key: 'finished-workflow', id: 'finished-workflow', title: 'Accessibility review', state: 'completed', steps: [] }]
  const terminals = options.empty ? [] : [terminal('Review deployment'), terminal('Available shell', 'available'), terminal('Inferred request', 'requested', 'inference'),
    { ...terminal('Server', 'none'), profile: 'server', labels: { app: 'aixand-suite' }, foreground: { execution: { state: 'active',
      basis: { disposition: 'affirmative', source: 'structured', confidence_basis_points: 10000, evidence_observed_at_millis: now } } } },
    { ...terminal('Build assets', 'none'), labels: { 'session.kind': 'job' } },
    ...['exited', 'stopped', 'failed'].map(state => ({ ...terminal(`${state} process`), lifecycle: { state, code: state === 'failed' ? 1 : 0 }, labels: { 'session.kind': 'job' } }))]
  const messages = options.empty ? [] : [message('42'), message('43', true)]
  const monitors = options.monitors ?? []
  const projects = [{ id: 'studio', name: 'Studio', path: '/workspace/studio', createdAt: now, updatedAt: now }]
  let answerFailed = false
  const commands: { source: string; op: string; args: Record<string, unknown> }[] = []
  let agents: WebSocketRoute
  let terminalSocket: WebSocketRoute
  let carrier: WebSocketRoute
  let carrierConnections = 0
  let terminalFailure = false
  let holding = options.hold
  let moreMessages = false
  const held: (() => void)[] = []
  const service = { connected: !options.carrierUnavailable, syncing: false, error: null, last_sync: 1, instance: 'home-test', outgoing_history: true, agent_configured: false, providers: [], version: 1 }
  for (const source of ['agents', 'terminals', 'carrier']) {
    await page.routeWebSocket(`**/api/${source}/ws`, socket => {
      if (source === 'agents') agents = socket
      if (source === 'terminals') terminalSocket = socket
      if (source === 'carrier') { carrier = socket; carrierConnections++ }
      socket.send(JSON.stringify({ type: 'ready' }))
      socket.onMessage(raw => {
        const command = JSON.parse(String(raw)) as Command & { id: string }
        commands.push({ source, op: command.op, args: command.args ?? {} })
        if (command.op === 'ack') return
        const send = () => {
          let result: unknown = []
          const args = command.args ?? {}
          if (source === 'agents') {
            if (command.op === 'catalog') result = { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: '/workspace' }
            if (command.op === 'sessions') result = { runs: [], runtimeError: null }
            if (command.op === 'session-list') result = { sessions: [], total: 0, homes: [], projects: [], counts: {}, errors: [] }
            if (command.op === 'skills-catalog') result = { store: '/skills', store_id: 'home-skills', sources: [], entries: [], releases: [] }
            if (command.op === 'prompts-catalog') result = { store: '/prompts', checked_at: '', sources: [], consumers: [], packs: [] }
            if (command.op.endsWith('-managed-list')) result = { store: '/managed', store_id: 'home-managed', items: [] }
            if (command.op === 'resource-catalog') result = { choices: { instructions: [], skills: [], mcp: [] } }
            if (command.op === 'profile-resources-get') result = { revision: 'home-resources', instructions: null, skills: [], mcp: [] }
            if (command.op === 'launch-preview') result = { report: { items: [] } }
            if (command.op === 'chat-list') result = chats
            if (command.op === 'chat-open') result = chats.find(row => row.id === args.chatId)
            if (command.op === 'project-list') result = projects
            if (command.op === 'project-files-list') result = { projectId: args.projectId, path: '', entries: [{ name: 'README.md', path: 'README.md', kind: 'file', size: 18, supported: true }], nextOffset: null, total: 1 }
            if (command.op === 'project-file-read') result = { kind: 'text', name: 'README.md', path: 'README.md', content: 'Studio project notes', size: 20 }
            if (command.op === 'chat-create') {
              const created = { ...chat(80, 'ready'), id: String(args.key), title: 'Home task', profile: args.profile == null ? 'work' : String(args.profile), project: args.projectId ? 'Studio' : '', projectId: args.projectId ? 'studio' : undefined }
              chats.push(created); result = created
            }
            if (['chat-send', 'chat-steer', 'chat-queue', 'chat-answer'].includes(command.op)) {
              if (command.op === 'chat-answer' && options.failAnswerOnce && !answerFailed) {
                answerFailed = true
                socket.send(JSON.stringify({ type: 'error', id: command.id, code: 'connection_lost', message: 'Response could not be confirmed.' })); return
              }
              const row = chats.find(row => row.id === args.chatId)!
              Object.assign(row, { status: 'running', requests: [], revision: row.revision + 1, updatedAt: Date.now() })
              if (['chat-send', 'chat-steer'].includes(command.op)) row.items.push({ id: 'home-message', type: 'userMessage', text: String(args.text) })
              if (command.op === 'chat-queue') row.queue!.messages.push({ id: 'queued-home', text: String(args.text), status: 'queued', revision: 1, createdAt: now })
              result = row
              socket.send(JSON.stringify({ type: 'chat-updated', chat: row }))
            }
            if (command.op === 'chat-workflow-runs') { const offset = Number(args.offset ?? 0); result = { runs: workflows.slice(offset, offset + 1), nextOffset: offset + 1 < workflows.length ? offset + 1 : null } }
            if (command.op === 'command-list') result = { monitors }
            if (command.op === 'mcp-catalog') result = { servers: [] }
          } else if (source === 'terminals') {
            if (command.op === 'list') {
              if (terminalFailure) { socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Status read failed' })); return }
              const offset = Number(args.cursor ?? 0)
              result = { items: terminals.slice(offset, offset + 3), next_cursor: offset + 3 < terminals.length ? String(offset + 3) : null, total: terminals.length }
            }
            if (command.op === 'groups') result = { groups: [], defaults: { cwd: '/workspace', shell: '/bin/sh' } }
            if (command.op === 'inspect') result = { summary: terminals.find(row => row.id === args.sessionId) }
            if (command.op === 'attach') result = { stream: args.paneId, sessionId: args.sessionId }
            if (command.op === 'events') result = { items: [{ sequence: '1', kind: 'session.started', occurred_at_millis: now }] }
            if (command.op === 'create') { const session = terminal(String(args.name), 'available'); terminals.push(session); result = { session } }
          } else {
            if (command.op === 'mailboxes') result = [{ id: 'user', name: 'Main inbox', address: 'suite/local/user', role: 'human' }]
            if (command.op === 'status') result = service
            if (command.op === 'snapshot') result = { messages: args.view === 'Pending' ? messages.filter(row => !row.acknowledged_at) : messages, status: service,
              counts: { Inbox: messages.length, Unread: messages.length, Pending: messages.filter(row => !row.acknowledged_at).length }, total: messages.length, next_offset: moreMessages ? 50 : null }
            if (command.op === 'conversation') result = { messages: messages.filter(row => row.id === String(args.id)), total: 1, partial: false }
            if (command.op === 'acknowledge') { const row = messages.find(row => row.id === String(args.id))!; row.acknowledged_at = new Date(now).toISOString(); result = { acknowledged_at: row.acknowledged_at } }
          }
          socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
        }
        if (holding && ['chat-list', 'chat-workflow-runs', 'list', 'snapshot'].includes(command.op)) held.push(send)
        else send()
      })
    })
  }
  return {
    chats, workflows, terminals, messages, commands, projects,
    projectsChanged() { agents.send(JSON.stringify({ type: 'projects-changed' })) },
    release() { holding = false; held.splice(0).forEach(send => send()) },
    updateChat(n: number, status: string) {
      const row = chats.find(row => row.id === chatId(n))!
      Object.assign(row, { status, updatedAt: Date.now(), revision: row.revision + 1 })
      agents.send(JSON.stringify({ type: 'chat-updated', chat: row }))
    },
    updateWorkflow(state: string) {
      Object.assign(workflows[0], { state, updatedAt: Date.now(), revision: workflows[0].revision + 1 })
      agents.send(JSON.stringify({ type: 'workflow-updated', workflow: workflows[0] }))
    },
    updateMonitor(id: string, state: Monitor['state']) {
      const row = monitors.find(row => row.id === id)!
      Object.assign(row, { state, updatedAt: Date.now(), revision: row.revision + 1 })
      agents.send(JSON.stringify({ type: 'command-updated', monitor: row }))
    },
    deleteChat(n: number, broadcast = true) {
      const id = chatId(n)
      const index = chats.findIndex(row => row.id === id)
      if (index >= 0) chats.splice(index, 1)
      for (const run of workflows) {
        if (run.originChatId === id) run.originConversationDeleted = true
        for (const step of run.steps) if (step.chat_id === id) step.conversationDeleted = true
      }
      for (const monitor of monitors) if (monitor.sourceChatId === id || monitor.conversationChatId === id) {
        monitor.conversationDeleted = true
        monitor.conversationChatId = monitor.supervisorChatId
      }
      if (broadcast) agents.send(JSON.stringify({ type: 'chat-deleted', chatId: id }))
    },
    staleWorkflow(run: ChatWorkflow) { agents.send(JSON.stringify({ type: 'workflow-updated', workflow: run })) },
    terminalChanged() { terminalSocket.send(JSON.stringify({ type: 'metadata', kind: 'sessions', stream: 'home-watch', sequence: '1' })) },
    failTerminals(value: boolean) { terminalFailure = value; if (value) this.terminalChanged() },
    disconnectTerminals() { terminalSocket.close({ code: 1011, reason: 'Terminal service unavailable' }) },
    moreMessages() { moreMessages = true; carrier.send(JSON.stringify({ type: 'changed' })) },
    restoreCarrier() { service.connected = true },
    get carrierConnections() { return carrierConnections },
    failCarrier(retryable: boolean) {
      carrier.send(JSON.stringify({ type: 'fatal', code: retryable ? 'adapter_closed' : 'incompatible_platform',
        retryable, message: retryable ? 'Carrier adapter stopped.' : 'The installed Carrier bridge is incompatible with this platform. Update Aixand Suite and retry.' }))
      carrier.close({ code: 1011, reason: 'Carrier adapter unavailable' })
    },
  }
}
const needs = (page: Page) => page.getByRole('region', { name: /^Needs you/ })
const recent = (page: Page) => page.getByRole('region', { name: 'Continue working' })
const running = (page: Page) => page.getByRole('region', { name: /^Live work/ })
async function settled(page: Page) {
  await expect(page.locator('.home-source-issue')).toHaveCount(0)
  await expect(page.locator('.home-feed-status')).toHaveText('')
}

test('Home prioritizes real requests, deduplicates workflow steps, and reads all summary pages without opening terminals', async ({ page }) => {
  const mock = await services(page)
  await page.goto('/#/home')
  await expect(needs(page).getByRole('listitem')).toHaveCount(4)
  await settled(page)
  await expect(needs(page)).toContainText('8d ago')
  await expect(needs(page)).toContainText('Ship the release')
  await expect(needs(page)).not.toContainText('Conversation 2')
  for (const title of ['Available shell', 'Inferred request', 'Server', 'Review report 43']) await expect(needs(page)).not.toContainText(title)
  await page.getByRole('tab', { name: /^Drafts/ }).click()
  await expect(recent(page)).toContainText('Conversation 5')
  await expect(page.getByRole('main')).not.toContainText('Conversation 3')
  await expect(page.getByRole('main')).not.toContainText('Accessibility review')
  for (const title of ['exited process', 'stopped process', 'failed process']) await expect(page.getByRole('main')).not.toContainText(title)
  await expect(running(page)).toContainText('Build assets')
  await expect(running(page)).not.toContainText('Server')
  expect(mock.commands.filter(row => row.source === 'terminals').every(row => ['list', 'watch', 'ack'].includes(row.op))).toBe(true)
  expect(mock.commands.some(row => row.source === 'terminals' && row.op === 'list' && row.args.cursor === '3')).toBe(true)
  expect(mock.commands.some(row => row.op === 'chat-workflow-runs' && row.args.offset === 1)).toBe(true)
  expect(mock.commands.some(row => ['chat-open', 'chat-answer', 'set_message_state', 'input', 'start', 'clean-selected'].includes(row.op))).toBe(false)
  await expect(needs(page).getByRole('link', { name: /Ship the release/ })).toHaveAttribute('href', `#/chat/${chatId(2)}`)
  await expect(needs(page).getByRole('link', { name: /Review deployment/ })).toHaveAttribute('href', '#/terminals/Review%20deployment')
})

test('finished and stopped work disappears immediately and stays off Home after reload without deleting history', async ({ page }) => {
  await page.addInitScript(({ key, at, chat }) => localStorage.setItem(key, JSON.stringify({
    [`chat:${chat}`]: at, 'workflow:finished-workflow': at, 'terminal:exited process': at, 'terminal:stopped process': at,
  })), { key: WORK_VISITS_KEY, at: now, chat: chatId(3) })
  const mock = await services(page)
  await page.goto('/#/home')
  await settled(page)
  await expect(running(page)).toContainText('Conversation 4')
  await expect(running(page)).toContainText('Build assets')
  await expect(needs(page)).toContainText('Ship the release')
  mock.updateChat(4, 'completed')
  mock.updateChat(5, 'interrupted')
  mock.updateWorkflow('completed')
  for (const session of mock.terminals) if (['Build assets', 'Review deployment', 'Available shell'].includes(session.id))
    session.lifecycle = { state: session.id === 'Build assets' ? 'exited' : 'stopped', code: 0 }
  mock.terminalChanged()
  const hiddenKeys = [`chat:${chatId(2)}`, `chat:${chatId(3)}`, `chat:${chatId(4)}`, `chat:${chatId(5)}`, 'workflow:release/key', 'workflow:finished-workflow',
    'terminal:Build assets', 'terminal:Review deployment', 'terminal:Available shell', 'terminal:exited process', 'terminal:stopped process', 'terminal:failed process']
  for (const key of hiddenKeys) await expect(page.locator(`[data-work-key="${key}"]`)).toHaveCount(0)
  await expect(needs(page)).toContainText('Conversation 1')
  await expect(needs(page)).toContainText('Review report 42')
  await page.reload()
  await settled(page)
  for (const key of hiddenKeys) await expect(page.locator(`[data-work-key="${key}"]`)).toHaveCount(0)
  expect(mock.chats).toHaveLength(5)
  expect(mock.workflows).toHaveLength(2)
  expect(mock.terminals).toHaveLength(8)
  expect(mock.commands.some(row => /delete|clean|cancel|stop|interrupt/.test(row.op))).toBe(false)
})

test('supervision updates show unanswered requests and remove completed or cancelled monitors', async ({ page }) => {
  const active: Monitor = { id: chatId(50), title: 'Review release', instruction: 'Review the release.', instructionRevision: 1,
    generation: 1, state: 'needs_input', progress: 'Choose the next step.', memory: '', evidence: [], permissionMode: 'workspace-write',
    limits: { maxEvaluations: 100, maxActionsPerEvaluation: 30 }, evaluations: 1, createdAt: now, updatedAt: now, revision: 1,
    sourceChatId: chatId(1), conversationChatId: chatId(1), url: '#/chat/' + chatId(1) }
  const mock = await services(page, { empty: true, monitors: [active,
    { ...active, id: chatId(51), title: 'Finished supervision', state: 'completed' },
    { ...active, id: chatId(52), title: 'Stopped supervision', state: 'cancelled' },
  ] })
  await page.goto('/#/home')
  await settled(page)
  const updates = page.getByRole('region', { name: 'Supervision updates' })
  await expect(updates.getByRole('listitem')).toHaveCount(1)
  await expect(updates).toContainText('Review release')
  await expect(page.getByRole('main')).not.toContainText('Finished supervision')
  await expect(page.getByRole('main')).not.toContainText('Stopped supervision')
  mock.updateMonitor(active.id, 'completed')
  await expect(updates).toHaveCount(0)
  await page.reload()
  await settled(page)
  await expect(updates).toHaveCount(0)
})

test('deletion removes Home cards and dead task links immediately and after reload without cancelling work', async ({ page }) => {
  const mock = await services(page)
  await page.goto('/#/home')
  await settled(page)
  await expect(needs(page)).toContainText('Conversation 1')
  await page.getByRole('tab', { name: /^Drafts/ }).click()
  await expect(recent(page)).toContainText('Conversation 5')
  await expect(running(page)).toContainText('Conversation 4')
  for (const n of [1, 3, 4, 5]) mock.deleteChat(n)
  for (const n of [1, 3, 4, 5]) await expect(page.locator(`[data-work-key="chat:${chatId(n)}"]`)).toHaveCount(0)

  mock.deleteChat(2)
  await expect(needs(page)).not.toContainText('Ship the release')
  await expect(running(page).getByRole('link', { name: /Ship the release/ })).toHaveAttribute('href', '#/workflows/runs/release%2Fkey')
  await expect(page.locator(`a[href="#/chat/${chatId(2)}"]`)).toHaveCount(0)
  mock.staleWorkflow(workflow())
  await expect(needs(page)).not.toContainText('Ship the release')

  mock.deleteChat(99)
  mock.staleWorkflow({ ...workflow(), revision: 50 })
  await expect(page.locator('[data-work-key^="workflow:"]')).toHaveCount(0)
  await page.reload()
  await settled(page)
  await expect(page.locator('[data-work-key^="chat:"], [data-work-key^="workflow:"]')).toHaveCount(0)
  expect(mock.workflows).toHaveLength(2)
  expect(mock.commands.some(row => /cancel|stop|interrupt/.test(row.op))).toBe(false)
})

test('a deleted supervising conversation stays off Home when its retained monitor falls back to a worker', async ({ page }) => {
  const monitor: Monitor = { id: chatId(50), title: 'Supervise release', instruction: 'Supervise the release.', instructionRevision: 1,
    generation: 1, state: 'needs_input', progress: 'Review the release.', memory: '', evidence: [], permissionMode: 'workspace-write',
    limits: { maxEvaluations: 100, maxActionsPerEvaluation: 30 }, evaluations: 1, createdAt: now, updatedAt: now, revision: 1,
    sourceChatId: chatId(1), conversationChatId: chatId(1), supervisorChatId: chatId(51), url: '#/chat/' + chatId(1) }
  const mock = await services(page, { monitors: [monitor] })
  await page.goto('/#/home')
  const updates = page.getByRole('region', { name: 'Supervision updates' })
  await expect(updates).toContainText('Supervise release')
  mock.deleteChat(1)
  await expect(updates).toHaveCount(0)
  await page.reload()
  await settled(page)
  await expect(updates).toHaveCount(0)
})

test('workflow deletion flags apply without a new workflow revision and survive late status responses', async ({ page }) => {
  const mock = await services(page)
  await page.goto('/#/home')
  await settled(page)
  const row = page.locator('[data-work-key="workflow:release/key"]')
  await expect(row).toBeVisible()
  mock.deleteChat(99, false)
  mock.staleWorkflow(mock.workflows[0])
  await expect(row).toHaveCount(0)
  await expect(needs(page)).toContainText('Conversation 2')
  mock.staleWorkflow({ ...workflow(), revision: 50 })
  await expect(row).toHaveCount(0)
})

test('all requests scroll without expanding the card and stay in place through updates; resolved focus returns to the section heading', async ({ page }) => {
  const mock = await services(page, { extra: 5 })
  await page.goto('/#/home')
  await expect(needs(page).getByRole('listitem')).toHaveCount(9)
  await settled(page)
  await expect(needs(page).getByRole('region', { name: 'Requests and updates' })).toHaveAttribute('tabindex', '0')
  await expect(needs(page).getByRole('button', { name: /View all|Show fewer/ })).toHaveCount(0)
  const before = await needs(page).locator('[data-work-key]').evaluateAll(items => items.map(item => item.getAttribute('data-work-key')))
  mock.updateChat(1, 'waiting')
  await expect(needs(page)).toContainText('Just now')
  expect(await needs(page).locator('[data-work-key]').evaluateAll(items => items.map(item => item.getAttribute('data-work-key')))).toEqual(before)
  await needs(page).getByRole('link', { name: /Conversation 1 / }).focus()
  mock.updateChat(1, 'completed')
  await expect(needs(page).getByRole('listitem')).toHaveCount(8)
  await expect(page.getByRole('heading', { name: /^Needs you/ })).toBeFocused()
  await expect(page.locator(`[data-work-key="chat:${chatId(1)}"]`)).toHaveCount(0)
})

test('Home distinguishes loading and empty from a failed status source and retries without losing cached requests', async ({ page }) => {
  const mock = await services(page, { empty: true, hold: true })
  await page.goto('/#/home')
  await expect(needs(page).getByRole('status')).toHaveText('Checking what needs you…')
  await expect(page.getByText('Nothing needs your response right now.')).toHaveCount(0)
  mock.release()
  await expect(page.getByText('Nothing needs your response right now.')).toBeVisible()
  mock.terminals.push(terminal('Confirm production'))
  mock.terminalChanged()
  await expect(needs(page)).toContainText('Confirm production')
  mock.failTerminals(true)
  await expect(page.getByText('Terminals status unavailable. Saved items may have changed.')).toBeVisible()
  await expect(needs(page)).toContainText('Last known status')
  await expect(needs(page)).toContainText('Confirm production')
  mock.failTerminals(false)
  await page.getByRole('button', { name: 'Retry Terminals status' }).click()
  await settled(page)
  await expect(needs(page)).not.toContainText('Last known status')
  mock.terminals[0].foreground!.interaction.state = 'available'
  mock.terminalChanged()
  await expect(page.getByText('Nothing needs your response right now.')).toBeVisible()
})

test('unfinished work and request actions open the exact chat and terminal', async ({ page }) => {
  const mock = await services(page)
  await page.goto('/#/home')
  await page.getByRole('tab', { name: /^Drafts/ }).click()
  await recent(page).getByRole('link', { name: /Open chat/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Conversation 5')
  await page.getByRole('link', { name: 'Open full view' }).click()
  await expect(page).toHaveURL(new RegExp(`#/chat/${chatId(5)}$`))
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Home', exact: true }).click()
  await page.getByRole('tab', { name: /^Drafts/ }).click()
  await expect(recent(page)).toContainText('Conversation 5')
  await needs(page).getByRole('link', { name: /Ship the release/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Which direction should I take?')
  await page.getByRole('link', { name: 'Open full view' }).click()
  await expect(page).toHaveURL(new RegExp(`#/chat/${chatId(2)}$`))
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Which direction should I take?' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Home', exact: true }).click()
  await needs(page).getByRole('link', { name: /Review deployment/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Recent activity')
  expect(mock.commands.some(row => row.op === 'attach')).toBe(false)
  await page.getByRole('link', { name: 'Open full view' }).click()
  await expect(page).toHaveURL(/#\/terminals\/Review%20deployment$/)
  await expect.poll(() => mock.commands.some(row => row.op === 'attach' && row.args.sessionId === 'Review deployment')).toBe(true)
  expect(JSON.parse(await page.evaluate(key => localStorage.getItem(key), WORK_VISITS_KEY) || '{}')['terminal:Review deployment']).toBeGreaterThan(0)
})

test('Carrier installation failures remain visible until manual retry, including after focus', async ({ page }) => {
  const mock = await services(page)
  await page.clock.install()
  await page.goto('/#/home')
  await settled(page)
  mock.failCarrier(false)
  const issue = page.getByText('The installed Carrier bridge is incompatible with this platform. Update Aixand Suite and retry.')
  await expect(issue).toBeVisible()
  const connections = mock.carrierConnections
  await page.clock.fastForward(120_000)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.fastForward(60_000)
  await expect(issue).toBeVisible()
  expect(mock.carrierConnections).toBe(connections)
  await page.getByRole('button', { name: 'Retry Carrier status' }).click()
  await settled(page)
  expect(mock.carrierConnections).toBe(connections + 1)
})

test('Carrier still reconnects automatically after a temporary bridge failure', async ({ page }) => {
  const mock = await services(page)
  await page.clock.install()
  await page.goto('/#/home')
  await settled(page)
  const connections = mock.carrierConnections
  mock.failCarrier(true)
  await expect(page.getByText('Carrier status unavailable. Saved items may have changed.')).toBeVisible()
  await page.clock.fastForward(2_000)
  await settled(page)
  expect(mock.carrierConnections).toBe(connections + 1)
})

test('pending messages open for review without automatically acknowledging them', async ({ page }) => {
  const mock = await services(page)
  await page.goto('/#/home')
  await needs(page).getByRole('link', { name: /Review report 42/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Review this report.')
  expect(mock.commands.some(row => row.op === 'acknowledge')).toBe(false)
  await page.getByRole('link', { name: 'Open full view' }).click()
  await expect(page).toHaveURL(/#\/carrier$/)
  await expect(page.getByRole('heading', { name: 'Review report 42' })).toBeVisible()
  expect(mock.commands.some(row => row.args.acknowledged === true)).toBe(false)
})

test('Home makes a partial message feed explicit and opens the pending inbox to see the rest', async ({ page }) => {
  const mock = await services(page)
  await page.goto('/#/home')
  await expect(needs(page).getByRole('listitem')).toHaveCount(4)
  mock.moreMessages()
  await page.getByRole('link', { name: 'View remaining messages in Carrier' }).click()
  await expect(page).toHaveURL(/#\/carrier$/)
  await expect(page.getByRole('heading', { name: 'To acknowledge', exact: true })).toBeVisible()
})

test('retry probes an unavailable Carrier service before claiming that no work needs a response', async ({ page }) => {
  const mock = await services(page, { empty: true, carrierUnavailable: true })
  await page.goto('/#/home')
  await expect(page.getByText('Carrier status unavailable. Saved items may have changed.')).toBeVisible()
  await expect(page.getByText('Nothing needs your response right now.')).toHaveCount(0)
  mock.restoreCarrier()
  await page.getByRole('button', { name: 'Retry Carrier status' }).click()
  await expect(page.getByText('Nothing needs your response right now.')).toBeVisible()
  await settled(page)
})

test('Home starts the described task once using the selected project and existing chat launch flow', async ({ page }) => {
  const mock = await services(page)
  await page.goto('/#/home')
  await settled(page)
  await expect(page.getByRole('button', { name: / Profile$/ })).toContainText('work')
  const task = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await task.fill('Review the latest changes')
  await task.press('Shift+Enter')
  await task.pressSequentially('and suggest the next step.')
  await (await openChatSettings(page)).getByRole('button', { name: / Project$/ }).click()
  await page.getByRole('option', { name: /^Studio/ }).click()
  expect(mock.commands.filter(row => row.op === 'chat-create')).toHaveLength(0)
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect(page).toHaveURL(/#\/chat\/[\w-]+$/)
  await expect.poll(() => mock.commands.filter(row => row.op === 'chat-send').length).toBe(1)
  const created = mock.commands.filter(row => row.op === 'chat-create')
  expect(created).toHaveLength(1)
  expect(created[0].args).toMatchObject({ provider: 'codex', profile: 'work', mode: 'work', projectId: 'studio' })
  expect(mock.commands.find(row => row.op === 'chat-send')?.args).toMatchObject({ chatId: created[0].args.key, text: 'Review the latest changes\nand suggest the next step.' })
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('')
})

test('Home preserves the task draft across chat settings and searches workspace actions with the keyboard', async ({ page }) => {
  await services(page)
  await page.goto('/#/home')
  await settled(page)
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Keep this task while I browse')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('Keep this task while I browse')
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('Keep this task while I browse')
  await page.getByRole('heading', { name: 'Home', exact: true }).click()
  await page.keyboard.press('Control+k')
  const search = page.getByRole('dialog', { name: 'Search workspace' })
  await search.getByRole('searchbox', { name: 'Search workspace' }).fill('Open a terminal')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await search.getByRole('menuitem', { name: 'Open a terminal', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Open a terminal' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Browse projects', exact: true }).click()
  await expect(page.getByRole('tab', { name: /^Projects/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: 'Your workspace' })).toBeFocused()
})

test('workspace search navigates between every page and section with Ctrl+K', async ({ page }) => {
  await services(page)
  await page.goto('/#/home')
  await settled(page)
  const search = page.getByRole('dialog', { name: 'Search workspace', exact: true })
  const destinations = [
    ['Chat', 'chat'], ['Terminals', 'terminals'], ['Workflows', 'workflows'], ['Carrier', 'carrier'],
    ['Sessions', 'agents/sessions'], ['Profiles', 'agents/profiles'], ['Prompts', 'agents/prompts'],
    ['Skills', 'agents/skills'], ['Tools (MCP)', 'agents/tools'], ['Providers', 'agents/providers'],
    ['Saved logins', 'agents/logins'], ['Operations', 'agents/operations'], ['Settings', 'settings'],
    ['Devices', 'settings?section=devices'], ['Troubleshooting', 'settings?section=troubleshooting'],
    ['Data management', 'settings?section=data'], ['Agent behavior', 'settings?section=agents'], ['Home', 'home'],
  ]
  for (const [label, route] of destinations) {
    await page.keyboard.press('Control+k')
    const input = search.getByRole('searchbox', { name: 'Search workspace' })
    await expect(input).toBeFocused()
    await input.fill(label)
    await search.getByRole('menuitem', { name: label, exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(url => url.hash === `#/${route}`)
    await expect(search).not.toBeVisible()
  }
})

test('workspace search works while typing, restores focus, and supports Command+K', async ({ page }) => {
  await services(page)
  await page.goto('/#/home')
  await settled(page)
  const draft = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await draft.fill('Keep this draft while searching')
  const search = page.getByRole('dialog', { name: 'Search workspace', exact: true })
  for (const shortcut of ['Control+k', 'Meta+k']) {
    await draft.press(shortcut)
    const input = search.getByRole('searchbox', { name: 'Search workspace' })
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('')
    await input.fill('no matching workspace result')
    await expect(search.getByText('No results found', { exact: true })).toBeVisible()
    await input.press('Escape')
    await expect(search).not.toBeVisible()
    await expect(draft).toBeFocused()
    await expect(draft).toHaveValue('Keep this draft while searching')
  }
})

test('workspace search finds live work from Settings with the shortcut and no sidebar action', async ({ page }) => {
  const mock = await services(page)
  await page.goto('/#/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Workspace sidebar' }).getByRole('button', { name: 'Search workspace', exact: true })).toHaveCount(0)
  await page.keyboard.press('Control+k')
  const search = page.getByRole('dialog', { name: 'Search workspace', exact: true })
  const input = search.getByRole('searchbox', { name: 'Search workspace' })
  for (const title of ['Conversation 1', 'Studio', 'Review deployment']) {
    await input.fill(title)
    await expect(search.getByRole('menuitem', { name: title, exact: true })).toBeVisible()
  }
  expect(mock.commands.some(row => ['create', 'attach', 'chat-create', 'chat-open'].includes(row.op))).toBe(false)
  await input.fill('Conversation 1')
  await input.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(url => url.hash === `#/chat/${chatId(1)}`)
  await expect(search).not.toBeVisible()
})

test('Home answers questions in place and retries an unconfirmed response with the same key', async ({ page }) => {
  const mock = await services(page, { failAnswerOnce: true })
  await page.goto('/#/home')
  await needs(page).getByRole('link', { name: /Conversation 1 / }).click()
  const panel = page.getByRole('dialog', { name: 'Conversation 1' })
  await panel.getByRole('textbox', { name: 'Which direction should I take?' }).fill('Start with the tests')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: test.info().outputPath('home-question-panel.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('home-question-mobile.png') })
  await panel.getByRole('button', { name: 'Send answers' }).click()
  await expect(panel.getByRole('alert')).toContainText('Response could not be confirmed.')
  await expect(panel.getByRole('button', { name: 'Send answers' })).toBeDisabled()
  await panel.getByRole('button', { name: 'Retry response' }).click()
  await expect(panel.getByRole('status').filter({ hasText: 'Response sent.' })).toHaveText('Response sent.')
  await expect(panel.getByRole('textbox', { name: 'Which direction should I take?' })).toHaveCount(0)
  const answers = mock.commands.filter(row => row.op === 'chat-answer')
  expect(answers).toHaveLength(2)
  expect(answers[1].args).toEqual(answers[0].args)
  expect(answers[0].args).toMatchObject({ chatId: chatId(1), requestId: 'question', answers: { choice: 'Start with the tests' } })
  await expect(page).toHaveURL(/#\/home$/)
  await panel.getByRole('textbox', { name: 'Add a follow-up' }).fill('Also check the mobile layout')
  await panel.getByRole('button', { name: /Message timing/ }).click()
  await page.getByRole('option', { name: /^Send after this turn/ }).click()
  await panel.getByRole('button', { name: 'Send after this turn', exact: true }).click()
  await expect(panel.getByRole('status').filter({ hasText: 'Message queued.' })).toHaveText('Message queued.')
  expect(mock.commands.find(row => row.op === 'chat-queue')?.args).toMatchObject({ chatId: chatId(1), text: 'Also check the mobile layout' })
})

for (const theme of ['light', 'dark']) {
  test(`Home follow-up drafts and message timing stay shared with Chat in ${theme} mode`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aixand.appearance', value), theme)
    await page.setViewportSize({ width: 390, height: 844 })
    const mock = await services(page)
    Object.assign(mock.chats[0], { status: 'running', requests: [], turnId: 'home-turn' })
    await page.goto('/#/home')
    const open = () => page.locator('.home-running').getByRole('link', { name: /Conversation 1 / }).click()
    await open()
    const panel = page.getByRole('dialog', { name: 'Conversation 1', exact: true })
    const input = panel.getByRole('textbox', { name: 'Add a follow-up', exact: true })
    await input.fill('Keep this unfinished message')
    await panel.getByRole('button', { name: /Message timing/ }).click()
    await page.getByRole('option', { name: /^Send after this turn/ }).click()
    await panel.getByRole('button', { name: 'Close details', exact: true }).click()
    await open()
    await expect(input).toHaveValue('Keep this unfinished message')
    await expect(panel.getByRole('button', { name: /Message timing/ })).toContainText('Send after this turn')
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`home-follow-up-${theme}.png`), fullPage: true })
    await panel.getByRole('link', { name: 'Open full view', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('Keep this unfinished message')
    await expect(page.locator('.command-composer-options').getByRole('button', { name: /Message timing/ })).toContainText('Send after this turn')
    expect(mock.commands.filter(command => ['chat-send', 'chat-steer', 'chat-queue'].includes(command.op))).toHaveLength(0)
  })
}

for (const managed of [false, true]) {
test(`Home can add a follow-up to the current turn and clears the shared draft after sending${managed ? ' with a steer-only backend' : ''}`, async ({ page }) => {
  const mock = await services(page)
  Object.assign(mock.chats[0], { status: 'running', requests: [], turnId: 'home-turn' })
  if (managed) Object.assign(mock.chats[0], { backendRoute: 'managed', backend: 'codex-sdk', chatCapabilities: { steer: true, queue: false } })
  await page.goto('/#/home')
  await page.locator('.home-running').getByRole('link', { name: /Conversation 1 / }).click()
  const panel = page.getByRole('dialog', { name: 'Conversation 1', exact: true })
  const input = panel.getByRole('textbox', { name: 'Add a follow-up', exact: true })
  await input.fill('Focus on keyboard support')
  await panel.getByRole('button', { name: 'Add to current turn', exact: true }).click()
  await expect(input).toHaveValue('')
  expect(mock.commands.find(command => command.op === 'chat-steer')?.args).toMatchObject({
    chatId: chatId(1), expectedTurnId: 'home-turn', text: 'Focus on keyboard support',
  })
  expect(mock.commands.filter(command => ['chat-send', 'chat-queue'].includes(command.op))).toHaveLength(0)
})
}

test('Home only offers queued follow-ups for a backend without steering', async ({ page }) => {
  const mock = await services(page)
  Object.assign(mock.chats[0], { status: 'running', requests: [], backendRoute: 'managed', backend: 'codex-sdk', chatCapabilities: { queue: true, steer: false } })
  await page.goto('/#/home')
  await page.locator('.home-running').getByRole('link', { name: /Conversation 1 / }).click()
  const panel = page.getByRole('dialog', { name: 'Conversation 1', exact: true })
  await panel.getByRole('button', { name: /Message timing/ }).click()
  await expect(page.getByRole('option', { name: 'Add to current turn', exact: true })).toHaveCount(0)
  await page.getByRole('option', { name: /^Send after this turn/ }).click()
  await panel.getByRole('textbox', { name: 'Add a follow-up', exact: true }).fill('Run this later')
  await panel.getByRole('button', { name: 'Send after this turn', exact: true }).click()
  await expect.poll(() => mock.commands.filter(command => command.op === 'chat-queue').length).toBe(1)
  expect(mock.commands.filter(command => command.op === 'chat-steer')).toHaveLength(0)
})

test('Home reviews approvals and acknowledges a message only after the explicit action', async ({ page }) => {
  const mock = await services(page)
  mock.chats[0].requests = [{ requestId: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'npm test', reason: 'Run the project checks' } }]
  await page.goto('/#/home')
  await needs(page).getByRole('link', { name: /Conversation 1 / }).click()
  const approval = page.getByRole('dialog', { name: 'Conversation 1' })
  await expect(approval).toContainText('npm test')
  expect(mock.commands.some(row => row.op === 'chat-answer')).toBe(false)
  await approval.getByRole('button', { name: 'Approve once', exact: true }).click()
  await expect(approval.getByRole('status').filter({ hasText: 'Response sent.' })).toHaveText('Response sent.')
  expect(mock.commands.find(row => row.op === 'chat-answer')?.args).toMatchObject({ requestId: 'approval', decision: 'accept' })
  await approval.getByRole('button', { name: 'Close details' }).click()
  await needs(page).getByRole('link', { name: /Review report 42/ }).click()
  const messagePanel = page.getByRole('dialog', { name: 'Review report 42' })
  expect(mock.commands.some(row => row.op === 'acknowledge')).toBe(false)
  await messagePanel.getByRole('button', { name: 'Acknowledge', exact: true }).click()
  await expect(messagePanel.getByRole('status').filter({ hasText: 'Message acknowledged.' })).toHaveText('Message acknowledged.')
  expect(mock.commands.filter(row => row.op === 'acknowledge')).toHaveLength(1)
  expect(mock.messages.find(row => row.id === '42')?.acknowledged_at).toBeTruthy()
  await messagePanel.getByRole('button', { name: 'Close details' }).click()
  await expect(needs(page)).not.toContainText('Review report 42')
})

test('Home filters workspace tabs and browses project files without leaving the page', async ({ page }) => {
  const mock = await services(page)
  await page.goto('/#/home')
  await settled(page)
  await expect(page.getByRole('tabpanel')).toContainText('Studio')
  await page.getByRole('searchbox', { name: 'Search projects' }).fill('missing')
  await expect(page.getByRole('tabpanel')).toContainText('No matching projects')
  await page.getByRole('searchbox', { name: 'Search projects' }).fill('Studio')
  await page.getByRole('button', { name: 'Browse files in Studio' }).click()
  const files = page.getByRole('dialog', { name: 'Studio' })
  await files.getByRole('button', { name: 'Open file README.md' }).click()
  await expect(files.getByRole('region', { name: 'File preview' })).toContainText('Studio project notes')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Browse files in Studio' })).toBeFocused()
  await page.getByRole('tab', { name: /^Terminals/ }).click()
  await expect(page.getByRole('tabpanel')).toContainText('Available shell')
  await expect(page.getByRole('tabpanel')).not.toContainText('exited process')
  await page.getByRole('searchbox', { name: 'Search terminals' }).fill('Available')
  await expect(page.locator('.home-workspace-card')).toHaveCount(1)
  expect(mock.commands.filter(row => row.op === 'project-files-list').every(row => row.args.projectId === 'studio')).toBe(true)
  expect(mock.commands.some(row => row.op === 'attach')).toBe(false)
  await expect(page).toHaveURL(/#\/home$/)
})

test('Home paginates a large project catalog into a four by three grid and opens files from later pages', async ({ page }) => {
  const mock = await services(page)
  mock.projects.push(...Array.from({ length: 1000 }, (_, n) => ({ id: `project-${n + 1}`, name: `Project ${n + 1}`,
    path: `/workspace/project-${n + 1}`, createdAt: now, updatedAt: now })))
  await page.goto('/#/home')
  await settled(page)
  const cards = page.locator('.home-project-grid > article')
  const pagination = page.getByRole('navigation', { name: 'Project pages' })
  await expect(cards).toHaveCount(12)
  await expect(pagination.getByRole('status')).toHaveText('1–12 of 1001 projects')
  await expect(pagination).toContainText('Page 1 of 84')
  await expect(pagination.getByRole('button', { name: 'Previous page' })).toBeDisabled()
  const layout = await cards.evaluateAll(elements => ({
    columns: new Set(elements.map(element => Math.round(element.getBoundingClientRect().left))).size,
    rows: new Set(elements.map(element => Math.round(element.getBoundingClientRect().top))).size,
  }))
  expect(layout).toEqual({ columns: 4, rows: 3 })
  await pagination.getByRole('button', { name: 'Next page' }).click()
  await expect(cards).toHaveCount(12)
  await expect(cards.first().getByRole('heading')).toHaveText('Project 12')
  await expect(pagination.getByRole('status')).toHaveText('13–24 of 1001 projects')
  await page.getByRole('button', { name: 'Browse files in Project 12', exact: true }).click()
  const files = page.getByRole('dialog', { name: 'Project 12', exact: true })
  await expect(files).toBeVisible()
  expect(mock.commands.filter(command => command.op === 'project-files-list').at(-1)?.args.projectId).toBe('project-12')
  await files.getByRole('button', { name: 'Close details' }).click()
  await pagination.getByRole('button', { name: 'Previous page' }).click()
  await expect(cards.first().getByRole('heading')).toHaveText('Studio')
})

test('Home project search resets pagination and project removal leaves a valid page', async ({ page }) => {
  const mock = await services(page)
  mock.projects.push(...Array.from({ length: 25 }, (_, n) => ({ id: `project-${n + 1}`, name: `Project ${n + 1}`,
    path: `/workspace/project-${n + 1}`, createdAt: now, updatedAt: now })))
  await page.goto('/#/home')
  await settled(page)
  const cards = page.locator('.home-project-grid > article')
  const pagination = page.getByRole('navigation', { name: 'Project pages' })
  await pagination.getByRole('button', { name: 'Next page' }).click()
  await pagination.getByRole('button', { name: 'Next page' }).click()
  await expect(cards).toHaveCount(2)
  await expect(pagination.getByRole('status')).toHaveText('25–26 of 26 projects')
  await expect(pagination.getByRole('button', { name: 'Next page' })).toBeDisabled()
  const search = page.getByRole('searchbox', { name: 'Search projects' })
  await search.fill('/workspace/project-25')
  await expect(cards).toHaveCount(1)
  await expect(cards.getByRole('heading')).toHaveText('Project 25')
  await expect(pagination).toHaveCount(0)
  await search.fill('no matching project')
  await expect(page.getByRole('heading', { name: 'No matching projects' })).toBeVisible()
  await search.fill('')
  await expect(pagination.getByRole('status')).toHaveText('1–12 of 26 projects')
  await pagination.getByRole('button', { name: 'Next page' }).click()
  await pagination.getByRole('button', { name: 'Next page' }).click()
  const removed = mock.projects.splice(13)
  mock.projectsChanged()
  await expect(cards).toHaveCount(1)
  await expect(cards.getByRole('heading')).toHaveText('Project 12')
  await expect(pagination.getByRole('status')).toHaveText('13–13 of 13 projects')
  await expect(pagination).toContainText('Page 2 of 2')
  await expect(pagination.getByRole('button', { name: 'Next page' })).toBeDisabled()
  mock.projects.push(...removed)
  mock.projectsChanged()
  await expect(pagination.getByRole('status')).toHaveText('13–24 of 26 projects')
  await expect(pagination).toContainText('Page 2 of 3')
  await expect(pagination.getByRole('button', { name: 'Next page' })).toBeEnabled()
  mock.projects.splice(1)
  mock.projectsChanged()
  await expect(cards).toHaveCount(1)
  await expect(cards.getByRole('heading')).toHaveText('Studio')
  await expect(pagination).toHaveCount(0)
})

test('Home project pages keep at most three rows on desktop, tablet, and mobile', async ({ page }) => {
  const mock = await services(page)
  mock.projects.push(...Array.from({ length: 60 }, (_, n) => ({ id: `project-${n + 1}`, name: `Project ${n + 1}`,
    path: `/workspace/project-${n + 1}`, createdAt: now, updatedAt: now })))
  await page.goto('/#/home')
  await settled(page)
  const cards = page.locator('.home-project-grid > article')
  const pagination = page.getByRole('navigation', { name: 'Project pages' })
  for (const [width, pageSize] of [[1440, 12], [1000, 6], [390, 3], [320, 3]]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(cards).toHaveCount(pageSize)
    await expect(pagination.getByRole('status')).toHaveText(`1–${pageSize} of 61 projects`)
    expect(await cards.evaluateAll(elements => new Set(elements.map(element => Math.round(element.getBoundingClientRect().top))).size)).toBe(3)
    expect(await page.getByRole('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await pagination.getByRole('button', { name: 'Next page' }).click()
    await expect(cards).toHaveCount(pageSize)
    await expect(pagination.getByRole('status')).toHaveText(`${pageSize + 1}–${pageSize * 2} of 61 projects`)
    await page.getByRole('main').evaluate(element => { element.scrollTop = element.scrollHeight })
    const previous = (await pagination.getByRole('button', { name: 'Previous page' }).boundingBox())!
    const next = (await pagination.getByRole('button', { name: 'Next page' }).boundingBox())!
    expect(previous.y).toBe(next.y)
    expect(await pagination.getByRole('button', { name: 'Next page' }).evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2))
    })).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`home-project-pages-${width}.png`), fullPage: true })
    await pagination.getByRole('button', { name: 'Previous page' }).click()
  }
})

test('Home opens a new terminal only after its name is confirmed', async ({ page }) => {
  const mock = await services(page)
  await page.goto('/#/home')
  await settled(page)
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Open a terminal' })
  expect(mock.commands.some(row => row.op === 'create')).toBe(false)
  await panel.getByRole('textbox', { name: 'Terminal name' }).fill('Build review')
  await panel.getByRole('button', { name: 'Open terminal', exact: true }).click()
  await expect(page).toHaveURL(/#\/terminals\/Build%20review$/)
  expect(mock.commands.filter(row => row.op === 'create').map(row => row.args)).toEqual([{ name: 'Build review', columns: 100, rows: 30 }])
})

test('Home runs a saved workflow through the existing Runner with validated inputs', async ({ page }) => {
  await services(page)
  const jobs: Command[] = []
  await page.routeWebSocket('**/api/workflow-jobs/ws', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw)) as Command & { id: string }
      jobs.push(command)
      const result = command.op === 'health' ? { protocol: 1 } : command.op === 'submit' ? { job: { id: 'home-workflow-job', state: 'completed' } } : command.op === 'events' ?
        { events: [], state: 'completed', next_after: 0, has_more: false } : { id: 'home-workflow-job', state: 'completed', result: {}, error: null }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto('/#/home')
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click()
  await page.getByRole('dialog', { name: 'Run a workflow' }).getByRole('button', { name: /Sequential hello/ }).click()
  const panel = page.getByRole('dialog', { name: 'Sequential hello' })
  await expect(panel.getByRole('button', { name: 'Start workflow' })).toBeEnabled()
  expect(jobs.some(row => row.op === 'submit')).toBe(false)
  await panel.getByText('Workflow inputs', { exact: true }).click()
  await panel.getByRole('textbox', { name: 'Inputs (JSON)' }).fill('[]')
  await panel.getByRole('button', { name: 'Start workflow' }).click()
  await expect(panel.getByRole('alert')).toHaveText('Workflow inputs must be a JSON object.')
  expect(jobs.some(row => row.op === 'submit')).toBe(false)
  await panel.getByRole('textbox', { name: 'Inputs (JSON)' }).fill('{"topic":"home launch"}')
  await panel.getByRole('button', { name: 'Start workflow' }).click()
  await expect(page).toHaveURL(/#\/workflows\/sequential-hello$/)
  expect(jobs.filter(row => row.op === 'submit')).toHaveLength(1)
  expect(jobs.find(row => row.op === 'submit')?.args.submission).toMatchObject({ inputs: { topic: 'home launch' }, metadata: { workflowId: 'sequential-hello' } })
})

for (const theme of ['light', 'dark']) {
  test(`Home is accessible in ${theme} mode and at narrow widths with enlarged text`, async ({ page }) => {
    await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), theme)
    await services(page)
    await page.goto('/#/home')
    await expect(needs(page).getByRole('listitem')).toHaveCount(4)
    await settled(page)
    await page.screenshot({ path: test.info().outputPath(`home-${theme}.png`), animations: 'disabled' })
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: test.info().outputPath(`home-${theme}-mobile.png`), animations: 'disabled' })
    await page.getByRole('button', { name: 'Browse projects', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your workspace' })).toBeInViewport()
    await page.screenshot({ path: test.info().outputPath(`home-${theme}-workspace-mobile.png`), animations: 'disabled' })
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
      await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const overflow = await page.getByRole('main').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth,
        elements: [...el.querySelectorAll('*')].filter(item => item.scrollWidth > item.clientWidth + 2).map(item => ({ tag: item.tagName, class: item.className, width: item.clientWidth, scroll: item.scrollWidth, text: item.textContent?.slice(0, 80) })).slice(0, 15) }))
      expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width)
      await page.screenshot({ path: test.info().outputPath(`home-${theme}-${width}.png`), animations: 'disabled', fullPage: true })
    }
  })
}

for (const width of [1440, 390]) {
  test(`activity cards keep equal sizes through loading, populated and empty states at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    const mock = await services(page, { empty: true, hold: true })
    await page.goto('/#/home')
    await expect(needs(page).getByRole('status')).toHaveText('Checking what needs you…')
    const first = (await needs(page).boundingBox())!
    const sameSize = async () => {
      const [attention, live] = await Promise.all([needs(page).boundingBox(), running(page).boundingBox()])
      expect(attention!.width).toBeCloseTo(live!.width, 0)
      expect(attention!.height).toBeCloseTo(live!.height, 0)
      expect(attention!.height).toBeCloseTo(first.height, 0)
    }
    await sameSize()
    mock.chats.push(...Array.from({ length: 6 }, (_, n) => chat(n + 10)), ...Array.from({ length: 6 }, (_, n) => chat(n + 20, 'running')))
    mock.release()
    await settled(page)
    await expect(needs(page).getByRole('listitem')).toHaveCount(6)
    await expect(running(page).getByRole('listitem')).toHaveCount(6)
    await sameSize()
    for (const card of [needs(page), running(page)]) {
      const scroll = card.locator('.home-activity-scroll')
      const measurements = await scroll.evaluate(element => {
        const rows = element.querySelectorAll('li')
        const viewport = element.getBoundingClientRect()
        const third = rows[2].getBoundingClientRect()
        return { height: element.clientHeight, row: rows[0].getBoundingClientRect().height,
          scrollable: element.scrollHeight > element.clientHeight, horizontal: element.scrollWidth > element.clientWidth,
          partialThird: third.top < viewport.bottom && third.bottom > viewport.bottom }
      })
      expect(measurements.height / measurements.row).toBeCloseTo(2.5, 1)
      expect(measurements.scrollable).toBe(true)
      expect(measurements.horizontal).toBe(false)
      expect(measurements.partialThird).toBe(true)
      await scroll.focus()
      const mainScroll = await page.getByRole('main').evaluate(element => element.scrollTop)
      await scroll.press('PageDown')
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      expect(await page.getByRole('main').evaluate(element => element.scrollTop)).toBe(mainScroll)
      await scroll.evaluate(element => { element.scrollTop = 0 })
    }
    await page.screenshot({ path: test.info().outputPath(`home-activity-${width}.png`), fullPage: true })
    for (let n = 20; n < 26; n++) mock.updateChat(n, 'completed')
    await expect(running(page)).toContainText('No running work.')
    await sameSize()
    for (let n = 10; n < 16; n++) mock.updateChat(n, 'completed')
    await expect(needs(page)).toContainText('Nothing needs your response right now.')
    await sameSize()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test('long activity titles and descriptions remain compact while the full request opens in details', async ({ page }) => {
  const mock = await services(page)
  const title = 'Review the release checklist and deployment readiness '.repeat(8)
  const question = 'Please review all deployment checks before selecting the next step. '.repeat(6).trim()
  mock.chats[0].title = title
  mock.chats[0].project = 'Very long project name '.repeat(10)
  mock.chats[0].requests[0].params.questions![0].question = question
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/home')
  await settled(page)
  const row = needs(page).locator(`[data-work-key="chat:${chatId(1)}"]`)
  await expect(row.locator('.home-work-title')).toHaveCSS('white-space', 'nowrap')
  await expect(row.locator('.home-work-meta')).toHaveCSS('white-space', 'nowrap')
  await expect(row.locator('.bbb-badge')).toHaveText('Needs input')
  await expect(row.locator('.home-work-reason')).toHaveCount(0)
  expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await row.getByRole('link').click()
  const panel = page.getByRole('dialog', { name: title.trim(), exact: true })
  await expect(panel.getByRole('textbox', { name: question, exact: true })).toBeVisible()
})

test('Browse projects clears stale searches on the current tab and when returning from another tab', async ({ page }) => {
  await services(page)
  await page.goto('/#/home')
  await settled(page)
  for (const tab of ['Projects', 'Terminals']) {
    await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
    await page.getByRole('searchbox', { name: `Search ${tab.toLowerCase()}` }).fill('no matching items')
    await expect(page.locator('.home-workspace-card')).toHaveCount(0)
    await page.getByRole('button', { name: 'Browse projects', exact: true }).click()
    await expect(page.getByRole('tab', { name: /^Projects/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('searchbox', { name: 'Search projects' })).toHaveValue('')
    await expect(page.getByRole('heading', { name: 'Your workspace' })).toBeFocused()
    await expect(page.getByRole('heading', { name: 'Your workspace' })).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Browse files in Studio' })).toBeInViewport()
  }
  await page.getByRole('button', { name: 'Browse files in Studio' }).click()
  await expect(page.getByRole('dialog', { name: 'Studio', exact: true })).toBeVisible()
})

test('dismissed reminders persist, can be undone or restored, and changed requests return', async ({ page }) => {
  await mockAuthentication(page)
  const mock = await services(page)
  await page.goto('/#/home')
  await settled(page)
  const dismiss = () => needs(page).getByRole('button', { name: 'Dismiss Conversation 1', exact: true })
  await dismiss().click()
  await expect(dismiss()).toHaveCount(0)
  await needs(page).getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(dismiss()).toBeVisible()
  await dismiss().click()
  await page.reload()
  await settled(page)
  await expect(dismiss()).toHaveCount(0)
  await needs(page).getByRole('button', { name: 'View dismissed (1)', exact: true }).click()
  await needs(page).getByRole('button', { name: 'Restore Conversation 1', exact: true }).click()
  await expect(dismiss()).toBeVisible()
  await dismiss().click()
  mock.updateChat(1, 'uncertain')
  await expect(dismiss()).toBeVisible()
  expect(mock.commands.some(row => ['chat-answer', 'set_message_state', 'input', 'clean-selected'].includes(row.op))).toBe(false)
})
