import { expect, test, type Page } from './fixtures'
import { expandTerminalSection } from './terminal-helpers'
import type { Session } from '../src/terminals/connection'
import type { GroupPage } from '../src/terminals/groups'

const titles = { mine: 'My terminals', pathspec: 'Pathspec', jobs: 'Jobs', other: 'Others', servers: 'Servers', inactive: 'Stopped & failures' }
const section = (page: Page, id: string) => page.locator(`.tw-library-section[data-section="${id}"]`)

async function fixture(page: Page, sections = Object.keys(titles)) {
  const sessions: Session[] = sections.flatMap(id => Array.from({ length: 12 }, (_, index) => ({
    id: `${id}-${index}`,
    name: `${id}-${String(index).padStart(2, '0')}`,
    lifecycle: { state: id === 'inactive' ? ['stopped', 'exited', 'failed'][index % 3] : 'running' },
    labels: id === 'mine' ? { 'aixand.my_terminal': 'true' }
      : id === 'pathspec' ? { app: 'pathspec' }
      : id === 'jobs' ? { 'session.kind': 'job' }
      : id === 'servers' ? { 'session.kind': 'server' } : {},
  })))
  const groups: GroupPage = {
    defaults: { cwd: '/work', shell: '/bin/sh' },
    groups: [{ id: 'saved', name: 'saved', cwd: '/work', shell: '/bin/sh', persistent: true, deleting: false, pending_name: null,
      members: [
        { key: 'saved-slot', session_id: 'missing', name: 'Saved shell', restorable: true },
        { key: 'live-slot', session_id: 'other-0', name: 'other-00', restorable: true },
      ] }],
  }
  const requests: { op: string; args: Record<string, unknown> }[] = []
  let publish = () => {}
  await page.routeWebSocket(/\/api\/(agents|carrier)\/ws/, socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      socket.send(JSON.stringify({ type: 'result', id: command.id, result: command.op === 'catalog'
        ? { profiles: [], auths: [], capabilities: [], cwd: '/work' }
        : command.op === 'chat-workflow-runs' ? { runs: [], nextOffset: null } : [] }))
    })
  })
  await page.routeWebSocket('**/api/terminals/ws', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    publish = () => socket.send(JSON.stringify({ type: 'metadata', kind: 'sessions' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      if (command.op === 'ack') return
      requests.push(command)
      let result: unknown = null
      if (command.op === 'list') result = { items: sessions, total: sessions.length, next_cursor: null }
      if (command.op === 'groups') result = groups
      if (command.op === 'group-restore') {
        const member = groups.groups[0].members.find(item => item.session_id === command.args.sessionId)!
        member.session_id = 'restored'
        sessions.push({ id: 'restored', name: member.name, lifecycle: { state: 'running' } })
        result = { notices: [] }
      }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto('/#/terminals')
  await expect(page.getByRole('button', { name: 'Others', exact: true }).locator('.tw-section-count')).toHaveText('12')
  return { sessions, publish, requests }
}

test('sections scroll independently while the last expanded active section fills the remaining space', async ({ page }) => {
  await fixture(page)
  for (const title of Object.values(titles)) await expandTerminalSection(page, title)
  for (const id of Object.keys(titles)) {
    const rows = section(page, id).locator('.tw-section-rows')
    await expect(rows).toHaveCSS('max-height', id === 'other' ? 'none' : '160px')
    if (id !== 'other') expect((await rows.boundingBox())!.height).toBeLessThanOrEqual(160)
    expect(await rows.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  }
  const others = section(page, 'other').locator('.tw-section-rows')
  await others.hover()
  const list = page.locator('.tw-session-list')
  const outerScroll = await list.evaluate(element => element.scrollTop)
  await page.mouse.wheel(0, 280)
  await expect.poll(() => others.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  expect(await section(page, 'mine').locator('.tw-section-rows').evaluate(element => element.scrollTop)).toBe(0)
  expect(await list.evaluate(element => element.scrollTop)).toBe(outerScroll)
  await expect(page.getByRole('button', { name: 'Others', exact: true })).toBeInViewport()
  await page.screenshot({ path: 'artifacts/terminal-sections/scrollable-sections.png' })
})

test('Others fills the space below My terminals and adjusts when the bottom sections expand', async ({ page }) => {
  const { sessions, publish } = await fixture(page, ['mine', 'other', 'servers', 'inactive'])
  sessions.push(...Array.from({ length: 40 }, (_, index) => ({ id: `extra-${index}`, name: `extra-${index}`, lifecycle: { state: 'running' } })))
  publish()
  const others = section(page, 'other')
  const rows = others.locator('.tw-section-rows')
  await expect(others.locator('.tw-section-count')).toHaveText('52')
  await expandTerminalSection(page)
  const active = page.locator('.tw-active-sections')
  const bottom = page.locator('.tw-bottom-sections')
  const fills = async () => {
    const activeBounds = (await active.boundingBox())!
    const rowBounds = (await rows.boundingBox())!
    expect(rowBounds.y + rowBounds.height).toBeCloseTo(activeBounds.y + activeBounds.height, 0)
    expect(rowBounds.y + rowBounds.height).toBeLessThanOrEqual((await bottom.boundingBox())!.y)
    expect(await active.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true)
    await expect(rows).toHaveCSS('max-height', 'none')
  }
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1440, height: 700 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await fills()
    expect((await rows.boundingBox())!.height).toBeGreaterThan(160)
    await expect(page.getByRole('separator', { name: 'Resize Others section', exact: true })).toHaveCount(0)
    await rows.evaluate(element => { element.scrollTop = 0 })
    await rows.focus()
    await rows.press('PageDown')
    await expect.poll(() => rows.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(await active.evaluate(element => element.scrollTop)).toBe(0)
    await page.screenshot({ path: test.info().outputPath(`terminal-fill-${viewport.width}-${viewport.height}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  const originalHeight = (await rows.boundingBox())!.height
  await expandTerminalSection(page, 'Servers')
  await fills()
  expect((await rows.boundingBox())!.height).toBeLessThan(originalHeight)
  await expandTerminalSection(page, 'Stopped & failures')
  await fills()
  await page.getByRole('button', { name: 'Others', exact: true }).click()
  await expect(section(page, 'mine')).toHaveAttribute('data-fill', 'true')
  await expect(section(page, 'mine').locator('.tw-section-rows')).toHaveCSS('max-height', 'none')
  expect((await section(page, 'mine').boundingBox())!.height).toBeGreaterThan(160)
  await page.getByRole('button', { name: 'My terminals', exact: true }).click()
  await expect(active.locator('[data-fill]')).toHaveCount(0)
})

test('Servers and Stopped & failures stay at the bottom through collapse, expansion, and active-list scrolling', async ({ page }) => {
  await fixture(page)
  const list = page.locator('.tw-session-list')
  const bottom = page.locator('.tw-bottom-sections')
  const servers = page.getByRole('button', { name: 'Servers', exact: true })
  const inactive = page.getByRole('button', { name: 'Stopped & failures', exact: true })
  const anchored = async () => {
    const listBottom = await list.evaluate(element => {
      const style = getComputedStyle(element)
      return element.getBoundingClientRect().bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth)
    })
    const bottomBounds = (await bottom.boundingBox())!
    expect(bottomBounds.y + bottomBounds.height).toBeCloseTo(listBottom, 0)
    await expect(servers).toBeInViewport()
    await expect(inactive).toBeInViewport()
    expect((await servers.boundingBox())!.y).toBeLessThan((await inactive.boundingBox())!.y)
  }
  await expect(servers).toHaveAttribute('aria-expanded', 'false')
  await expect(inactive).toHaveAttribute('aria-expanded', 'false')
  await anchored()
  await page.getByRole('button', { name: 'My terminals', exact: true }).click()
  await anchored()
  for (const toggle of [servers, inactive, servers, inactive]) {
    await toggle.click()
    await anchored()
  }
  for (const name of ['My terminals', 'Pathspec', 'Jobs', 'Others']) await expandTerminalSection(page, name)
  await page.getByRole('separator', { name: 'Resize My terminals section', exact: true }).press('End')
  await page.getByRole('separator', { name: 'Resize Pathspec section', exact: true }).press('End')
  const active = page.locator('.tw-active-sections')
  expect(await active.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await active.evaluate(element => { element.scrollTop = element.scrollHeight })
  await anchored()
  for (const viewport of [{ width: 1440, height: 400 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    const show = page.getByRole('button', { name: 'Show terminal list', exact: true })
    if (await show.isVisible()) await show.click()
    await expandTerminalSection(page, 'Servers')
    await expandTerminalSection(page, 'Stopped & failures')
    await anchored()
    expect(await active.evaluate(element => element.clientHeight)).toBeGreaterThan(0)
    for (const id of ['servers', 'inactive']) {
      const rows = section(page, id).locator('.tw-section-rows')
      expect(await rows.evaluate(element => element.clientHeight)).toBeGreaterThan(0)
      expect(await rows.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    }
    await page.screenshot({ path: test.info().outputPath(`terminal-bottom-${viewport.width}.png`) })
    await servers.click()
    await inactive.click()
    await anchored()
  }
  await page.reload()
  await page.getByRole('button', { name: 'Show terminal list', exact: true }).click()
  await expect(servers).toHaveAttribute('aria-expanded', 'false')
  await expect(inactive).toHaveAttribute('aria-expanded', 'false')
  await anchored()
})

test('section height can be dragged, changed with the keyboard, reset, and remembered independently', async ({ page }) => {
  await fixture(page)
  await expandTerminalSection(page)
  const resize = page.getByRole('separator', { name: 'Resize My terminals section', exact: true })
  const rows = section(page, 'mine').locator('.tw-section-rows')
  const bounds = (await resize.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 100, { steps: 5 })
  await page.mouse.up()
  await expect(resize).toHaveAttribute('aria-valuenow', '260')
  await expect(rows).toHaveCSS('max-height', '260px')
  expect((await rows.boundingBox())!.height).toBe(260)
  await expect(section(page, 'other').locator('.tw-section-rows')).toHaveCSS('max-height', 'none')
  await page.reload()
  await expect(resize).toHaveAttribute('aria-valuenow', '260')
  await resize.press('ArrowUp')
  await expect(rows).toHaveCSS('max-height', '228px')
  await resize.press('Home')
  await expect(rows).toHaveCSS('max-height', '64px')
  await resize.press('ArrowUp')
  await expect(rows).toHaveCSS('max-height', '64px')
  await resize.press('End')
  await expect(rows).toHaveCSS('max-height', '960px')
  await resize.press('Enter')
  await expect(rows).toHaveCSS('max-height', '160px')
  await resize.press('ArrowDown')
  await resize.dblclick()
  await expect(rows).toHaveCSS('max-height', '160px')
})

test('dragging a short terminal section reserves space beyond its rows and remembers the size', async ({ page }) => {
  const { sessions, publish } = await fixture(page, ['mine', 'other'])
  sessions.splice(1, 11)
  publish()
  await expect(section(page, 'mine').locator('.tw-section-count')).toHaveText('1')
  await expandTerminalSection(page)
  const rows = section(page, 'mine').locator('.tw-section-rows')
  const resize = page.getByRole('separator', { name: 'Resize My terminals section', exact: true })
  const originalHeight = (await rows.boundingBox())!.height
  expect(originalHeight).toBeLessThan(160)
  const handle = (await resize.boundingBox())!
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + 180, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await rows.boundingBox())!.height).toBeCloseTo(originalHeight + 180)
  await expect.poll(async () => (await resize.boundingBox())!.y).toBeCloseTo(handle.y + 180)
  await page.reload()
  await expect.poll(async () => (await rows.boundingBox())!.height).toBeCloseTo(originalHeight + 180)
  await resize.dblclick()
  await expect.poll(async () => (await rows.boundingBox())!.height).toBeCloseTo(originalHeight)
})

test('an empty section can be dragged and adjusted with the keyboard', async ({ page }) => {
  await fixture(page, ['mine', 'other'])
  await expandTerminalSection(page, 'Servers')
  const rows = section(page, 'servers').locator('.tw-section-rows')
  await expect(rows).toHaveText('No terminals in this section.')
  const resize = page.getByRole('separator', { name: 'Resize Servers section', exact: true })
  const originalHeight = (await rows.boundingBox())!.height
  const handle = (await resize.boundingBox())!
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + 100, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await rows.boundingBox())!.height).toBeCloseTo(originalHeight + 100)
  await resize.press('ArrowDown')
  await expect.poll(async () => (await rows.boundingBox())!.height).toBeCloseTo(originalHeight + 132)
  await page.reload()
  await expect.poll(async () => (await rows.boundingBox())!.height).toBeCloseTo(originalHeight + 132)
  await resize.press('Enter')
  await expect.poll(async () => (await rows.boundingBox())!.height).toBeCloseTo(originalHeight)
})

test('unavailable saved shells belong to Stopped & failures and keep their restoration actions', async ({ page }) => {
  const { requests } = await fixture(page)
  await expandTerminalSection(page)
  await expandTerminalSection(page, 'Stopped & failures')
  await expect(section(page, 'other').getByRole('button', { name: /Saved shell/, includeHidden: true })).toHaveCount(0)
  await expect(section(page, 'inactive').getByRole('button', { name: /^Saved shell unavailable/ })).toBeDisabled()
  await section(page, 'inactive').getByRole('button', { name: 'Manage terminal Saved shell', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Restore shell', exact: true }).click()
  await expect(section(page, 'other').getByRole('button', { name: 'Saved shell running', exact: true })).toBeVisible()
  await expect(section(page, 'inactive').locator('.tw-inactive-count')).toHaveText('12')
  expect(requests.filter(command => command.op === 'group-restore')).toHaveLength(1)
})

test('an open row menu survives a session moving to Stopped & failures', async ({ page }) => {
  const { sessions, publish } = await fixture(page)
  await expandTerminalSection(page)
  await expandTerminalSection(page, 'Stopped & failures')
  await page.getByRole('button', { name: 'Search terminals', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search terminals', exact: true }).fill('other-00')
  await page.getByRole('button', { name: 'Manage terminal other-00', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Manage terminal other-00', exact: true })
  await menu.evaluate(element => element.setAttribute('data-retained', 'yes'))
  sessions.find(session => session.id === 'other-0')!.lifecycle.state = 'stopped'
  publish()
  await expect(section(page, 'inactive').getByRole('button', { name: 'other-00 stopped', exact: true })).toBeVisible()
  await expect(menu).toHaveAttribute('data-retained', 'yes')
  await expect(menu.getByRole('menuitem', { name: 'Stop gracefully', exact: true })).toBeDisabled()
  sessions.splice(sessions.findIndex(session => session.id === 'other-0'), 1)
  publish()
  await expect(section(page, 'inactive').getByRole('button', { name: /^other-00 unavailable/ })).toBeDisabled()
  await expect(menu).toHaveAttribute('data-retained', 'yes')
  await expect(menu.getByRole('menuitem', { name: 'Restore shell', exact: true })).toBeEnabled()
})
