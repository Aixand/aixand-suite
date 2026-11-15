import { expect, test, type Page, type WebSocketRoute } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { ChatSnapshot } from '../src/chats/model'
import { activeMention } from '../src/chats/inboxReferences'
import { activeFileMention, fileLocation, fileQuery, fileMentions } from '../src/chats/fileReferences'
import { chatMentionLink } from '../src/chats/composerMentions'
import { mockHomeOverview } from './home-helpers'

type Operation = { id: string; op: string; args: Record<string, unknown> }
const existingChatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const projects = [
  { id: 'web-spaced', name: 'Team Web', path: '/workspace/team-web' },
  { id: 'web-hyphenated', name: 'Team-Web', path: '/workspace/other-web' },
]

async function connect(page: Page, { existing = false, carrierUnavailable = false, resources = false, savedChats = [] as ChatSnapshot[], home = false } = {}) {
  if (home) await mockHomeOverview(page)
  const operations: Operation[] = []
  const carrierOperations: Operation[] = []
  const errors: string[] = []
  const catalogProjects = resources ? [...projects, { id: 'review-project', name: 'review', path: '/workspace/review' },
    { id: 'preview-project', name: 'Preview app', path: '/workspace/preview' }] : projects
  let resourceFailure = false
  let holdSkill = false
  let releaseSkill: (() => void) | undefined
  let chatListFailure = false
  let holdChatList = false
  let releaseChatList: (() => void) | undefined
  let agentSocket: WebSocketRoute
  page.on('pageerror', (error) => errors.push(error.message))
  let chat: ChatSnapshot = { id: existingChatId, provider: 'codex', profile: 'review', auth: null,
    cwd: '/workspace', project: '', mode: 'chat', model: 'review-fast', title: 'Existing conversation',
    status: 'idle', createdAt: 1, updatedAt: 1, revision: 1, items: [], requests: [] }
  await page.addInitScript(() => localStorage.setItem('aixand.projectFiles.open', 'false'))
  await page.routeWebSocket('**/api/carrier/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw)) as Operation
      carrierOperations.push(command)
      if (carrierUnavailable && command.op === 'mailboxes') {
        socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Carrier unavailable' }))
        return
      }
      const result = command.op === 'snapshot' ? { status: { connected: !carrierUnavailable, agent_configured: false, providers: [], version: 1 },
        messages: [], counts: {}, total: 0, next_offset: null } : command.op === 'mailboxes' && resources ? [
          { id: 'user', name: 'Main inbox', address: 'suite/local/user', role: 'human' },
        ] : []
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.routeWebSocket('**/api/agents/ws', (socket) => {
    agentSocket = socket
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw)) as Operation
      operations.push(command)
      if (chatListFailure && command.op === 'chat-list') {
        socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Conversations temporarily unavailable' })); return
      }
      if (resourceFailure && ['skills-file', 'prompts-preview', 'prompts-catalog', 'skills-catalog'].includes(command.op)) {
        socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Resource temporarily unavailable' })); return
      }
      if (command.op === 'chat-create') {
        const project = catalogProjects.find((item) => item.id === command.args.projectId)
        chat = { ...chat, id: String(command.args.key), profile: String(command.args.profile ?? 'work'),
          model: command.args.model ? String(command.args.model) : null, mode: project ? 'work' : 'chat',
          project: project?.name ?? '', projectId: project?.id, cwd: project?.path ?? '/workspace' }
      }
      if (command.op === 'chat-send' && savedChats.length) chat = { ...chat, revision: chat.revision + 1,
        items: [...chat.items, { id: command.id, type: 'userMessage', text: String(command.args.text) }] }
      const result = command.op === 'catalog' ? { profiles: [
        { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0 },
        { id: 'codex/review', provider: 'codex', profile: 'review', auth: 'company', active_runs: 0 },
        ...(resources ? [{ id: 'claude/research', provider: 'claude', profile: 'research', auth: 'company', active_runs: 0 }] : []),
      ], auths: [], capabilities: [], cwd: '/workspace' } : command.op === 'project-list' ? catalogProjects :
        command.op === 'models' ? [{ id: `${command.args.profile}-fast`, name: `${command.args.profile} Fast` },
          { id: 'provider/model:fast', name: 'Provider model' }] :
          command.op === 'prompts-catalog' && resources ? { packs: [{ id: 'pack-one', name: 'Team prompts', source: 'Local', kind: 'draft', status: 'available', prompts: [
            { name: 'Quick plan', description: 'Write a plan', inputs: {} },
            { name: 'Personalize', description: 'Plan around a topic', inputs: { topic: { type: 'string' } } },
          ] }] } : command.op === 'prompts-preview' && resources ? { output: [{ role: 'user', content: `A saved plan${command.args.inputs && (command.args.inputs as { topic?: string }).topic ? ` for ${(command.args.inputs as { topic: string }).topic}` : ''}.` }] } :
          command.op === 'skills-catalog' && resources ? { entries: [{ id: 'ship-checker', name: 'Ship checker', source_id: 'local', path: '/skills/ship-checker', status: 'valid' }], releases: [] } :
          command.op === 'skills-show' && resources ? { name: 'Ship checker', path: '/skills/ship-checker' } :
          command.op === 'skills-file' && resources ? { content_b64: Buffer.from('# Ship checker\nCheck the release carefully.').toString('base64') } :
          command.op === 'project-files-list' ? { projectId: command.args.projectId, path: command.args.path ?? '', entries: [
            { name: 'README.md', path: 'README.md', kind: 'file', supported: true },
            { name: 'src', path: 'src', kind: 'directory', supported: true },
          ], nextOffset: null } :
          command.op === 'mcp-catalog' ? { servers: [] } : command.op === 'chat-workflow-runs' ? { runs: [], nextOffset: null } : command.op === 'chat-list' ? [...(existing ? [chat] : []), ...savedChats] :
            ['chat-open', 'chat-create', 'chat-send'].includes(command.op) ? chat : []
      const respond = () => socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
      if (holdSkill && command.op === 'skills-file') releaseSkill = respond
      else if (holdChatList && command.op === 'chat-list') releaseChatList = respond
      else respond()
    })
  })
  await page.goto(home ? '/#/home' : existing ? `/#/chat/${existingChatId}` : '/#/chat')
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await expect(input).toBeVisible()
  await expect.poll(() => operations.some((command) => command.op === 'catalog')).toBe(true)
  return { input, operations, carrierOperations, errors, failResources(value: boolean) { resourceFailure = value },
    holdSkill() { holdSkill = true }, releaseSkill() { releaseSkill?.() },
    failChats(value: boolean) { chatListFailure = value },
    holdChats() { holdChatList = true }, releaseChats() { holdChatList = false; releaseChatList?.() },
    emitChat(chat: ChatSnapshot, type: 'chat-created' | 'chat-updated' = 'chat-updated') { agentSocket.send(JSON.stringify({ type, chat })) } }
}

async function chooseProfile(page: Page, name: string) {
  await page.getByRole('button', { name: / Profile$/ }).click()
  await page.getByRole('option', { name: new RegExp(`^${name} `) }).click()
}

test('selected context shows the project and preserves the draft when changed or cleared', async ({ page }) => {
  const fixture = await connect(page)
  const row = page.getByRole('group', { name: 'Selected context', exact: true })
  const project = row.getByRole('button', { name: / Project$/ })
  await expect(row).toHaveCount(0)
  await fixture.input.fill('Check the selected project')
  await page.getByRole('button', { name: 'Add context and tools', exact: true }).click()
  await page.getByRole('button', { name: 'Select project', exact: true }).click()
  await page.getByRole('option', { name: /^Team Web/ }).click()
  await expect(project).toHaveText('Team Web')
  await expect(fixture.input).toHaveValue(/^Check the selected project\s*$/)
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(async () => {
      const context = await row.boundingBox()
      const input = await fixture.input.boundingBox()
      return Boolean(context && input && context.y >= input.y + input.height && context.x >= 0 && context.x + context.width <= width)
    }).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`selected-context-${width}.png`) })
  }
  await project.click()
  await page.getByRole('option', { name: /^Team-Web/ }).click()
  await expect(project).toHaveText('Team-Web')
  await project.click()
  await page.getByRole('option', { name: /^No project/ }).click()
  await expect(row).toHaveCount(0)
  await expect(fixture.input).toHaveValue(/^Check the selected project\s*$/)
  expect(fixture.operations.some(operation => operation.op === 'chat-create')).toBe(false)
  expect(fixture.errors).toEqual([])
})

test('Home uses project, profile, and model mentions and preserves those choices when opening Chat', async ({ page }) => {
  const f = await connect(page, { home: true })
  await f.input.fill('Investigate @project:team')
  await page.getByRole('option', { name: /^Team Web / }).click()
  await expect(page).toHaveURL(/#\/home$/)
  await f.input.fill('Investigate @profile:review')
  await page.getByRole('option', { name: /^review / }).click()
  await expect(page.getByRole('button', { name: / Profile$/ })).toContainText('review')
  await f.input.fill('Investigate @model:review-fast')
  await page.getByRole('option', { name: /^review Fast/ }).click()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('review Fast')
  expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Chat', exact: true }).click()
  await expect(f.input).toHaveValue('Investigate ')
  await expect(page.getByRole('button', { name: / Profile$/ })).toContainText('review')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('review Fast')
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Home', exact: true }).click()
  await expect(f.input).toHaveValue('Investigate ')
  await f.input.press('Enter')
  await expect.poll(() => f.operations.some(row => row.op === 'chat-send')).toBe(true)
  expect(f.operations.find(row => row.op === 'chat-create')?.args).toMatchObject({ profile: 'review', model: 'review-fast', projectId: 'web-spaced' })
  expect(f.operations.find(row => row.op === 'chat-send')?.args.text).toBe('Investigate')
  expect(f.errors).toEqual([])
})

test('Home expands saved prompts and skills and offers inbox and workflow context in the shared mention picker', async ({ page }) => {
  const f = await connect(page, { home: true, resources: true })
  await f.input.fill('@')
  await expect(page.getByRole('option', { name: /^Inbox / })).toBeVisible()
  await expect(page.getByRole('option', { name: /^Workflow / })).toBeVisible()
  await expect(page.getByRole('option', { name: /^Profile / })).toBeVisible()
  await f.input.fill('Before @quick')
  await page.getByRole('option', { name: /^Prompt · Quick plan / }).click()
  await expect(f.input).toHaveValue('Before A saved plan.\n')
  await f.input.fill('Before A saved plan.\n@skill:ship')
  await page.getByRole('option', { name: /^Ship checker / }).click()
  await expect(f.input).toHaveValue('Before A saved plan.\nUse the Ship checker skill.\nSkill source: /skills/ship-checker\n\n# Ship checker\nCheck the release carefully.\n')
  await expect(page).toHaveURL(/#\/home$/)
  expect(f.operations.some(row => ['chat-create', 'chat-send'].includes(row.op))).toBe(false)
  await f.input.press('Enter')
  await expect.poll(() => f.operations.find(row => row.op === 'chat-send')?.args.text).toContain('A saved plan.')
  expect(f.operations.find(row => row.op === 'chat-send')?.args.text).toContain('# Ship checker')
  expect(f.errors).toEqual([])
})

test('new conversations and project conversations reset explicit profiles and model overrides to Auto', async ({ page }) => {
  const fixture = await connect(page)
  await expect(page.getByRole('button', { name: 'Auto Profile', exact: true })).toBeVisible()
  await chooseProfile(page, 'review')
  await fixture.input.fill('@model:review')
  await page.getByRole('option', { name: /^review Fast/ }).click()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('review Fast')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Auto Profile', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Profile default')
  await chooseProfile(page, 'review')
  await page.getByRole('button', { name: 'Team Web, 0 conversations', exact: true }).click()
  await page.getByRole('button', { name: 'Start conversation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Auto Profile', exact: true })).toBeVisible()
  await fixture.input.fill('Use the automatic profile')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.operations.some((command) => command.op === 'chat-send')).toBe(true)
  const create = fixture.operations.find((command) => command.op === 'chat-create')!.args
  expect(create).toMatchObject({ profile: null, projectId: 'web-spaced', mode: 'work' })
  expect(create).not.toHaveProperty('model')
  expect(fixture.errors).toEqual([])
})

test('project suggestions filter names, preserve surrounding text, and send the chosen project ID', async ({ page }) => {
  const fixture = await connect(page)
  const prefix = 'Review @project:team-web'
  await fixture.input.fill(`${prefix} after lunch`)
  await fixture.input.evaluate((input, caret) => input.setSelectionRange(caret, caret), prefix.length)
  const suggestions = page.getByRole('listbox', { name: 'Project suggestions' })
  await expect(suggestions.getByRole('option')).toHaveCount(2)
  await expect(suggestions).toContainText('/workspace/other-web')
  await fixture.input.press('ArrowDown')
  await fixture.input.press('Tab')
  await expect(fixture.input).toHaveValue('Review  after lunch')
  await expect(fixture.input).toBeFocused()
  await expect(page.locator('.command-composer-options > .command-context-picker--project')).toContainText('Team-Web')
  expect(fixture.operations.some((command) => command.op === 'chat-create')).toBe(false)
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.operations.find((command) => command.op === 'chat-create')?.args.projectId).toBe('web-hyphenated')
  expect(fixture.operations.find((command) => command.op === 'chat-send')?.args.text).toBe('Review  after lunch')
})

test('root shortcuts and profile aliases update the existing pickers and discover models for that profile', async ({ page }) => {
  const fixture = await connect(page)
  await fixture.input.fill('Investigate @pr')
  await expect(page.getByRole('option', { name: /^Project @project:/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /^Profile @profile:/ })).toBeVisible()
  await fixture.input.press('ArrowDown')
  await fixture.input.press('Enter')
  await expect(fixture.input).toHaveValue('Investigate @profile:')
  await page.getByRole('option', { name: /^review / }).click()
  await expect(page.getByRole('button', { name: 'review Profile', exact: true })).toBeVisible()
  await fixture.input.pressSequentially('@model:review')
  await page.getByRole('option', { name: /^review Fast/ }).click()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('review Fast')
  await fixture.input.pressSequentially('@agent:work')
  await fixture.input.press('Enter')
  await expect(page.getByRole('button', { name: 'work Profile', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Profile default')
  await fixture.input.pressSequentially('@model:work')
  await page.getByRole('option', { name: /^work Fast/ }).click()
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.operations.some((command) => command.op === 'chat-send')).toBe(true)
  expect(fixture.operations.find((command) => command.op === 'chat-create')?.args).toMatchObject({ profile: 'work', model: 'work-fast' })
  expect(fixture.operations.find((command) => command.op === 'chat-send')?.args.text).toBe('Investigate')
  expect(fixture.errors).toEqual([])
})

test('local project suggestions work when Carrier is unavailable and Escape keeps the draft', async ({ page }) => {
  const fixture = await connect(page, { carrierUnavailable: true })
  await expect.poll(() => fixture.carrierOperations.filter((command) => command.op === 'mailboxes').length).toBe(1)
  await fixture.input.fill('@')
  await expect(page.getByRole('option', { name: /^Inbox / })).toBeVisible()
  await page.getByRole('option', { name: /^Project / }).click()
  await expect(fixture.input).toHaveValue('@project:')
  await expect(page.getByRole('option', { name: /^Team Web / })).toBeVisible()
  await fixture.input.press('Escape')
  await expect(page.getByRole('listbox', { name: 'Project suggestions' })).toHaveCount(0)
  await expect(fixture.input).toHaveValue('@project:')
  await fixture.input.fill('@project:missing')
  await expect(page.getByRole('status').filter({ hasText: 'No project options match this name.' })).toBeVisible()
  await fixture.input.press('Enter')
  expect(fixture.operations.some((command) => command.op === 'chat-create')).toBe(false)
  expect(fixture.carrierOperations.filter((command) => command.op === 'mailboxes')).toHaveLength(1)
})

test('model selectors preserve slashes and colons within the selected model ID', async ({ page }) => {
  const fixture = await connect(page)
  await chooseProfile(page, 'review')
  await fixture.input.fill('Investigate @model:provider/model:fast')
  await page.getByRole('option', { name: /^Provider model/ }).click()
  await expect(fixture.input).toHaveValue('Investigate ')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Provider model')
  await fixture.input.press('Enter')
  await expect.poll(() => fixture.operations.find((command) => command.op === 'chat-create')?.args.model).toBe('provider/model:fast')
})

test('existing conversations retain their profile and model; changing project starts a new chat on Auto', async ({ page }) => {
  const fixture = await connect(page, { existing: true })
  await expect(page.getByRole('button', { name: 'review Profile', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('review-fast')
  await fixture.input.fill('@')
  await expect(page.getByRole('option', { name: /^Profile / })).toHaveCount(0)
  await expect(page.getByRole('option', { name: /^Model / })).toHaveCount(0)
  await fixture.input.fill('Next task @project:team-web')
  await page.getByRole('option', { name: /^Team Web / }).click()
  await expect(page).toHaveURL(/#\/chat$/)
  await expect(page.getByRole('button', { name: 'Auto Profile', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('Profile default')
  await expect(fixture.input).toHaveValue('Next task ')
})

test.describe('touch setting mentions', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  for (const theme of ['light', 'dark']) test(`mention suggestions are accessible on mobile in ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('aixand.appearance', value), theme)
    const fixture = await connect(page)
    await fixture.input.fill('@')
    await page.getByRole('option', { name: /^Project / }).tap()
    await expect(fixture.input).toBeFocused()
    await expect(page.getByRole('option', { name: /^Team Web / })).toBeVisible()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('option', { name: /^Team Web / }).tap()
    await expect(fixture.input).toBeFocused()
    await expect(page.locator('.command-composer-options > .command-context-picker--project')).toContainText('Team Web')
  })
})

test('setting mentions ignore emails and code while recognizing namespaced model IDs at the caret', () => {
  const namespaces = ['inbox', 'project', 'profile', 'model']
  for (const text of ['Contact hello@project:team-web', '`@profile:work`', '```text\n@project:team-web']) {
    expect(activeMention(text, text.length, namespaces)).toBeNull()
  }
  const text = 'Use @model:provider/model then explain'
  expect(activeMention(text, 25, namespaces)).toEqual({ start: 4, end: 25, token: '@model:provider/model' })
})

test('mention namespaces use colons for selectors and slashes for inbox navigation', () => {
  const namespaces = ['inbox', 'project', 'profile', 'agent', 'model', 'file', 'effort', 'reasoning', 'thinking', 'speed', 'fast', 'mode']
  for (const namespace of namespaces.filter(name => name !== 'inbox')) {
    const token = `@${namespace}:some/value:detail`
    expect(activeMention(token, token.length, namespaces)?.token).toBe(token)
    const navigation = `@${namespace}/some-value`
    expect(activeMention(navigation, navigation.length, namespaces)).toBeNull()
  }
  for (const token of ['@inbox/', '@inbox/main-inbox', '@inbox/main-inbox:something']) {
    expect(activeMention(token, token.length, namespaces)?.token).toBe(token)
  }
  const token = '@inbox:something'
  expect(activeMention(token, token.length, namespaces)).toBeNull()
})

test('bare names search every category, rank names, and apply only the chosen type', async ({ page }) => {
  const f = await connect(page, { resources: true })
  await chooseProfile(page, 'review')
  await f.input.fill('@review')
  const options = page.getByRole('listbox', { name: 'Chat mention suggestions' }).getByRole('option')
  await expect(options.first()).toHaveText(/Project · review/)
  await expect(page.getByRole('option', { name: /^Profile · review / })).toBeVisible()
  await expect(page.getByRole('option', { name: /^Model · review Fast / })).toBeVisible()
  await expect(page.getByRole('option', { name: /^Project · Preview app / })).toBeVisible()
  expect(f.operations.some(command => ['chat-create', 'chat-send', 'project-files-list'].includes(command.op))).toBe(false)
  await page.getByRole('option', { name: /^Model · review Fast / }).click()
  await expect(f.input).toHaveValue('')
  await expect(page.getByRole('button', { name: / Model$/ })).toContainText('review Fast')
  await expect(page.getByRole('button', { name: 'review Profile', exact: true })).toBeVisible()
  await f.input.fill('@')
  await expect(page.getByRole('option', { name: /^Model · review Fast Recent/ })).toBeVisible()
  expect(f.errors).toEqual([])
})

test('universal project search preserves text at the caret and excludes filenames', async ({ page }) => {
  const f = await connect(page, { resources: true })
  const prefix = 'Review @team-web'
  await f.input.fill(`${prefix} after lunch`)
  await f.input.evaluate((input, caret) => input.setSelectionRange(caret, caret), prefix.length)
  await expect(page.getByRole('option', { name: /^Project · Team Web / })).toBeVisible()
  await f.input.press('Tab')
  await expect(f.input).toHaveValue('Review  after lunch')
  await expect(page.locator('.command-composer-options > .command-context-picker--project')).toContainText('Team Web')
  await f.input.fill('@README')
  await expect(page.getByRole('status').filter({ hasText: 'No matches.' })).toBeVisible()
  expect(f.operations.filter(command => command.op === 'project-files-list')).toHaveLength(0)
  await f.input.press('Escape')
  await expect(f.input).toHaveValue('@README')
})

test('bare inbox names navigate to message selection', async ({ page }) => {
  const f = await connect(page, { resources: true })
  await f.input.fill('@main-inbox')
  await page.getByRole('option', { name: /^Inbox · Main inbox / }).click()
  await expect(f.input).toHaveValue('@inbox/user:')
  await expect.poll(() => f.carrierOperations.some(command => command.op === 'message_search')).toBe(true)
})

test('prompt search loads on demand and inserts rendered text at the caret without sending', async ({ page }) => {
  const f = await connect(page, { resources: true })
  expect(f.operations.filter(command => ['prompts-catalog', 'skills-catalog'].includes(command.op))).toHaveLength(0)
  const prefix = 'Before @quick'
  await f.input.fill(`${prefix} after`)
  await f.input.evaluate((input, caret) => input.setSelectionRange(caret, caret), prefix.length)
  await page.getByRole('option', { name: /^Prompt · Quick plan / }).click()
  await expect(f.input).toHaveValue('Before A saved plan.\n after')
  await expect(f.input).toBeFocused()
  expect(f.operations.find(command => command.op === 'prompts-preview')?.args).toEqual({ packId: 'pack-one', prompt: 'Quick plan', inputs: {} })
  expect(f.operations.some(command => ['chat-create', 'chat-send'].includes(command.op))).toBe(false)
  expect(f.errors).toEqual([])
})

test('prompt inputs can be cancelled or edited before inserting', async ({ page }) => {
  const f = await connect(page, { resources: true })
  await f.input.fill('Plan @prompt:personalize')
  await page.getByRole('option', { name: /^Personalize / }).click()
  const dialog = page.getByRole('dialog', { name: 'Insert Personalize' })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(f.input).toHaveValue('Plan @prompt:personalize')
  await expect(f.input).not.toHaveAttribute('readonly')
  await f.input.fill('@prompt:personalize')
  await page.getByRole('option', { name: /^Personalize / }).click()
  await dialog.getByRole('textbox', { name: 'topic' }).fill('launch day')
  await dialog.getByRole('button', { name: 'Insert prompt', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(f.input).toHaveValue('A saved plan for launch day.\n')
  expect(f.errors).toEqual([])
})

test('skill selectors insert instructions and failed reads preserve the draft', async ({ page }) => {
  const f = await connect(page, { resources: true })
  await f.input.fill('Check @ship')
  await expect(page.getByRole('option', { name: /^Skill · Ship checker / })).toBeVisible()
  f.failResources(true)
  await page.getByRole('option', { name: /^Skill · Ship checker / }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Resource temporarily unavailable' })).toBeVisible()
  await expect(f.input).toHaveValue('Check @ship')
  await expect(f.input).not.toHaveAttribute('readonly')
  f.failResources(false)
  await f.input.fill('Check @skill:ship')
  await page.getByRole('option', { name: /^Ship checker / }).click()
  await expect(f.input).toHaveValue('Check Use the Ship checker skill.\nSkill source: /skills/ship-checker\n\n# Ship checker\nCheck the release carefully.\n')
  expect(f.operations.some(command => ['chat-create', 'chat-send'].includes(command.op))).toBe(false)
  expect(f.errors).toEqual([])
})

test('pending skill insertion cannot overwrite a draft after navigation', async ({ page }) => {
  const f = await connect(page, { resources: true })
  f.holdSkill()
  await f.input.fill('Keep @skill:ship')
  await page.getByRole('option', { name: /^Ship checker / }).click()
  await expect(f.input).toHaveAttribute('readonly')
  await expect(page.getByRole('button', { name: 'Start agent', exact: true })).toBeDisabled()
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  f.releaseSkill()
  await page.getByRole('link', { name: 'Chat', exact: true }).click()
  await expect(f.input).toHaveValue('Keep @skill:ship')
  await expect(f.input).not.toHaveAttribute('readonly')
  expect(f.errors).toEqual([])
})

test('starting a new draft cancels pending insertion without locking or overwriting it', async ({ page }) => {
  const f = await connect(page, { resources: true })
  f.holdSkill()
  await f.input.fill('@skill:ship')
  await page.getByRole('option', { name: /^Ship checker / }).click()
  await expect(f.input).toHaveAttribute('readonly')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(f.input).not.toHaveAttribute('readonly')
  await f.input.fill('Keep this fresh draft')
  f.releaseSkill()
  await expect(f.input).toHaveValue('Keep this fresh draft')
  expect(f.errors).toEqual([])
})

test('chat and workflow shortcuts navigate while preserving the current draft', async ({ page }) => {
  const f = await connect(page, { resources: true, existing: true })
  await f.input.fill('Keep these notes @workflow/sequential')
  await page.getByRole('option', { name: /^Sequential hello / }).click()
  await expect(page).toHaveURL(/#\/workflows\/sequential-hello$/)
  await page.getByRole('link', { name: 'Chat', exact: true }).click()
  await f.input.fill('Draft notes @chat/existing')
  await page.getByRole('option', { name: /^Existing conversation / }).click()
  await expect(page).toHaveURL(new RegExp(`#/chat/${existingChatId}$`))
  await expect(f.input).toHaveValue('Keep these notes ')
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await page.getByRole('link', { name: 'Chat', exact: true }).click()
  await expect(f.input).toHaveValue('Draft notes ')
})

function savedChat(id: string, title: string): ChatSnapshot {
  return { id, title, provider: 'codex', profile: 'work', auth: null, cwd: '/workspace', project: '', mode: 'chat',
    status: 'completed', createdAt: 1, updatedAt: 1, revision: 1, items: [], requests: [] }
}

test('opening chat mentions and bare search discovers chats created after the initial list', async ({ page }) => {
  const chats: ChatSnapshot[] = []
  const f = await connect(page, { savedChats: chats })
  await expect.poll(() => f.operations.filter(command => command.op === 'chat-list').length).toBe(1)
  const target = savedChat('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Checkout implementation')
  chats.push(target)
  await f.input.fill('@chat:checkout')
  await page.getByRole('option', { name: /^Checkout implementation/ }).click()
  await expect(f.input).toHaveValue(`[Checkout implementation](#/chat/${target.id}) `)
  chats.push(savedChat('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Payment review'))
  await f.input.fill('@payment')
  await expect(page.getByRole('option', { name: /^Chat · Payment review/ })).toBeVisible()
  expect(f.operations.some(command => ['chat-create', 'chat-send', 'chat-open'].includes(command.op))).toBe(false)
  expect(f.errors).toEqual([])
})

test('reopening chat mentions refreshes names and live title updates reach an open picker', async ({ page }) => {
  const chats = [savedChat('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'New conversation')]
  const f = await connect(page, { savedChats: chats })
  await f.input.fill('@chat:new-conversation')
  await expect(page.getByRole('option', { name: /^New conversation/ })).toBeVisible()
  await f.input.press('Escape')
  chats[0] = { ...chats[0], title: 'Checkout implementation', revision: 2 }
  await f.input.fill('@chat:checkout')
  await expect(page.getByRole('option', { name: /^Checkout implementation/ })).toBeVisible()
  const requests = f.operations.filter(command => command.op === 'chat-list').length
  chats[0] = { ...chats[0], title: 'Checkout verified', revision: 3 }
  f.emitChat(chats[0])
  await expect(page.getByRole('option', { name: /^Checkout verified/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /^Checkout implementation/ })).toHaveCount(0)
  expect(f.operations.filter(command => command.op === 'chat-list')).toHaveLength(requests)
  expect(f.errors).toEqual([])
})

test('typing a bare chat name filters the open picker without refreshing for every character', async ({ page }) => {
  const f = await connect(page, { savedChats: [savedChat('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Checkout implementation')] })
  await expect.poll(() => f.operations.filter(command => command.op === 'chat-list').length).toBe(1)
  await f.input.fill('@')
  await expect.poll(() => f.operations.filter(command => command.op === 'chat-list').length).toBe(2)
  await f.input.pressSequentially('checkout', { delay: 50 })
  await expect(page.getByRole('option', { name: /^Chat · Checkout implementation/ })).toBeVisible()
  expect(f.operations.filter(command => command.op === 'chat-list')).toHaveLength(2)
  expect(f.errors).toEqual([])
})

test('returning to a tab refreshes conversations while chat mentions remain open', async ({ page }) => {
  const chats: ChatSnapshot[] = []
  const f = await connect(page, { savedChats: chats })
  await f.input.fill('@chat:checkout')
  await expect(page.getByRole('status').filter({ hasText: 'No chat options match this name.' })).toBeVisible()
  chats.push(savedChat('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Checkout implementation'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('option', { name: /^Checkout implementation/ })).toBeVisible()
  expect(f.errors).toEqual([])
})

test('a pending mention refresh is shared and preserves chats announced during the request', async ({ page }) => {
  const f = await connect(page)
  await expect.poll(() => f.operations.filter(command => command.op === 'chat-list').length).toBe(1)
  f.holdChats()
  await f.input.fill('@')
  await expect.poll(() => f.operations.filter(command => command.op === 'chat-list').length).toBe(2)
  await page.getByRole('option', { name: /^Chat @chat:/ }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Loading chat options' })).toBeVisible()
  f.emitChat(savedChat('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Checkout implementation'), 'chat-created')
  f.releaseChats()
  await expect(page.getByRole('option', { name: /^Checkout implementation/ })).toBeVisible()
  expect(f.operations.filter(command => command.op === 'chat-list')).toHaveLength(2)
  expect(f.errors).toEqual([])
})

test('chat mention refresh failures retain saved choices and can be retried', async ({ page }) => {
  const chats = [savedChat('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Checkout implementation')]
  const f = await connect(page, { savedChats: chats })
  await expect.poll(() => f.operations.filter(command => command.op === 'chat-list').length).toBe(1)
  f.failChats(true)
  await f.input.fill('@chat:')
  await expect(page.getByRole('status').filter({ hasText: 'Chat: Conversations temporarily unavailable' })).toBeVisible()
  await expect(page.getByRole('option', { name: /^Checkout implementation/ })).toBeVisible()
  chats.push(savedChat('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Payment review'))
  f.failChats(false)
  await page.getByRole('button', { name: 'Retry chat list', exact: true }).click()
  await expect(page.getByRole('option', { name: /^Payment review/ })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Chat: Conversations temporarily unavailable' })).toHaveCount(0)
  expect(f.errors).toEqual([])
})

test('chat mentions insert named links at the caret without navigating or reading the target', async ({ page }) => {
  const target = savedChat('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Checkout implementation')
  const f = await connect(page, { savedChats: [target] })
  const prefix = 'Supervise @chat:checkout'
  await f.input.fill(prefix + ' until it is verified')
  await f.input.evaluate((input, caret) => input.setSelectionRange(caret, caret), prefix.length)
  // Replace just the mention while preserving the rest of the draft.
  await page.getByRole('listbox', { name: 'Chat suggestions', exact: true }).getByRole('option', { name: /^Checkout implementation/ }).click()
  const linked = `Supervise [Checkout implementation](#/chat/${target.id}) until it is verified`
  await expect(f.input).toHaveValue(linked)
  await expect(f.input).toBeFocused()
  await expect(page).toHaveURL(/#\/chat$/)
  expect(f.operations.some(command => ['chat-open', 'chat-create', 'chat-send', 'read_chat'].includes(command.op))).toBe(false)
  await f.input.press('Enter')
  await expect.poll(() => f.operations.find(command => command.op === 'chat-send')?.args.text).toBe(linked)
  await expect(page.getByRole('log', { name: 'Conversation messages' }).getByRole('link', { name: 'Checkout implementation', exact: true }))
    .toHaveAttribute('href', `#/chat/${target.id}`)
  expect(f.errors).toEqual([])
})

test('chat link choices distinguish duplicate names and are available independently of history filters', async ({ page }) => {
  const first = savedChat('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Checkout')
  const second = savedChat('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Checkout')
  const f = await connect(page, { savedChats: [first, second] })
  await page.getByRole('button', { name: 'Show supervising chats', exact: true }).click()
  await f.input.fill('Watch @chat:checkout')
  const options = page.getByRole('listbox', { name: 'Chat suggestions', exact: true }).getByRole('option')
  await expect(options).toHaveCount(2)
  await options.filter({ hasText: 'bbbbbbbb' }).click()
  await expect(f.input).toHaveValue(`Watch [Checkout](#/chat/${second.id}) `)
  expect(f.operations.some(command => ['chat-create', 'chat-send'].includes(command.op))).toBe(false)
})

test('chat names remain literal and do not trigger other reference expansion', async ({ page }) => {
  const target = savedChat('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Checkout [draft] @file:README.md & `notes')
  const f = await connect(page, { savedChats: [target] })
  await f.input.fill('Watch @chat:checkout')
  await page.getByRole('option', { name: /^Checkout \[draft\] @file:README.md/ }).click()
  await expect(f.input).toHaveValue(`Watch [Checkout \\[draft\\] \\@file:README.md &amp; &#96;notes](#/chat/${target.id}) `)
  await f.input.press('Enter')
  await expect.poll(() => f.operations.some(command => command.op === 'chat-send')).toBe(true)
  expect(f.operations.some(command => command.op === 'project-file-read')).toBe(false)
  expect(f.carrierOperations.some(command => command.op === 'message_get')).toBe(false)
  await expect(page.getByRole('log', { name: 'Conversation messages' }).getByRole('link', { name: target.title, exact: true })).toHaveAttribute('href', `#/chat/${target.id}`)
  expect(f.errors).toEqual([])
})

test('the Chat category and bare chat names insert links while slash navigation stays separate', async ({ page }) => {
  const target = savedChat('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Checkout implementation')
  const f = await connect(page, { savedChats: [target] })
  await f.input.fill('@')
  await page.getByRole('option', { name: /^Chat @chat:/ }).click()
  await expect(f.input).toHaveValue('@chat:')
  await page.getByRole('option', { name: /^Checkout implementation/ }).click()
  await expect(f.input).toHaveValue(`[Checkout implementation](#/chat/${target.id}) `)
  await f.input.fill('Supervise @checkout')
  await page.getByRole('option', { name: /^Chat · Checkout implementation/ }).click()
  await expect(f.input).toHaveValue(`Supervise [Checkout implementation](#/chat/${target.id}) `)
  await expect(page).toHaveURL(/#\/chat$/)
})

test('Markdown in chat titles cannot swallow a following file reference', () => {
  const link = chatMentionLink('Fix `markup and @file:private', existingChatId)
  expect(fileMentions(link + ' @file:README.md').map(mention => mention.token)).toEqual(['@file:README.md'])
})

test('resource catalog failures do not block local universal search', async ({ page }) => {
  const f = await connect(page, { resources: true })
  f.failResources(true)
  await f.input.fill('@team-web')
  await expect(page.getByRole('status').filter({ hasText: 'Prompt: Resource temporarily unavailable' })).toBeVisible()
  await page.getByRole('option', { name: /^Project · Team Web / }).click()
  await expect(page.locator('.command-composer-options > .command-context-picker--project')).toContainText('Team Web')
  f.failResources(false)
  await f.input.fill('@prompt:quick')
  await page.getByRole('button', { name: 'Retry prompt list', exact: true }).click()
  await expect.poll(() => f.operations.filter(command => command.op === 'prompts-catalog').length).toBe(2)
  await expect(f.input).toBeFocused()
  await page.getByRole('option', { name: /^Quick plan / }).click()
  await expect(f.input).toHaveValue('A saved plan.\n')
  expect(f.errors).toEqual([])
})

test('relative file shorthand opens only file search and generates ordinary references', async ({ page }) => {
  const f = await connect(page, { resources: true })
  await f.input.fill('@team-web')
  await page.getByRole('option', { name: /^Project · Team Web / }).click()
  for (const token of ['@.', '@./', '@./src/../']) {
    await f.input.fill(token)
    await expect(page.getByRole('listbox', { name: 'Choose a file suggestions' })).toBeVisible()
    await expect(page.getByRole('option', { name: /^README.md / })).toBeVisible()
  }
  await f.input.press('Enter')
  await expect(f.input).toHaveValue('@file:README.md ')
  const row = page.getByRole('group', { name: 'Selected context', exact: true })
  await row.getByRole('button', { name: '1 reference', exact: true }).click()
  const references = page.getByRole('dialog', { name: 'References', exact: true })
  await expect(references.getByRole('group', { name: 'Project file references' })).toBeVisible()
  await references.getByRole('button', { name: 'Remove file: README.md', exact: true }).click()
  await expect(row.getByRole('button', { name: '1 reference', exact: true })).toHaveCount(0)
  await expect(row.getByRole('button', { name: / Project$/ })).toHaveText('Team Web')
  await expect(f.input).not.toHaveValue(/@file:/)
  const requests = f.operations.filter(command => command.op === 'project-files-list').length
  await f.input.fill('@../')
  await expect(page.getByRole('status').filter({ hasText: 'outside the selected project' })).toBeVisible()
  expect(f.operations.filter(command => command.op === 'project-files-list')).toHaveLength(requests)
  expect(f.errors).toEqual([])
})

test('relative file parsing skips emails and code, and normalizes paths inside the project', () => {
  for (const token of ['@.', '@./src/', '@../']) {
    expect(activeFileMention(token, token.length)?.token).toBe(token)
  }
  expect(fileMentions('mail@example.com `@./README.md`\n```text\n@../')).toEqual([])
  expect(fileQuery('@./src/../README.md')).toBe('./src/../README.md')
  expect(fileLocation('./src/../README.md')).toEqual({ directory: '', search: 'readme.md', error: '' })
  expect(fileLocation('../').error).toContain('outside')
  expect(fileLocation('/etc/passwd').error).toBeTruthy()
})

test('universal profile search finds profiles belonging to another provider', async ({ page }) => {
  const f = await connect(page, { resources: true })
  await f.input.fill('Investigate @research')
  await page.getByRole('option', { name: /^Profile · research / }).click()
  await expect(f.input).toHaveValue('Investigate ')
  await expect(page.getByRole('button', { name: 'research Profile', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Claude Provider', exact: true })).toBeVisible()
  expect(f.operations.some(command => command.op === 'chat-create')).toBe(false)
})

test.describe('touch universal mentions', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })
  test('typed results remain accessible and touch selection retains focus', async ({ page }) => {
    const f = await connect(page, { resources: true })
    await f.input.fill('@team-web')
    const choice = page.getByRole('option', { name: /^Project · Team Web / })
    await expect(choice).toBeVisible()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await choice.tap()
    await expect(f.input).toBeFocused()
    await expect(page.locator('.command-composer-options > .command-context-picker--project')).toContainText('Team Web')
  })
})
