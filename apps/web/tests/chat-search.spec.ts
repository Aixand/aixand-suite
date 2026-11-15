import { expect, test, type Page } from './fixtures'
import type { ChatSnapshot } from '../src/chats/model'

async function searchFixture(page: Page) {
  const visibleId = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const hiddenId = '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const snapshot: ChatSnapshot = {
    id: hiddenId, provider: 'codex', profile: 'work', auth: null, cwd: '/workspace', project: 'Archive', mode: 'chat',
    title: 'An old conversation', status: 'completed', revision: 1, createdAt: 1, updatedAt: 1, requests: [],
    items: [{ id: 'match', type: 'agentMessage', text: 'The pineapple migration is documented here.' }],
  }
  const operations: { op: string; args: Record<string, unknown> }[] = []
  const stale: (() => void)[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.routeWebSocket('**/api/carrier/ws', route => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', route => {
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage(raw => {
      const command = JSON.parse(String(raw))
      operations.push(command)
      let result: unknown = []
      if (command.op === 'catalog') result = { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: '/workspace' }
      else if (command.op === 'sessions') result = { runs: [], runtimeError: null }
      else if (command.op === 'mcp-catalog') result = { servers: [] }
      else if (command.op === 'project-discovery-list') result = { jobs: [], nextOffset: null }
      else if (command.op === 'chat-workflow-runs') result = { runs: [], nextOffset: null }
      else if (command.op === 'chat-list') result = [{ ...snapshot, id: visibleId, title: 'Recent conversation', items: undefined, requests: undefined }]
      else if (command.op === 'chat-search') result = {
        results: [{ chatId: hiddenId, itemId: command.args.query === 'second' ? 'other-match' : 'match', title: 'An old conversation', project: 'Archive', profile: 'work', excerpt: `Found ${command.args.query} in old messages` }],
        cursor: command.args.cursor ? null : '25', indexing: command.args.query === 'indexing', partial: true,
      }
      else if (command.op === 'chat-open') result = command.args.around ? { ...snapshot, items: Array.from({ length: 17 }, (_, index) => ({ id: index === 8 ? command.args.around : `context-${command.args.around}-${index}`, turnId: `turn-${index}`, type: 'agentMessage', text: index === 8 ? command.args.around === 'match' ? 'The pineapple migration is documented here.' : 'Second matching older reply.' : `Nearby historical context ${index}` })), indexedHistory: true, searchItemId: command.args.around, historyCursor: `context-${command.args.around}-0`, historyAfter: `context-${command.args.around}-16`, historyUnavailable: true } :
        { ...snapshot, items: [{ id: 'latest', type: 'agentMessage', text: 'The latest response.' }] }
      else if (command.op === 'chat-history') result = { items: [{ id: 'newer', type: 'agentMessage', text: 'More context from disk.' }], cursor: 'match', after: null, unavailable: true }
      const send = () => route.send(JSON.stringify({ type: 'result', id: command.id, result }))
      if (command.op === 'chat-search' && command.args.query === 'stale') stale.push(send)
      else send()
    })
  })
  await page.goto('/#/chat')
  await expect(page.getByRole('region', { name: 'Recent conversations', exact: true })).toContainText('Recent conversation')
  await page.getByRole('button', { name: 'Search history', exact: true }).click()
  return { operations, stale, errors, hiddenId, dialog: page.getByRole('dialog', { name: 'Search history', exact: true }) }
}

test('content match outside the loaded list opens directly at its message and pages from disk', async ({ page }) => {
  const fixture = await searchFixture(page)
  await fixture.dialog.getByRole('searchbox').fill('pineapple')
  await fixture.dialog.getByRole('menuitem', { name: /An old conversation/ }).click()
  await expect(page).toHaveURL(new RegExp(fixture.hiddenId))
  await expect(page.locator('[data-search-match=true]')).toContainText('pineapple migration')
  expect(fixture.operations.filter(command => command.op === 'chat-open').map(command => command.args.around)).toEqual(['match'])
  await page.getByRole('button', { name: 'Load newer messages', exact: true }).click()
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('More context from disk.')
  expect(fixture.operations.find(command => command.op === 'chat-history')?.args.indexed).toBe(true)
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('The latest response.')
  expect(fixture.errors).toEqual([])
})

test('search ignores stale responses and sends project and tool filters', async ({ page }) => {
  const fixture = await searchFixture(page)
  const input = fixture.dialog.getByRole('searchbox')
  await input.fill('stale')
  await expect.poll(() => fixture.stale.length).toBe(1)
  await input.fill('pineapple')
  await fixture.dialog.getByLabel('Project', { exact: true }).fill('Archive')
  await fixture.dialog.getByLabel('Include tool activity').check()
  await expect(fixture.dialog.getByRole('menuitem', { name: /An old conversation/ })).toContainText('Found pineapple')
  fixture.stale[0]()
  await expect(fixture.dialog.getByRole('menuitem', { name: /An old conversation/ })).toContainText('Found pineapple')
  const request = fixture.operations.filter(command => command.op === 'chat-search').at(-1)!
  expect(request.args.project).toBe('Archive')
  expect(request.args.includeTools).toBe(true)
  await fixture.dialog.getByRole('button', { name: 'Load more', exact: true }).click()
  await expect.poll(() => fixture.operations.filter(command => command.op === 'chat-search').at(-1)?.args.cursor).toBe('25')
  await page.keyboard.press('Escape')
  await expect(fixture.dialog).toHaveCount(0)
  expect(fixture.errors).toEqual([])
})


test('a second match in the same chat replaces the historical window', async ({ page }) => {
  const fixture = await searchFixture(page)
  await fixture.dialog.getByRole('searchbox').fill('pineapple')
  await fixture.dialog.getByRole('menuitem', { name: /An old conversation/ }).click()
  await expect(page.locator('[data-search-match=true]')).toContainText('pineapple migration')
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('Nearby historical context 0')
  await page.getByRole('button', { name: 'Search history', exact: true }).click()
  await fixture.dialog.getByRole('searchbox').fill('second')
  await fixture.dialog.getByRole('menuitem', { name: /An old conversation/ }).click()
  await expect(page.locator('[data-search-match=true]')).toContainText('Second matching older reply.')
  expect(fixture.operations.filter(command => command.op === 'chat-open').map(command => command.args.around)).toEqual(['match', 'other-match'])
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('The latest response.')
  expect(fixture.errors).toEqual([])
})
