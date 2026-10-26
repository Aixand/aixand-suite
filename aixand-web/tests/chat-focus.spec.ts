import { test, expect, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'

const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

async function workspace(page: Page, active = true, extraProjects = 0) {
  const project = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Studio', path: '/work/studio' }
  const chat = { id: chatId, projectId: project.id, project: project.name, cwd: project.path,
    provider: 'codex', profile: 'work', auth: null, mode: 'work', title: 'Improve the workspace', status: 'completed',
    createdAt: 2, updatedAt: 2, revision: 1, requests: [], queue: { paused: false, messages: [] },
    items: [{ id: 'user', type: 'userMessage', text: 'Make the workspace easier to use.' },
      { id: 'reply', type: 'agentMessage', text: 'The conversation stays at the center.\n\nKeep useful context readable and put supporting tools within reach.' }] }
  const service = { connected: true, syncing: false, error: null, last_sync: 1, instance: 'focus-test',
    outgoing_history: true, agent_configured: false, providers: [], version: 1 }
  await page.routeWebSocket('**/api/carrier/ws', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      socket.send(JSON.stringify({ type: 'result', id: command.id,
        result: command.op === 'snapshot' ? { status: service, counts: {}, messages: [], total: 0, next_offset: null } : command.op === 'status' ? service : [] }))
    })
  })
  await page.routeWebSocket('**/api/agents/ws', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      const results: Record<string, unknown> = {
        catalog: { profiles: [{ id: 'codex/work', provider: 'codex', profile: 'work', auth: null, active_runs: 0 }],
          auths: [], capabilities: [{ provider: 'codex', installed: true }], cwd: project.path },
        sessions: { runs: [], runtimeError: null }, 'agent-operations': { operations: [] },
        'project-list': [project, ...Array.from({ length: extraProjects }, (_, index) => ({ id: `project-${index}`, name: `Project ${String(index + 1).padStart(3, '0')}`, path: `/work/project-${index}` }))], 'project-discovery-list': { jobs: [], nextOffset: null },
        'chat-list': [chat], 'chat-open': chat, 'chat-workflow-runs': { runs: [], nextOffset: null },
        'mcp-catalog': { servers: [] }, 'mcp-preview': { selection: {}, states: [] },
        'project-files-list': { projectId: project.id, path: '', entries: [], total: 0, nextOffset: null, limited: false },
      }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result: results[command.op] ?? [] }))
    })
  })
  await page.goto(active ? `/#/chat/${chatId}` : '/#/chat')
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toBeVisible()
  if (active) await expect(page.getByRole('heading', { name: chat.title, exact: true })).toBeVisible()
}

test('the full-height sidebar collapses without losing a draft, remembers the choice, and reaches other suite sections', async ({ page }) => {
  await workspace(page)
  const sidebar = page.getByRole('complementary', { name: 'Chat history sidebar', exact: true })
  const bounds = (await sidebar.boundingBox())!
  expect(bounds.y).toBe(0)
  expect(bounds.height).toBe(1000)
  await expect(page.locator('.topbar')).toHaveCount(0)
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation', exact: true })
  await expect(navigation.getByRole('link', { name: 'Chat', exact: true })).toHaveAttribute('aria-current', 'page')
  const rail = (await page.locator('.navigation-rail').boundingBox())!
  expect(bounds.x).toBe(rail.width)
  expect(rail.y).toBe(0)
  expect(rail.height).toBe(bounds.height)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep this draft while I focus')
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect(sidebar).toBeHidden()
  await expect(navigation.getByRole('link', { name: 'Home', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeFocused()
  await expect(input).toHaveValue('Keep this draft while I focus')
  await page.reload()
  await expect(sidebar).toBeHidden()
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).press('Enter')
  await expect(sidebar).toBeVisible()
  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page).toHaveURL(/#\/home$/)
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
})

test('project browsing leaves a draft in place and files open only when requested', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aixand.projectFiles.open', 'true'))
  await workspace(page, false)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('A thought I am still writing')
  const project = page.getByRole('button', { name: 'Studio, 1 conversation', exact: true })
  await project.click()
  await expect(project).toHaveAttribute('aria-expanded', 'true')
  await expect(input).toHaveValue('A thought I am still writing')
  await expect(page).toHaveURL(/#\/chat$/)
  await page.getByRole('region', { name: 'Studio conversations', exact: true }).getByRole('button', { name: /^Improve the workspace/ }).click()
  await expect(page.getByRole('complementary', { name: 'Project files sidebar' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Show project files', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Project files', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Project files', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('region', { name: 'Project files', exact: true })).toBeVisible()
})

test('theme and the account menu stay in the main rail across both themes', async ({ page }) => {
  await page.addInitScript(() => { if (!localStorage.getItem('aixand.appearance')) localStorage.setItem('aixand.appearance', 'light') })
  await workspace(page)
  const rail = page.getByRole('complementary', { name: 'Workspace sidebar', exact: true })
  const toggle = rail.getByRole('button', { name: /^Color mode:/ })
  const account = rail.getByRole('button', { name: 'Profile menu', exact: true })
  expect((await toggle.boundingBox())!.y).toBeLessThan((await account.boundingBox())!.y)
  await expect(account).toHaveText('')
  await expect(page.locator('.chat-sidebar-footer, .topbar-profile')).toHaveCount(0)
  for (const theme of ['light', 'dark']) {
    if (await page.locator('.aixand-app').getAttribute('data-bbb-mode') !== theme) {
      await toggle.focus()
      await toggle.press('Enter')
      await expect(toggle).toBeFocused()
    }
    await expect(page.locator('.aixand-app')).toHaveAttribute('data-bbb-mode', theme)
    const profile = page.getByRole('button', { name: / Profile$/ })
    await expect(profile).toBeDisabled()
    await expect(profile).toHaveCSS('opacity', '1')
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: `artifacts/chat-focus/${theme}-conversation.png` })
    await page.getByRole('button', { name: 'New chat', exact: true }).click()
    await page.screenshot({ path: `artifacts/chat-focus/${theme}-welcome.png` })
    await page.getByRole('region', { name: 'Recent conversations', exact: true }).getByRole('button', { name: /^Improve the workspace/ }).click()
    await account.press('Enter')
    const menu = page.getByRole('menu', { name: 'Profile menu', exact: true })
    await expect(menu.getByRole('menuitem')).toHaveText(['Settings', 'Recover a chat', 'Onboarding', 'Sign out'])
    await expect(menu.getByRole('button', { name: /Appearance/ })).toHaveCount(0)
    const accountAccessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(accountAccessibility.violations).toEqual([])
    await page.keyboard.press('Escape')
    await expect(account).toBeFocused()
  }
  await page.reload()
  await expect(page.locator('.aixand-app')).toHaveAttribute('data-bbb-mode', 'dark')
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect(toggle).toBeVisible()
  await expect(account).toBeVisible()
  await account.press('Enter')
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).press('Enter')
  await expect(page).toHaveURL(/#\/settings$/)
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeFocused()
  await expect(account).toBeVisible()
})

test('the main rail account action signs out through the authenticated session', async ({ page }) => {
  let signedOut = 0
  await page.route('**/api/auth/logout', route => {
    expect(route.request().method()).toBe('POST')
    signedOut++
    return route.fulfill({ json: {} })
  })
  await workspace(page)
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in to your Suite', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)
  expect(signedOut).toBe(1)
})

for (const width of [320, 390]) {
  test(`mobile navigation returns focus and preserves access at ${width}px with enlarged text`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' })
    await workspace(page, false)
    await page.screenshot({ path: `artifacts/chat-focus/${width}-mobile.png` })
    const trigger = page.getByRole('button', { name: 'Show chat history', exact: true })
    await trigger.click()
    await expect(page.getByRole('dialog', { name: 'Chat history', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Studio, 1 conversation', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Studio conversations', exact: true })).toBeVisible()
    await page.screenshot({ path: `artifacts/chat-focus/${width}-sidebar.png` })
    await page.getByRole('button', { name: 'Search projects', exact: true }).click()
    const search = page.getByRole('searchbox', { name: 'Search projects', exact: true })
    await expect(search).toBeFocused()
    await search.fill('studio')
    await search.press('Escape')
    await expect(search).toHaveValue('')
    await search.press('Escape')
    await expect(page.getByRole('button', { name: 'Search projects', exact: true })).toBeFocused()
    await page.getByRole('dialog', { name: 'Chat history', exact: true }).getByRole('button', { name: 'Close sheet', exact: true }).press('Enter')
    await expect(trigger).toBeFocused()
    await expect(page.getByRole('button', { name: / Provider$/ })).toBeVisible()
    await expect(page.getByRole('button', { name: / Model$/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
    await input.scrollIntoViewIfNeeded()
    await input.fill('A readable mobile draft')
    await expect(input).toHaveValue('A readable mobile draft')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `artifacts/chat-focus/${width}-enlarged-text.png` })
    await trigger.click()
    await expect(page.getByRole('dialog', { name: 'Chat history', exact: true }).getByRole('button', { name: 'Profile menu', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    const account = page.getByRole('complementary', { name: 'Workspace sidebar', exact: true }).getByRole('button', { name: 'Profile menu', exact: true })
    await expect(account).toBeInViewport()
    await expect(page.getByRole('button', { name: /^Color mode:/ })).toBeInViewport()
    await account.press('Enter')
    await expect(page.getByRole('menuitem')).toHaveText(['Settings', 'Recover a chat', 'Onboarding', 'Sign out'])
    const menuBounds = (await page.getByRole('menu', { name: 'Profile menu', exact: true }).boundingBox())!
    expect(menuBounds.x).toBeGreaterThanOrEqual(0)
    expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(width)
    await expect(page.locator('.navigation-account-menu')).toHaveCSS('opacity', '1')
    await page.screenshot({ path: `artifacts/chat-focus/${width}-account-enlarged.png` })
    await page.keyboard.press('Escape')
    await expect(account).toBeFocused()
  })
}


test('many projects stay in a five-row scroll area with icon-triggered keyboard search', async ({ page }) => {
  await workspace(page, false, 120)
  const folders = page.getByRole('list', { name: 'Project folders', exact: true })
  const rows = folders.getByRole('button', { name: /, \d+ conversations?$/ })
  await expect(rows).toHaveCount(121)
  const listBounds = (await folders.boundingBox())!
  const rowHeight = (await rows.first().boundingBox())!.height
  expect(listBounds.height).toBeLessThanOrEqual(rowHeight * 5 + 1)
  const visible = await rows.evaluateAll((buttons, bounds) => buttons.filter(button => {
    const rect = button.getBoundingClientRect()
    return rect.top >= bounds.y && rect.bottom <= bounds.y + bounds.height
  }).length, listBounds)
  expect(visible).toBe(5)
  const recent = page.getByRole('region', { name: 'Recent conversations', exact: true })
  await expect(recent).toBeVisible()
  await expect(page.getByRole('searchbox', { name: 'Search projects', exact: true })).toHaveCount(0)
  await folders.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(rows.last()).toBeInViewport()
  await expect(recent).toBeInViewport()
  await page.screenshot({ path: 'artifacts/chat-focus/many-projects.png' })
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Keep this draft during project search')
  await page.getByRole('button', { name: 'Search projects', exact: true }).click()
  const search = page.getByRole('searchbox', { name: 'Search projects', exact: true })
  await expect(search).toBeFocused()
  await search.fill('studio')
  await expect(rows).toHaveCount(1)
  await rows.first().click()
  await expect(page.getByRole('region', { name: 'Studio conversations', exact: true })).toBeVisible()
  await expect(input).toHaveValue('Keep this draft during project search')
  await search.fill('missing project')
  await expect(page.getByRole('status').filter({ hasText: 'No matching projects.' })).toBeVisible()
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await search.press('Escape')
  await expect(search).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Search projects', exact: true })).toBeFocused()
})
