import { openChatSettings, expect, test, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { Discovery, DiscoveryCandidate, DiscoveryFilter, Project } from '../src/projects/model'
import type { ChatSnapshot } from '../src/chats/model'

const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const rootId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const nestedId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
function discovery(): Discovery {
  return { id: jobId, origin: { kind: 'ui', id: 'workspace' }, root: '/work/projects', requestedRoot: '/work/projects',
    mode: 'preview', includeNested: false, exclude: [], defaultExclusions: ['node_modules', '.git'],
    state: 'completed', scanComplete: true, revision: 3, createdAt: 1, updatedAt: 3, url: null,
    stats: { directories: 3, candidates: 2, nested: 1 }, warnings: [], reasons: [], error: null, registration: null }
}
const candidates: DiscoveryCandidate[] = [
  { id: rootId, path: '/work/projects/app', suggestedName: 'app', signals: ['package.json'], classification: 'root', parentCandidateId: null, recommended: true, existingProjectIds: [] },
  { id: nestedId, path: '/work/projects/app/member', suggestedName: 'member', signals: ['Cargo.toml'], classification: 'nested', parentCandidateId: rootId, recommended: false, existingProjectIds: [] },
]

async function fixture(page: Page, options: { savedChat?: boolean; failFirstImport?: boolean } = {}) {
  const operations: { op: string; args: Record<string, unknown> }[] = []
  const projects: Project[] = []
  let job = discovery()
  let saved = !!options.savedChat
  let importFailed = false
  let publish = () => {}
  let registryChanged = () => {}
  function removeProject(projectId: string) {
    const index = projects.findIndex((project) => project.id === projectId)
    if (index < 0) return
    projects.splice(index, 1)
    job = { ...job, revision: job.revision + 1 }
    chat.discoveries = [job]
    registryChanged()
    publish()
  }
  function visibleCandidates() {
    const value = job.resultFilter
    const query = value?.query.toLowerCase() ?? ''
    return candidates.filter((row) => (value?.scope !== 'roots' || row.classification === 'root') &&
      (!query || row.suggestedName.toLowerCase().includes(query) || row.path.toLowerCase().includes(query)) &&
      (value?.candidateIds === undefined || value.candidateIds.includes(row.id)))
  }
  function updateFilter(value: DiscoveryFilter) {
    job = { ...job, revision: job.revision + 1, resultFilter: value }
    const rows = visibleCandidates()
    job = { ...job, filtered: { matched: rows.length, total: candidates.length, preview: rows } }
    chat.discoveries = [job]
    publish()
  }
  const chat: ChatSnapshot = { id: chatId, provider: 'codex', profile: 'work', auth: null, cwd: '/work/scratch', project: '',
    mode: 'chat', title: 'Find my projects', status: 'completed', revision: 1, createdAt: 1, updatedAt: 1,
    items: [{ id: 'reply', type: 'agentMessage', text: 'Discovery is running in the backend.' }], requests: [], discoveries: [] }
  if (options.savedChat) {
    job = { ...job, origin: { kind: 'chat', id: chatId }, mode: 'add',
      registration: { selected: 1, added: 1, existing: 0, unavailable: 0, capacity: 199, projectIds: [rootId] } }
    chat.discoveries = [job]
    projects.push({ id: rootId, name: 'app', path: candidates[0].path })
  }
  await page.routeWebSocket('**/api/carrier/ws', (route) => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    publish = () => route.send(JSON.stringify({ type: 'project-discovery-updated', discovery: job }))
    registryChanged = () => route.send(JSON.stringify({ type: 'projects-changed' }))
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      operations.push(message)
      let result: unknown = {}
      switch (message.op) {
        case 'catalog': result = { profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: '/work' }; break
        case 'sessions': result = { runs: [], runtimeError: null }; break
        case 'models': case 'chat-launches': case 'mcp-jobs': result = []; break
        case 'mcp-catalog': result = { servers: [] }; break
        case 'mcp-preview': result = { selection: {}, states: [] }; break
        case 'project-list': result = projects; break
        case 'project-discovery-list': result = { jobs: saved ? [job] : [], nextOffset: null }; break
        case 'chat-list': result = options.savedChat ? [chat] : []; break
        case 'chat-open': result = chat; break
        case 'project-discovery-get': result = job; break
        case 'project-discovery-start': {
          saved = true
          job = { ...job, root: message.args.root, requestedRoot: message.args.root, mode: message.args.mode,
            includeNested: message.args.includeNested, exclude: message.args.exclude }
          route.send(JSON.stringify({ type: 'project-discovery-updated', discovery: job }))
          result = { ...job, state: 'queued', revision: 1 }
          break
        }
        case 'project-discovery-filter': {
          const { key: _key, jobId: _jobId, ...value } = message.args
          updateFilter(value)
          result = job
          break
        }
        case 'project-discovery-results': result = { candidates: visibleCandidates().map((row) => ({ ...row, existingProjectIds: projects.filter((project) => project.path === row.path).map((project) => project.id) })), total: visibleCandidates().length, nextOffset: null }; break
        case 'project-import': {
          const selection = message.args.selection
          const rows = selection === 'filtered' ? visibleCandidates() : candidates.filter((row) => selection === 'recommended' ? row.recommended : selection.includes(row.id))
          for (const row of rows) if (!projects.some((project) => project.path === row.path)) projects.push({ id: row.id, name: row.suggestedName, path: row.path })
          job = { ...job, revision: job.revision + 1, registration: { selected: rows.length, added: rows.length, existing: 0, unavailable: 0, capacity: 200 - projects.length, projectIds: rows.map((row) => row.id) } }
          route.send(JSON.stringify({ type: 'projects-changed' }))
          route.send(JSON.stringify({ type: 'project-discovery-updated', discovery: job }))
          if (options.failFirstImport && !importFailed) {
            importFailed = true
            route.send(JSON.stringify({ type: 'error', id: message.id, code: 'connection_lost', message: 'Response was lost. Retry the saved request.' }))
            return
          }
          result = job
          break
        }
      }
      route.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  await page.goto('/#/chat')
  return { operations, projects, updateFilter, removeProject }
}

test('preview preserves the chat draft and selects nested candidates explicitly', async ({ page }) => {
  const state = await fixture(page)
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Keep this draft')
  await (await openChatSettings(page)).getByRole('button', { name: / Project$/ }).click()
  await page.getByRole('option', { name: 'Discover projects…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Discover projects', exact: true })
  await dialog.getByLabel('Starting directory').fill('/work/projects')
  await dialog.getByRole('button', { name: 'Preview projects', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('Completed')
  await expect(dialog.getByText('Nested package', { exact: false })).toBeVisible()
  expect(state.operations.find((entry) => entry.op === 'project-discovery-start')?.args.mode).toBe('preview')
  expect(state.projects).toHaveLength(0)
  const member = dialog.getByRole('checkbox', { name: 'member', exact: true })
  await member.focus()
  await page.keyboard.press('Space')
  await expect(member).toBeChecked()
  await dialog.getByRole('button', { name: 'Add selected (1)', exact: true }).click()
  await expect(dialog.getByText('Already registered · Cargo.toml', { exact: true })).toBeVisible()
  expect(state.projects.map((project) => project.name)).toEqual(['member'])
  await dialog.getByRole('button', { name: 'Close discovery', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('Keep this draft')
  await (await openChatSettings(page)).getByRole('button', { name: / Project$/ }).click()
  await expect(page.getByRole('option', { name: /^member/ })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('an uncertain import retries with its original operation key', async ({ page }) => {
  const state = await fixture(page, { failFirstImport: true })
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  await page.getByRole('button', { name: 'Discover projects instead', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Discover projects', exact: true })
  await dialog.getByLabel('Starting directory').fill('/work/projects')
  await dialog.getByRole('button', { name: 'Preview projects', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('Completed')
  await dialog.getByRole('button', { name: 'Add recommended projects', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Response was lost')
  await dialog.getByRole('button', { name: 'Add recommended projects', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  const requests = state.operations.filter((entry) => entry.op === 'project-import')
  expect(requests).toHaveLength(2)
  expect(requests[0].args.key).toBe(requests[1].args.key)
  expect(state.projects).toHaveLength(1)
})

test('saved native-tool discovery cards survive reload and work on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page, { savedChat: true })
  await page.goto(`/#/chat/${chatId}`)
  const card = page.getByRole('region', { name: 'Project discoveries', exact: true })
  await expect(card).toContainText('Added 1 project')
  await page.reload()
  await expect(card).toContainText('/work/projects')
  await card.getByRole('button', { name: 'View discovery', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Discover projects', exact: true })
  await expect(dialog).toContainText('Already registered')
  const accessibility = await new AxeBuilder({ page }).include('.project-discovery-modal').analyze()
  expect(accessibility.violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('a chat follow-up filters the same discovery card and persists its roots view after reload', async ({ page }) => {
  const state = await fixture(page, { savedChat: true })
  await page.goto(`/#/chat/${chatId}`)
  const card = page.getByRole('region', { name: 'Project discoveries', exact: true })
  await expect(card.getByRole('article')).toHaveCount(1)
  state.updateFilter({ scope: 'roots', query: '' })
  await expect(card).toContainText('Showing 1 project root · 1 hidden')
  await expect(card.getByRole('list', { name: 'Matching projects' })).toContainText('app')
  await expect(card).not.toContainText('member')
  await expect(card.getByRole('article')).toHaveCount(1)
  await page.reload()
  await expect(card).toContainText('Showing 1 project root · 1 hidden')
  await card.getByRole('button', { name: 'View discovery', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Discover projects', exact: true })
  await expect(dialog.getByRole('checkbox', { name: 'Show project roots only', exact: true })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'member', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(dialog.getByRole('checkbox', { name: 'member', exact: true })).toBeVisible()
  expect(state.operations.filter((entry) => entry.op === 'project-discovery-start')).toHaveLength(0)
  expect(state.operations.filter((entry) => entry.op === 'project-import')).toHaveLength(0)
})

test('native project removal refreshes the registry and candidate status while preserving the same chat card', async ({ page }) => {
  const state = await fixture(page, { savedChat: true })
  await page.goto(`/#/chat/${chatId}`)
  const card = page.getByRole('region', { name: 'Project discoveries', exact: true })
  await card.getByRole('button', { name: 'View discovery', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Discover projects', exact: true })
  const project = dialog.getByRole('checkbox', { name: 'app', exact: true })
  await expect(project).toBeDisabled()
  state.removeProject(rootId)
  await expect(project).toBeEnabled()
  await expect(dialog.getByText('Already registered · package.json', { exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close discovery', exact: true }).click()
  await expect(card.getByRole('article')).toHaveCount(1)
  await expect(page.getByText('Discovery is running in the backend.', { exact: true })).toBeVisible()
  await (await openChatSettings(page)).getByRole('button', { name: / Project$/ }).click()
  await expect(page.getByRole('option', { name: /^app/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(card.getByRole('article')).toHaveCount(1)
  await card.getByRole('button', { name: 'View discovery', exact: true }).click()
  await expect(project).toBeEnabled()
})

test('filters clear hidden selections, combine roots with search, and import only shown projects', async ({ page }) => {
  const state = await fixture(page)
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  await page.getByRole('button', { name: 'Discover projects instead', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Discover projects', exact: true })
  await dialog.getByLabel('Starting directory').fill('/work/projects')
  await dialog.getByRole('button', { name: 'Preview projects', exact: true }).click()
  const member = dialog.getByRole('checkbox', { name: 'member', exact: true })
  await member.focus()
  await page.keyboard.press('Space')
  await expect(dialog.getByRole('button', { name: 'Add selected (1)', exact: true })).toBeEnabled()
  await dialog.getByRole('checkbox', { name: 'Show project roots only', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(member).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Add selected (0)', exact: true })).toBeDisabled()
  await dialog.getByLabel('Filter by name or path').fill('does-not-exist')
  await dialog.getByRole('button', { name: 'Apply filter', exact: true }).click()
  await expect(dialog).toContainText('No projects match these filters.')
  await expect(dialog.getByRole('button', { name: 'Add shown projects', exact: true })).toBeDisabled()
  await dialog.getByLabel('Filter by name or path').fill('APP')
  await dialog.getByRole('button', { name: 'Apply filter', exact: true }).click()
  await expect(dialog).toContainText('Showing 1 project root matching “APP” · 1 hidden')
  await dialog.getByRole('button', { name: 'Add shown projects', exact: true }).click()
  expect(state.projects.map((project) => project.name)).toEqual(['app'])
  expect(state.operations.find((entry) => entry.op === 'project-import')?.args.selection).toBe('filtered')
  await dialog.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(member).toBeVisible()
  const accessibility = await new AxeBuilder({ page }).include('.project-discovery-modal').analyze()
  expect(accessibility.violations).toEqual([])
})
