import AxeBuilder from '@axe-core/playwright'
import { test, expect, mockAuthentication, type Page, type WebSocketRoute } from './fixtures'
import type { ChatItem, ChatSnapshot, ChatWorkflow } from '../src/chats/model'
import type { CarrierMessage } from '../src/carrier/client'
import type { Profile } from '../src/agents/client'
import { blankDraft } from '../src/workflows/builder/model'
import { LIBRARY_KEY } from '../src/workflows/library'

test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Manila', locale: 'en-US', colorScheme: 'dark' })
const at = Date.parse('2026-10-18T06:00:00Z')
const longTitle = 'Review architecture and accessibility findings before the next production release'
const chatId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`

async function workspace(page: Page, theme = 'dark') {
  await mockAuthentication(page)
  await page.clock.setFixedTime(at)
  await page.addInitScript(({ theme, key, workflows }) => {
    localStorage.setItem('aixand.appearance', theme)
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ format: 'aixand.workflow-library', version: 1, workflows }))
  }, { theme, key: LIBRARY_KEY, workflows: Array.from({ length: 12 }, (_, i) => ({ id: `saved-${i}`,
    createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
    draft: { ...blankDraft(), name: i === 0 ? longTitle : `Workspace check ${i + 1}`, description: 'Review the workspace and prepare the next steps.' },
  })) })
  const profiles: Profile[] = Array.from({ length: 36 }, (_, i) => ({ id: `codex/${i ? `workspace-${i}` : 'work'}`,
    provider: 'codex', profile: i ? `workspace-${i}` : 'work', auth: 'company', active_runs: i % 3 }))
  const chats: ChatSnapshot[] = Array.from({ length: 30 }, (_, i) => ({ id: chatId(i), title: i === 0 ? longTitle : `Workspace review ${i + 1}`,
    provider: 'codex', profile: 'work', auth: 'company', cwd: '/workspace/studio', project: 'Studio', mode: 'chat',
    status: i === 1 ? 'waiting' : i % 3 === 0 ? 'running' : 'completed', createdAt: at - 3600000, updatedAt: at - i * 60000,
    revision: 1, items: [], requests: i === 1 ? [{ requestId: 'direction', method: 'item/tool/requestUserInput', params: {
      questions: [{ id: 'choice', header: 'Direction', question: 'Which changes should be included in the release?' }],
    } }] : [], queue: { paused: false, messages: [] },
  }))
  const activity: ChatItem[] = Array.from({ length: 5 }, (_, i) => ({ id: `tool-${i}`, type: 'commandExecution',
    command: 'node scripts/check-workspace-configuration.mjs --project=production-workspace --report=architecture-and-accessibility',
    status: i === 3 ? 'failed' : 'completed', exitCode: i === 3 ? 1 : 0,
    text: Array.from({ length: 80 }, (_, line) => `Check ${line + 1}: workspace configuration recorded.`).join('\n'),
  }))
  chats[2].items = Array.from({ length: 6 }, (_, i): ChatItem[] => [
    { id: `user-${i}`, type: 'userMessage', text: 'Review the deployment settings and explain the next steps.' },
    ...activity.map(item => ({ ...item, id: `${item.id}-${i}` })),
    { id: `reply-${i}`, type: 'agentMessage', text: '## Deployment review\n\nAuthentication and recovery are configured. Review the migration before choosing the next step.\n\n```sh\nnode scripts/verify.mjs --workspace=production --report=architecture-and-accessibility --output=review-results.json\n```\n\n| Check | Result |\n| --- | --- |\n| Authentication | Configured |\n| Accessibility | Ready for review |\n\n```sh\necho ready\n```\n\nNo deployment has been started.' },
  ]).flat()
  const runs: ChatWorkflow[] = Array.from({ length: 18 }, (_, i) => ({ key: `run-${i}`, id: `run-${i}`, originChatId: chatId(99),
    projectId: 'studio', project: 'Studio', title: i === 0 ? longTitle : `Release verification ${i + 1}`,
    state: ['waiting', 'running', 'failed', 'completed', 'cancelled', 'uncertain'][i % 6],
    createdAt: at - 3600000, updatedAt: at - i * 60000, revision: 1, steps: [],
  }))
  const laterRun: ChatWorkflow = { ...runs[1], key: 'later-run', id: 'later-run', title: 'Newly loaded release check' }
  const messages: CarrierMessage[] = Array.from({ length: 24 }, (_, i) => ({ id: String(100 + i),
    title: i % 3 === 0 ? longTitle : `Workspace report ${i + 1}`, source: i % 2 ? 'Workspace review assistant' : 'Architecture and accessibility review assistant',
    sender: 'reviewer', recipient: 'user', body: 'The workspace review is ready. Confirm the deployment settings and choose the next step.\n\n## Findings\n\n- Authentication is configured.\n- The migration needs your review.\n- No deployment has been started.',
    content: 'The workspace review is ready.', direction: 'incoming', created_at: new Date(at - i * 7200000).toISOString(),
    read: i % 3 === 0, archived: false, reply_to: null, acknowledged_at: null, metadata: null,
  }))
  const service = { connected: true, syncing: false, error: null, last_sync: at, instance: 'populated-test',
    outgoing_history: true, agent_configured: false, providers: [], version: 1 }
  const calls: { source: string; op: string; args: Record<string, unknown> }[] = []
  const errors: string[] = []
  let failRuns = false
  let failShare = false
  page.on('pageerror', error => errors.push(error.message))
  let agents: WebSocketRoute
  for (const source of ['agents', 'carrier', 'terminals']) {
    await page.routeWebSocket(`**/api/${source}/ws`, socket => {
      if (source === 'agents') agents = socket
      socket.send(JSON.stringify({ type: 'ready' }))
      socket.onMessage(raw => {
        const command = JSON.parse(String(raw))
        const args = command.args ?? {}
        if (['auth', 'ack'].includes(command.op)) return
        calls.push({ source, op: command.op, args })
        if (source === 'agents' && command.op === 'chat-workflow-runs' && failRuns) {
          failRuns = false
          socket.send(JSON.stringify({ type: 'error', id: command.id, code: 'manager', message: 'Workflow runs could not be refreshed.' }))
          return
        }
        if (source === 'agents' && command.op === 'command-workflow-save' && failShare) {
          failShare = false
          socket.send(JSON.stringify({ type: 'error', id: command.id, code: 'manager', message: 'Could not confirm workflow sharing.' }))
          return
        }
        let result: unknown = []
        if (source === 'agents') {
          if (command.op === 'catalog') result = { profiles, auths: [{ provider: 'codex', auth: 'company', profiles: profiles.map(p => p.profile), verification: 'verified' }],
            capabilities: [{ provider: 'codex', installed: true, budgets: true, savedModels: false }], cwd: '/workspace/studio' }
          if (command.op === 'chat-list') result = chats
          if (command.op === 'chat-open') result = chats.find(row => row.id === args.chatId)
          if (command.op === 'chat-workflow-runs') result = { runs: args.offset ? [laterRun] : runs, nextOffset: args.offset ? null : 18 }
          if (command.op === 'command-list') result = { monitors: [] }
          if (command.op === 'command-workflows') result = { workflows: [] }
          if (command.op === 'command-workflow-save') result = {}
          if (command.op === 'project-list') result = [{ id: 'studio', name: 'Studio', path: '/workspace/studio' }]
          if (command.op === 'project-discovery-list') result = { jobs: [] }
          if (command.op === 'agent-operations') result = { operations: [] }
          if (command.op === 'sessions') result = { runs: [], runtimeError: null }
          if (command.op === 'session-list') result = { sessions: [], total: 0, homes: [], projects: [], counts: {}, errors: [] }
          if (command.op === 'mcp-catalog') result = { servers: [] }
          if (command.op === 'profile-resources-get') result = { revision: 'resources-1', instructions: null, skills: [], mcp: [] }
          if (command.op === 'resource-catalog') result = { choices: { instructions: [], skills: [], mcp: [] } }
        } else if (source === 'carrier') {
          if (command.op === 'mailboxes') result = [{ id: 'user', name: 'Main inbox', address: 'suite/local/user', role: 'human' }]
          if (command.op === 'status') result = service
          if (command.op === 'set_message_state') {
            const message = messages.find(item => item.id === String(args.id))!
            if (args.read !== undefined) message.read = args.read
            if (args.archived !== undefined) message.archived = args.archived
            result = message
          }
          if (command.op === 'snapshot') {
            const selected = messages.filter(item => (args.view !== 'Unread' || !item.read) && (!args.search || `${item.title} ${item.body}`.toLowerCase().includes(String(args.search).toLowerCase())))
            result = { messages: selected, status: service, counts: { Inbox: messages.length, Unread: messages.filter(item => !item.read).length, Pending: messages.length }, total: selected.length, next_offset: null }
          }
          if (command.op === 'conversation') result = { messages: messages.filter(item => item.id === String(args.id)), total: 1, partial: false }
        } else {
          if (command.op === 'list') result = { items: [], next_cursor: null, total: 0 }
          if (command.op === 'groups') result = { groups: [], defaults: { cwd: '/workspace/studio', shell: '/bin/sh' } }
        }
        socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
      })
    })
  }
  return { calls, errors, runs, chats, messages, failNextShare() { failShare = true }, failNextRunLoad() { failRuns = true }, addRun(run: ChatWorkflow) {
    runs.push(run)
    agents.send(JSON.stringify({ type: 'workflow-updated', workflow: run }))
  }, updateRun(index: number, state: string) {
    const run = runs[index]
    Object.assign(run, { state, revision: run.revision + 1, updatedAt: at + 60000 })
    agents.send(JSON.stringify({ type: 'workflow-updated', workflow: run }))
  } }
}

async function accessible(page: Page) {
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const layout = await page.getByRole('main').evaluate(el => ({
    width: el.clientWidth, scroll: el.scrollWidth,
    overflow: [...el.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > el.getBoundingClientRect().right).slice(0, 6)
      .map(child => ({ tag: child.tagName, class: String(child.className), right: child.getBoundingClientRect().right })),
  }))
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width)
}

test('busy workflows share one compact list with saved workflows, search and live updates', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/#/workflows')
  const list = page.getByRole('list', { name: 'Workflows', exact: true })
  await expect(list.getByRole('listitem')).toHaveCount(32)
  expect(await list.locator('> li').evaluateAll(rows => rows.slice(0, 9).every(row => ['attention', 'failed'].includes(row.getAttribute('data-status')!)))).toBe(true)
  await expect(list.locator('> li[data-status="active"]')).toHaveCount(3)
  await expect(list.locator('> li[data-status="finished"]')).toHaveCount(6)
  await expect(list.locator('> li[data-kind="saved"]')).toHaveCount(14)
  await expect(page.getByText('Follow running workflows, open a saved workflow, or create a new one.')).toHaveCount(0)
  await expect(page.getByText('Chat-created workflows appear here automatically.')).toHaveCount(0)
  const searchBounds = await page.getByRole('searchbox', { name: 'Search workflows' }).boundingBox()
  const newBounds = await page.getByRole('button', { name: 'New workflow', exact: true }).boundingBox()
  expect(searchBounds!.x + searchBounds!.width).toBeLessThan(newBounds!.x)
  expect(Math.abs(searchBounds!.y - newBounds!.y)).toBeLessThan(10)
  await accessible(page)
  await expect(page).toHaveScreenshot('workflows-busy.png', { animations: 'disabled' })
  const run = page.getByRole('button', { name: 'Release verification 2', exact: true })
  await run.focus()
  state.updateRun(1, 'completed')
  await expect(run).toBeFocused()
  await expect(run.locator('..')).toContainText('Completed')
  const viewRun = page.getByRole('button', { name: 'View workflow Release verification 8', exact: true })
  await viewRun.focus()
  state.updateRun(7, 'completed')
  await expect(viewRun).toBeFocused()
  await page.getByRole('searchbox', { name: 'Search workflows' }).fill('Release verification 4')
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list).toContainText('Completed')
  await page.getByRole('button', { name: 'Clear search', exact: true }).click()
  await page.getByRole('button', { name: 'Load more runs' }).click()
  await expect(list).toContainText('Newly loaded release check')
  await expect(list.locator('> li[data-kind="run"]')).toHaveCount(19)
  await page.setViewportSize({ width: 320, height: 900 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await accessible(page)
  expect(state.calls.some(call => /cancel|start|send|save/.test(call.op))).toBe(false)
  expect(state.errors).toEqual([])
})

for (const theme of ['light', 'dark']) {
  test(`workflow filters combine and live runs keep focus and update in ${theme}`, async ({ page }) => {
    const state = await workspace(page, theme)
    await page.goto('/#/workflows')
    const list = page.getByRole('list', { name: 'Workflows', exact: true })
    await expect(list.getByRole('listitem')).toHaveCount(32)
    await page.getByRole('button', { name: 'Filter workflows', exact: true }).click()
    const filters = page.getByRole('dialog', { name: 'Filter workflows', exact: true })
    await filters.getByRole('button', { name: /Show/ }).click()
    await page.getByRole('option', { name: 'Runs', exact: true }).click()
    await expect(list.getByRole('listitem')).toHaveCount(18)
    await filters.getByRole('button', { name: /Status/ }).click()
    await page.getByRole('option', { name: 'Active', exact: true }).click()
    await expect(list.getByRole('listitem')).toHaveCount(3)
    await filters.getByRole('button', { name: /Project/ }).click()
    await page.getByRole('option', { name: 'Studio', exact: true }).click()
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Filter workflows, 3 active filters', exact: true })).toBeVisible()
    await accessible(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Filter workflows, 3 active filters', exact: true })).toBeFocused()
    const search = page.getByRole('searchbox', { name: 'Search workflows' })
    await search.fill('Release verification 2')
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await page.getByRole('button', { name: 'Clear search', exact: true }).click()
    const run = page.getByRole('button', { name: 'Release verification 2', exact: true })
    await run.focus()
    state.updateRun(1, 'completed')
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(search).toBeFocused()
    state.addRun({ ...state.runs[1], key: 'fresh-run', id: 'fresh-run', state: 'running', title: 'Fresh chat workflow', updatedAt: at + 120000 })
    await expect(list.getByRole('listitem')).toHaveCount(3)
    await expect(list.getByRole('listitem').first()).toContainText('Fresh chat workflow')
    await page.getByRole('button', { name: /^Filter workflows/ }).click()
    await filters.getByRole('button', { name: /Status/ }).click()
    await page.getByRole('option', { name: 'Needs attention', exact: true }).click()
    await expect(list.getByRole('listitem')).toHaveCount(9)
    await filters.getByRole('button', { name: /Status/ }).click()
    await page.getByRole('option', { name: 'Failed', exact: true }).click()
    await expect(list.getByRole('listitem')).toHaveCount(3)
    await filters.getByRole('button', { name: /Show/ }).click()
    await page.getByRole('option', { name: 'Saved workflows', exact: true }).click()
    await expect(filters.getByRole('button', { name: /Status/ })).toBeDisabled()
    await expect(page.getByRole('heading', { name: 'No matching workflows' })).toBeVisible()
    await filters.getByRole('button', { name: 'Reset filters', exact: true }).click()
    await expect(list.getByRole('listitem')).toHaveCount(33)
    await page.keyboard.press('Escape')
    await expect(filters).toHaveCount(0)
    await page.setViewportSize({ width: 320, height: 900 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await page.screenshot({ path: test.info().outputPath(`workflows-${theme}-phone.png`), animations: 'disabled' })
    await accessible(page)
    await page.getByRole('button', { name: 'Filter workflows', exact: true }).click()
    await expect(filters).toBeVisible()
    await accessible(page)
    await page.screenshot({ path: test.info().outputPath(`workflows-filters-${theme}-phone.png`), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await page.evaluate(() => { document.documentElement.style.fontSize = '100%' })
    await page.setViewportSize({ width: 390, height: 900 })
    await page.getByRole('heading', { name: 'Workflows', exact: true }).scrollIntoViewIfNeeded()
    await accessible(page)
    await page.screenshot({ path: test.info().outputPath(`workflows-${theme}-phone-standard.png`), animations: 'disabled' })
    expect(state.calls.some(call => /cancel|start|send|save/.test(call.op))).toBe(false)
    expect(state.errors).toEqual([])
  })
}

test('workflow list keeps saved items through run loading failures and sharing stays in its menu', async ({ page }) => {
  const state = await workspace(page, 'light')
  await page.goto('/#/workflows')
  const list = page.getByRole('list', { name: 'Workflows', exact: true })
  await expect(list.getByRole('listitem')).toHaveCount(32)
  state.failNextRunLoad()
  await page.getByRole('button', { name: 'Load more runs', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Workflow runs could not be refreshed.' })).toBeVisible()
  await expect(list.locator('> li[data-kind="saved"]')).toHaveCount(14)
  await page.getByRole('button', { name: 'Retry loading runs', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Workflow runs could not be refreshed.' })).toHaveCount(0)
  await expect(list.getByRole('listitem')).toHaveCount(32)
  await page.getByRole('button', { name: 'Load more runs', exact: true }).click()
  await expect(list.getByRole('listitem')).toHaveCount(33)
  state.failNextShare()
  await page.getByRole('button', { name: 'Actions for Brain and Implementer', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Make available to supervisors', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Brain and Implementer: Could not confirm workflow sharing.' })).toBeVisible()
  await expect(list.locator('> li[data-kind="saved"]')).toHaveCount(14)
  await page.getByRole('button', { name: 'Actions for Brain and Implementer', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Make available to supervisors', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Could not confirm workflow sharing.' })).toHaveCount(0)
  await expect.poll(() => state.calls.filter(call => call.op === 'command-workflow-save').length).toBe(2)
  const saves = state.calls.filter(call => call.op === 'command-workflow-save')
  expect(saves[1].args).toEqual(saves[0].args)
  await page.getByRole('button', { name: 'Actions for Brain and Implementer', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Available to supervisors', exact: true })).toBeDisabled()
  expect(state.errors).toEqual([])
})

test('a crowded inbox keeps the full selected message accessible on desktop and phone', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/#/carrier')
  const rows = page.locator('.carrier-message-scroll--mail .carrier-message-row')
  await expect(rows).toHaveCount(24)
  const position = await rows.first().boundingBox()
  await rows.first().hover()
  expect(await rows.first().boundingBox()).toEqual(position)
  await rows.first().focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: longTitle, exact: true })).toBeVisible()
  await accessible(page)
  await expect(page).toHaveScreenshot('carrier-busy.png', { animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 900 })
  await page.getByRole('button', { name: 'Back to messages', exact: true }).click()
  await expect(rows.first()).toBeFocused()
  await accessible(page)
  await expect(page).toHaveScreenshot('carrier-busy-phone.png', { animations: 'disabled' })
  await page.getByRole('button', { name: 'Search messages', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search messages', exact: true }).fill('Workspace report 2')
  await expect(rows).toHaveCount(5)
  await rows.first().click()
  await page.setViewportSize({ width: 320, height: 900 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await expect(page.getByRole('heading', { name: 'Workspace report 2', exact: true })).toBeVisible()
  await accessible(page)
  expect(state.calls.some(call => call.op === 'send' || call.op === 'acknowledge')).toBe(false)
  expect(state.errors).toEqual([])
})

for (const theme of ['light', 'dark']) {
  test(`long conversations keep failed activity visible and give scrolling code and output keyboard access in ${theme}`, async ({ page }) => {
    const state = await workspace(page, theme)
    await page.goto(`/#/chat/${state.chats[2].id}`)
    await expect(page.locator('.command-activity-group').first()).toBeAttached()
    expect(await page.locator('.command-activity-group').count()).toBeGreaterThanOrEqual(5)
    const activity = page.locator('.command-activity-group').last()
    await expect(activity.locator('summary').first()).toContainText('Needs attention')
    await activity.locator('summary').first().click()
    await activity.locator('.command-tool-activity > summary').last().click()
    const output = activity.getByRole('region', { name: 'Activity output', exact: true })
    await output.focus()
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => output.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    const code = page.getByRole('region', { name: 'sh code', exact: true }).last()
    await code.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => code.evaluate(el => el.scrollLeft)).toBeGreaterThan(0)
    await expect(page.locator('.command-code-block pre').last()).not.toHaveAttribute('tabindex')
    await accessible(page)
    if (theme === 'dark') await expect(page).toHaveScreenshot('conversation-busy.png', { animations: 'disabled' })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 390, height: 900 })
    if (theme === 'dark') {
      expect(await activity.locator('.command-disclosure-chevron').first().evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s')
      await expect(page).toHaveScreenshot('conversation-busy-phone.png', { animations: 'disabled' })
    }
    await page.setViewportSize({ width: 320, height: 900 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await accessible(page)
    expect(state.errors).toEqual([])
  })
}

test('a populated Home and profile library keep useful summaries bounded and searchable', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/#/home')
  await expect(page.locator('.home-feed-status')).toHaveText('')
  await expect(page.getByRole('list', { name: 'Work needing you' }).getByRole('listitem')).toHaveCount(5)
  await expect(page.getByRole('list', { name: 'Running work' }).getByRole('listitem')).toHaveCount(3)
  await accessible(page)
  await expect(page).toHaveScreenshot('home-busy.png', { animations: 'disabled' })
  const requests = page.getByRole('list', { name: 'Work needing you' })
  await page.getByRole('button', { name: /View all \d+ requests/ }).click()
  expect(await requests.getByRole('listitem').count()).toBeGreaterThan(5)
  await page.getByRole('button', { name: 'Show fewer', exact: true }).click()
  await expect(requests.getByRole('listitem')).toHaveCount(5)
  await page.goto('/#/agents/profiles')
  await expect(page.locator('.agent-profile-row')).toHaveCount(36)
  await page.getByRole('searchbox', { name: 'Search profiles', exact: true }).fill('workspace-35')
  await expect(page.locator('.agent-profile-row')).toHaveCount(1)
  await page.getByRole('button', { name: 'workspace-35 · Codex', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Codex workspace-35', exact: true })).toBeVisible()
  await accessible(page)
  await page.setViewportSize({ width: 320, height: 900 })
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  await accessible(page)
  expect(state.errors).toEqual([])
})
