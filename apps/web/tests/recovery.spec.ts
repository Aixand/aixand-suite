import { openComposerNotices, expect, test } from './fixtures'
import type { Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'

const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const session = { id: chatId, title: 'Fix checkout login', provider: 'codex', profile: 'work', project: 'Store', cwd: '/workspace/store',
  updatedAt: 1792080000000, availability: 'unchecked', source: 'suite', terminal: null }
const catalog = { sessions: [session], total: 1, nextCursor: null, profiles: ['work'], projects: ['Store'], partial: false, errors: [] }

async function mockRecovery(page: Page) {
  const launches: Record<string, unknown>[] = []
  const searches: string[] = []
  let queued = false
  let released = false
  function status() {
    return { chatId, supported: true, availability: queued ? 'checking' : 'ready', conversation: session,
      terminal: queued || released ? { key: launches.at(-1)?.key, status: queued ? 'queued' : 'released', runId: 'terminal-run', sessionId: null, url: null } : null }
  }
  await page.route('**/api/recovery/sessions?*', route => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? ''
    searches.push(query)
    return route.fulfill({ json: { ...catalog, sessions: !query || session.title.toLowerCase().includes(query.toLowerCase()) ? [session] : [] } })
  })
  await page.route(`**/api/chats/${chatId}/terminal`, route => {
    if (route.request().method() === 'POST') {
      launches.push(route.request().postDataJSON())
      queued = true
      released = false
      expect(route.request().headers()['x-csrf-token']).toBe('isolated-ui-csrf')
    }
    return route.fulfill({ json: status() })
  })
  await page.route(`**/api/chats/${chatId}/terminal/release`, route => {
    queued = false
    released = true
    return route.fulfill({ json: status() })
  })
  return { launches, searches }
}

test('standalone recovery lists and searches recent conversations in a fresh browser without starting the agent connection', async ({ page }, testInfo) => {
  const fixture = await mockRecovery(page)
  const agentConnections: string[] = []
  await page.routeWebSocket('**/api/agents/ws', route => { agentConnections.push(route.url()); route.close() })
  await page.goto('/recovery.html')
  await expect(page.getByRole('heading', { name: 'Recent conversations' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Fix checkout login/ })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('recovery-desktop.png'), fullPage: true })
  await page.getByRole('searchbox', { name: 'Search conversations' }).fill('absent')
  await expect(page.getByText('No matching conversations.', { exact: true })).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search conversations' }).fill('checkout')
  await expect(page.getByRole('button', { name: /Fix checkout login/ })).toBeVisible()
  expect(fixture.searches).toContain('checkout')
  expect(agentConnections).toEqual([])
  expect(fixture.launches).toEqual([])
})

test('a selected chat can launch from recovery without a chat snapshot and sends only a mutation key', async ({ page }) => {
  const fixture = await mockRecovery(page)
  await page.goto(`/recovery.html?chat=${chatId}`)
  await expect(page.getByRole('button', { name: 'Open in terminal', exact: true })).toBeEnabled()
  expect(fixture.launches).toHaveLength(0)
  await page.getByRole('button', { name: 'Open in terminal', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancel terminal request' })).toBeVisible()
  expect(fixture.launches).toHaveLength(1)
  expect(Object.keys(fixture.launches[0])).toEqual(['key'])
  expect(fixture.launches[0].key).toMatch(/^[a-f0-9-]{36}$/)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Cancel terminal request' })).toBeVisible()
  expect(fixture.launches).toHaveLength(1)
})

test('catalog errors are displayed as unavailable rather than empty history', async ({ page }) => {
  await page.route('**/api/recovery/sessions?*', route => route.fulfill({ status: 503, json: { message: 'Storage is temporarily unavailable.' } }))
  await page.goto('/recovery.html')
  await expect(page.getByRole('alert')).toContainText('Session list unavailable')
  await expect(page.getByText('No saved conversations were found in this view.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Retry session list' })).toBeVisible()
})

test('cancelling a queued terminal allows a new explicit launch with a fresh operation key', async ({ page }) => {
  const fixture = await mockRecovery(page)
  await page.goto(`/recovery.html?chat=${chatId}`)
  await page.getByRole('button', { name: 'Open in terminal', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel terminal request' }).click()
  await expect(page.getByRole('button', { name: 'Open in terminal', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Open in terminal', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Cancel terminal request' })).toBeVisible()
  expect(fixture.launches).toHaveLength(2)
  expect(fixture.launches[1].key).not.toBe(fixture.launches[0].key)
})

test('recovery can be opened manually from a healthy workspace without launching a terminal', async ({ page }) => {
  const fixture = await mockRecovery(page)
  await page.routeWebSocket('**/api/agents/ws', route => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/carrier/ws', route => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.goto('/#/home')
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Recover a chat' }).click()
  await expect(page.getByRole('dialog', { name: 'Recover a chat' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Fix checkout login/ })).toBeVisible()
  expect(fixture.launches).toHaveLength(0)
  await page.getByRole('button', { name: /Fix checkout login/ }).click()
  await page.getByRole('link', { name: 'Retry opening this chat' }).click()
  await expect(page).toHaveURL(new RegExp(`/#/chat/${chatId}$`))
  await expect(page.getByRole('dialog', { name: 'Recover a chat' })).toHaveCount(0)
})

for (const mode of ['light', 'dark'] as const) test(`recovery modal is focused, readable, and responsive in ${mode} appearance`, async ({ page }, testInfo) => {
  const fixture = await mockRecovery(page)
  await page.emulateMedia({ colorScheme: mode === 'light' ? 'dark' : 'light' })
  await page.addInitScript(value => localStorage.setItem('aixand.appearance', value), mode)
  const sessions = Array.from({ length: 18 }, (_, index) => ({ ...session,
    id: index ? `recovery-${index}` : chatId,
    title: index ? `Conversation ${index}: investigate checkout and payment processing` : session.title,
    project: index ? '/workspace/projects/checkout-service/long-project-name' : session.project,
  }))
  await page.route('**/api/recovery/sessions?*', route => route.fulfill({ json: { ...catalog, total: sessions.length, sessions } }))
  await page.routeWebSocket('**/api/agents/ws', route => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/carrier/ws', route => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.goto('/#/home')
  await page.getByRole('button', { name: 'Profile menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Recover a chat' }).click()
  const dialog = page.getByRole('dialog', { name: 'Recover a chat' })
  const search = dialog.getByRole('searchbox', { name: 'Search conversations' })
  await expect(search).toBeFocused()
  await expect(page.locator('.bbb-modal-overlay:has(.recovery-dialog)')).toHaveAttribute('data-bbb-mode', mode)
  await expect(dialog.getByRole('button', { name: /Fix checkout login/ })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /All profiles/ })).toHaveCount(0)
  expect(await dialog.locator('.recovery-session-list').evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
  await dialog.getByRole('button', { name: /Fix checkout login/ }).click()
  await expect(dialog.getByRole('button', { name: 'Open in terminal', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: /Fix checkout login/ })).toHaveAttribute('aria-pressed', 'true')
  const bounds = (await dialog.boundingBox())!
  expect(bounds.width).toBeGreaterThan(600)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280)
  await page.screenshot({ path: testInfo.outputPath(`recovery-modal-${mode}.png`) })
  expect((await new AxeBuilder({ page }).include('.recovery-dialog').analyze()).violations).toEqual([])

  await search.fill('checkout')
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Filter conversations', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Filter conversations', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await dialog.getByRole('button', { name: /All profiles/ }).click()
  const filtering = page.waitForRequest(request => request.url().includes('/api/recovery/sessions?') && new URL(request.url()).searchParams.get('profile') === 'work')
  await page.getByRole('option', { name: 'work', exact: true }).click()
  await filtering
  await dialog.getByRole('button', { name: 'Clear filters' }).click()

  await page.setViewportSize({ width: 390, height: 900 })
  await page.screenshot({ path: testInfo.outputPath(`recovery-modal-${mode}-390.png`) })

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await expect(search).toBeVisible()
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const action = dialog.getByRole('button', { name: 'Open in terminal', exact: true })
    await action.scrollIntoViewIfNeeded()
    await action.click({ trial: true })
    expect((await action.boundingBox())!.height).toBeLessThan(160)
    await page.screenshot({ path: testInfo.outputPath(`recovery-modal-${mode}-${width}-large-text.png`) })
    expect((await new AxeBuilder({ page }).include('.recovery-dialog').analyze()).violations).toEqual([])
  }
  await dialog.getByRole('button', { name: 'Close recovery', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Profile menu', exact: true })).toBeFocused()
  expect(fixture.launches).toHaveLength(0)
})

test('saved provider history remains browseable without enabling an unverified terminal launch', async ({ page }) => {
  const fixture = await mockRecovery(page)
  await page.route('**/api/recovery/sessions?*history=true*', route => route.fulfill({ json: { ...catalog,
    sessions: [{ ...session, id: 'saved-example', availability: 'saved', source: 'provider' }] } }))
  await page.goto('/recovery.html')
  await page.getByRole('button', { name: 'Find saved provider history' }).click()
  await expect(page.getByRole('heading', { name: 'Saved provider sessions' })).toBeVisible()
  await page.getByRole('button', { name: /Fix checkout login/ }).click()
  await expect(page.getByText('This saved history has no verified original live process for terminal attachment.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open in terminal', exact: true })).toBeDisabled()
  expect(fixture.launches).toHaveLength(0)
})

test('slow chat loading offers recovery without automatically opening it', async ({ page }) => {
  const fixture = await mockRecovery(page)
  let chatOpenRequests = 0
  await page.clock.install()
  await page.routeWebSocket('**/api/carrier/ws', route => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', route => {
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage(raw => {
      const command = JSON.parse(String(raw))
      if (command.op === 'chat-open') { chatOpenRequests++; return }
      const result = command.op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: '/workspace' } :
        command.op === 'chat-list' ? [{ ...session, mode: 'chat', status: 'completed', revision: 1, createdAt: 1 }] :
        command.op === 'sessions' ? { runs: [], runtimeError: null } :
        command.op === 'project-discovery-list' || command.op === 'chat-workflow-runs' ? { jobs: [], runs: [], nextOffset: null } : []
      route.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto(`/#/chat/${chatId}`)
  await expect.poll(() => chatOpenRequests).toBeGreaterThan(0)
  await expect(page.getByText('Opening your conversation…', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open in terminal', exact: true })).toHaveCount(0)
  await page.clock.runFor(16000)
  await openComposerNotices(page)
  await expect(page.getByRole('group', { name: 'Chat connection' })).toContainText('Reconnecting…')
  await expect(page.getByRole('dialog', { name: 'Recover a chat' })).toHaveCount(0)
  expect(fixture.launches).toHaveLength(0)
})

test('the independent recovery page works when the main application module cannot load', async ({ page }) => {
  await mockRecovery(page)
  let mainModuleRequests = 0
  await page.route('**/src/App.tsx*', route => { mainModuleRequests++; return route.abort() })
  await page.goto('/')
  await expect(page.locator('#boot-recovery')).toBeVisible()
  await page.locator('#boot-recovery').getByRole('link', { name: 'Recover a chat' }).click()
  await expect(page.getByRole('button', { name: /Fix checkout login/ })).toBeVisible()
  expect(mainModuleRequests).toBeGreaterThan(0)
})

test('a chat render crash opens recovery outside the failed workspace', async ({ page }) => {
  await mockRecovery(page)
  await page.route('**/src/workspace/ChatPage.tsx*', route => route.fulfill({ contentType: 'application/javascript',
    body: 'export function HomeChatComposer() { return null } export function ChatPage() { throw new Error("Isolated chat renderer failure") }' }))
  await page.routeWebSocket('**/api/agents/ws', route => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/carrier/ws', route => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.goto(`/#/chat/${chatId}`)
  await expect(page.getByRole('dialog', { name: 'Recover a chat' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Fix checkout login/ })).toBeVisible()
})

test('repeated transport failures offer recovery after three retries without opening a dialog', async ({ page }) => {
  const fixture = await mockRecovery(page)
  await page.routeWebSocket('**/api/agents/ws', route => route.close({ code: 1011, reason: 'Agent bridge unavailable' }))
  await page.routeWebSocket('**/api/carrier/ws', route => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.goto(`/#/chat/${chatId}`)
  await openComposerNotices(page, 15000)
  const warning = page.getByRole('group', { name: 'Chat connection' })
  await expect(warning.getByRole('alert')).toHaveText('Chat connection unavailable.')
  await warning.locator('.command-composer-status-trigger').click()
  await expect(page.getByRole('dialog', { name: 'Recover a chat' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Open in terminal', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Recover a chat' })).toBeVisible()
  expect(fixture.launches).toHaveLength(0)
})
