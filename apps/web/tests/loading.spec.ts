import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type WebSocketRoute } from './fixtures'

async function holdServices(page: Page) {
  await page.routeWebSocket(/\/api\/(agents|carrier|terminals)\/ws/, () => {})
}

function deferred() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

test('page code loading stays centered and keeps workspace navigation usable', async ({ page }) => {
  await holdServices(page)
  const module = deferred()
  await page.route('**/src/pages/Terminals.tsx*', async (route) => {
    await module.promise
    await route.continue()
  })
  await page.goto('/#/home')
  await page.getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('link', { name: 'Terminals', exact: true }).click()
  const loading = page.locator('.main-content > .page-loading')
  await expect(loading.getByRole('status')).toHaveText('Loading terminals…')
  const main = (await page.getByRole('main').boundingBox())!
  const indicator = (await loading.getByRole('status').boundingBox())!
  expect(Math.abs(indicator.x + indicator.width / 2 - main.x - main.width / 2)).toBeLessThan(2)
  expect(Math.abs(indicator.y + indicator.height / 2 - main.y - main.height / 2)).toBeLessThan(2)
  await page.screenshot({ path: test.info().outputPath('page-loading.png') })
  await page.getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Home' })).toBeFocused()
  module.release()
})

test('session loading uses the full screen and resolves into the workspace', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await holdServices(page)
  const session = deferred()
  await page.route('**/api/auth/session', async (route) => {
    await session.promise
    await route.fulfill({ json: {
      authenticated: true, csrfToken: 'isolated-ui-csrf', expiresAt: Date.now() + 3600000,
    } })
  })
  await page.goto('/')
  await expect(page.getByRole('status')).toHaveText('Checking your session…')
  await expect(page.locator('.onboarding-fields')).not.toBeVisible()
  const indicator = (await page.getByRole('status').boundingBox())!
  const viewport = page.viewportSize()!
  expect(Math.abs(indicator.x + indicator.width / 2 - viewport.width / 2)).toBeLessThan(2)
  expect(Math.abs(indicator.y + indicator.height / 2 - viewport.height / 2)).toBeLessThan(2)
  await page.screenshot({ path: test.info().outputPath('session-loading.png') })
  await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
  await expect(page.locator('.onboarding-overlay')).toHaveAttribute('data-bbb-mode', 'dark')
  expect(await page.evaluate(() => localStorage.getItem('aixand.appearance'))).toBe('dark')
  session.release()
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible()
  await expect(page.locator('.onboarding-overlay')).toHaveCount(0)
  await expect(page.locator('.aixand-app')).toHaveAttribute('data-bbb-mode', 'dark')
})

async function delayedTerminals(page: Page) {
  await holdServices(page)
  const requests: { socket: WebSocketRoute; id: string; op: string }[] = []
  let connection: WebSocketRoute | undefined
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    connection = socket
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw)) as { id: string; op: string }
      if (request.op === 'list' || request.op === 'groups') requests.push({ socket, ...request })
      else socket.send(JSON.stringify({ type: 'result', id: request.id, result: null }))
    })
  })
  return {
    ready: () => connection!.send(JSON.stringify({ type: 'ready' })),
    pending: (op: string) => requests.filter((request) => request.op === op).length,
    respond(op: string, result: unknown) {
      const index = requests.findIndex((request) => request.op === op)
      expect(index).toBeGreaterThanOrEqual(0)
      const [request] = requests.splice(index, 1)
      request.socket.send(JSON.stringify({ type: 'result', id: request.id, result }))
    },
    close: () => connection!.close({ code: 1011, reason: 'Terminal service unavailable' }),
  }
}

test('terminal loading waits for the complete catalog before showing an empty workspace', async ({ page }) => {
  const terminals = await delayedTerminals(page)
  await page.goto('/#/terminals')
  const loading = page.locator('.terminal-tile .page-loading')
  await expect(loading.getByRole('status')).toHaveText('Loading terminals…')
  await page.screenshot({ path: test.info().outputPath('terminal-loading.png') })
  await expect(page.getByText('A place for your next command.')).toHaveCount(0)
  await expect(page.getByText('No terminals yet. Use + to start a shell.')).toHaveCount(0)
  terminals.ready()
  await expect.poll(() => terminals.pending('list')).toBe(1)
  terminals.respond('list', { items: [], next_cursor: 'second-page', total: 0 })
  terminals.respond('groups', { groups: [], defaults: { cwd: '', shell: '' } })
  await expect.poll(() => terminals.pending('list')).toBe(1)
  await expect(loading).toBeVisible()
  terminals.respond('list', { items: [], next_cursor: null, total: 0 })
  await expect(loading).toHaveCount(0)
  await expect(page.getByText('No terminals yet. Use + to start a shell.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose a terminal' })).toBeEnabled()
  await expect(page.locator('.tw-session-list')).toHaveAttribute('aria-busy', 'false')
})

test('terminal connection failure stops the loader and makes retry available', async ({ page }) => {
  const terminals = await delayedTerminals(page)
  await page.goto('/#/terminals')
  await expect(page.locator('.terminal-tile .page-loading')).toBeVisible()
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  terminals.close()
  await expect(page.locator('.terminal-tile .page-loading')).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('Terminal service unavailable')
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toBeEnabled()
})

for (const route of ['agents', 'carrier', 'prompts', 'skills']) {
  test(`${route} has accessible loading feedback at narrow widths and with reduced motion`, async ({ page }) => {
    await holdServices(page)
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' })
    await page.goto(`/#/${route}`)
    const loading = page.locator('.page-loading').last()
    await expect(loading.getByRole('status')).toContainText('Loading')
    await expect(loading.locator('.bbb-button__spinner')).toHaveCSS('animation-name', 'none')
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
      const visibleLoading = route === 'prompts'
        ? page.locator('.prompts-library .bbb-loading-indicator') : loading
      await expect(visibleLoading).toBeVisible()
      await expect(visibleLoading.getByText(/Loading/)).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      if (width === 390) await page.screenshot({ path: test.info().outputPath('narrow-loading.png') })
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '' })
    await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('wide-loading.png') })
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  })
}
