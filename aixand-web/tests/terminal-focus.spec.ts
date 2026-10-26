import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from './fixtures'
import type { Session } from '../src/terminals/connection'

async function terminalWorkspace(page: Page, many = false) {
  const sessions: Session[] = [
    { id: 'server', name: 'server-process', lifecycle: { state: 'running' }, profile: 'work', labels: { app: 'aixand-suite', 'session.kind': 'server', 'service.name': 'aixand-web' } },
    { id: 'shell', name: 'Development shell', lifecycle: { state: 'running' }, profile: 'work', labels: { 'aixand.my_terminal': 'true', 'project.name': 'Studio' } },
    { id: 'reviewer', name: 'Review changes', lifecycle: { state: 'running' }, profile: 'review', labels: { app: 'pathspec', 'project.name': 'Studio' } },
    { id: 'exited', name: 'Failed build', lifecycle: { state: 'exited', code: 2 }, labels: { 'session.kind': 'job' } },
    ...Array.from({ length: many ? 70 : 0 }, (_, index): Session => ({ id: `shell-${index}`, name: `Project shell ${index + 1}`, lifecycle: { state: 'running' } })),
  ]
  const operations: { op: string; args: Record<string, unknown> }[] = []
  await page.routeWebSocket(/\/api\/(agents|carrier)\/ws/, socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      const result = command.op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: '/work' }
        : command.op === 'chat-workflow-runs' ? { runs: [], nextOffset: null } : []
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.routeWebSocket('**/api/terminals/ws', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      operations.push(command)
      if (command.op === 'ack') return
      const result = command.op === 'list' ? { items: sessions, next_cursor: null, total: sessions.length }
        : command.op === 'groups' ? { groups: [], defaults: { cwd: '/work', shell: '/bin/sh' } }
          : command.op === 'attach' ? { stream: command.args.paneId, sessionId: command.args.sessionId } : null
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
      if (command.op === 'attach') socket.send(JSON.stringify({ type: 'output', stream: command.args.paneId, sequence: '1', start: '0', offset: '18', data: Buffer.from('Workspace ready.\r\n').toString('base64') }))
    })
  })
  await page.goto('/#/terminals')
  await expect(page.getByRole('button', { name: /^Development shell running/, includeHidden: true })).toBeAttached()
  return { sessions, operations }
}

test('the terminal library fills the viewport and search and section changes preserve the open terminal', async ({ page }) => {
  const { operations } = await terminalWorkspace(page, true)
  const sidebar = page.getByRole('complementary', { name: 'Terminal sessions', exact: true })
  await expect(page.locator('.topbar')).toHaveCount(0)
  const bounds = (await sidebar.boundingBox())!
  expect(bounds.y).toBe(0)
  expect(bounds.height).toBe(page.viewportSize()!.height)
  await expect(page.getByRole('navigation', { name: 'Workspace navigation', exact: true })).toBeVisible()
  const shell = page.getByRole('button', { name: /^Development shell running/ })
  await shell.click()
  const canvas = page.locator('.terminal-canvas')
  await expect(canvas).toBeVisible()
  await canvas.evaluate(element => element.setAttribute('data-retained', 'yes'))
  await expect(shell.locator('.tw-session-meta')).toHaveText('Studio · work')
  const create = page.getByRole('button', { name: 'New terminal', exact: true })
  const headerBounds = await create.boundingBox()
  await page.locator('.tw-session-list').evaluate(element => { element.scrollTop = element.scrollHeight })
  expect(await create.boundingBox()).toEqual(headerBounds)
  await expect(page.getByRole('searchbox', { name: 'Search terminals', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Search terminals', exact: true }).press('Enter')
  const search = page.getByRole('searchbox', { name: 'Search terminals', exact: true })
  await expect(search).toBeFocused()
  await search.fill('work')
  await expect(page.locator('.tw-library-row:visible')).toHaveCount(2)
  await search.fill('Development')
  await expect(page.locator('.tw-library-row:visible')).toHaveCount(1)
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await search.press('Escape')
  await expect(page.getByRole('button', { name: 'Search terminals', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'My terminals', exact: true }).click()
  await expect(shell).toBeHidden()
  await expect(canvas).toHaveAttribute('data-retained', 'yes')
  expect(operations.filter(command => command.op === 'attach')).toHaveLength(1)
  expect(operations.filter(command => ['detach', 'stop', 'restart', 'remove'].includes(command.op))).toHaveLength(0)
})

test('the terminal library is readable in both themes and keeps failed processes available', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await terminalWorkspace(page)
  for (const mode of ['light', 'dark']) {
    if (await page.locator('.aixand-app').getAttribute('data-bbb-mode') !== mode) await page.getByRole('button', { name: /^Color mode:/ }).click()
    await page.getByRole('button', { name: /^Development shell running/ }).click()
    const accessibility = await new AxeBuilder({ page }).include('.tw-sidebar').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: `artifacts/terminal-focus/${mode}-workspace.png` })
  }
  await page.getByRole('button', { name: 'Stopped and exited sessions', exact: true }).click()
  const failed = page.getByRole('button', { name: /^Failed build exited/ })
  await expect(failed).toBeVisible()
  await expect(failed.locator('.tw-session-outcome')).toHaveText('Exit 2')
})

for (const width of [320, 390]) {
  test(`the terminal list and controls stay reachable at ${width}px and 200% text`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.emulateMedia({ colorScheme: width === 320 ? 'light' : 'dark' })
    await terminalWorkspace(page)
    const sidebar = page.getByRole('complementary', { name: 'Terminal sessions', exact: true })
    const toggle = page.getByRole('button', { name: 'Show terminal list', exact: true })
    await expect(sidebar).toBeHidden()
    await toggle.click()
    await expect(sidebar).toBeVisible()
    await page.screenshot({ path: `artifacts/terminal-focus/${width}-library.png` })
    await page.getByRole('button', { name: 'Search terminals', exact: true }).click()
    const search = page.getByRole('searchbox', { name: 'Search terminals', exact: true })
    await search.fill('Development')
    await page.getByRole('button', { name: /^Development shell running/ }).click()
    await expect(sidebar).toBeHidden()
    await page.getByRole('button', { name: 'Show terminal list', exact: true }).click()
    await expect(search).toHaveValue('Development')
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await expect(page.getByRole('button', { name: 'New terminal', exact: true })).toBeVisible()
    await expect(search).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const selected = page.getByRole('button', { name: /^Development shell running/ })
    await selected.scrollIntoViewIfNeeded()
    const selectedBounds = (await selected.boundingBox())!
    expect(selectedBounds.y).toBeGreaterThanOrEqual(0)
    expect(selectedBounds.y + selectedBounds.height).toBeLessThanOrEqual(844)
    await page.screenshot({ path: `artifacts/terminal-focus/${width}-enlarged.png` })
    await page.getByRole('button', { name: 'Close terminal list', exact: true }).press('Enter')
    await expect(page.getByRole('button', { name: 'Show terminal list', exact: true })).toBeFocused()
    await expect(page.getByRole('button', { name: 'Profile menu', exact: true })).toBeInViewport()
  })
}
