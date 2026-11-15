import { expect, test, type Page } from './fixtures'
import { expandTerminalSection } from './terminal-helpers'
import type { Session } from '../src/terminals/connection'

async function creationFixture(page: Page, failMarking = false) {
  const sessions: Session[] = [
    { id: 'existing', name: 'Existing terminal', lifecycle: { state: 'running' }, labels: { 'aixand.my_terminal': 'true' } },
    { id: 'external', name: 'External terminal', lifecycle: { state: 'running' } },
  ]
  const requests: { op: string; args: Record<string, unknown> }[] = []
  const group = { id: 'development', name: 'development', cwd: '/work', shell: '/bin/sh', persistent: true,
    deleting: false, pending_name: null, members: [] as { key: string; session_id: string; name: string; restorable: boolean }[] }
  await page.addInitScript(() => localStorage.setItem('aixand.terminals.expandedSections.v1', '[]'))
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
      requests.push(command)
      if (command.op === 'ack') return
      if (command.op === 'set-my-terminal' && failMarking) {
        socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Label update unavailable' }))
        return
      }
      let result: unknown = null
      if (command.op === 'list') result = { items: sessions, next_cursor: null, total: sessions.length }
      if (command.op === 'groups') result = { groups: [group], defaults: { cwd: '/work', shell: '/bin/sh' } }
      if (command.op === 'create') {
        const session: Session = { id: 'created', name: command.args.name, lifecycle: { state: 'running' },
          labels: { app: 'aixand-suite', feature: 'terminal', 'session.kind': 'shell' } }
        sessions.push(session)
        if (command.args.group) group.members.push({ key: session.id, session_id: session.id, name: session.name, restorable: true })
        result = { session }
      }
      if (command.op === 'set-my-terminal') {
        const session = sessions.find(session => session.id === command.args.sessionId)!
        session.labels = { ...session.labels, 'aixand.my_terminal': 'true' }
        result = { session }
      }
      if (command.op === 'attach') result = { stream: command.args.paneId, sessionId: command.args.sessionId }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto('/#/terminals')
  await expect(page.getByRole('button', { name: 'My terminals', exact: true })).toHaveAttribute('aria-expanded', 'false')
  return { sessions, requests }
}

for (const grouped of [false, true]) {
  test(`new ${grouped ? 'grouped' : 'ungrouped'} terminals appear in My terminals and stay there after reload`, async ({ page }) => {
    const { sessions, requests } = await creationFixture(page)
    await page.getByRole('button', { name: 'New terminal', exact: true }).click()
    await page.getByLabel('Session name', { exact: true }).fill('Development')
    if (grouped) {
      await page.getByRole('button', { name: /New terminal group/ }).click()
      await page.getByRole('menuitemradio', { name: 'development', exact: true }).click()
    }
    await page.getByRole('button', { name: 'Create terminal', exact: true }).click()
    const mine = page.getByRole('region', { name: 'Terminals in My terminals', exact: true })
    await expect(mine.getByRole('button', { name: /^Development running/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'My terminals', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('button', { name: 'Others', exact: true }).locator('.tw-section-count')).toHaveText('1')
    expect(sessions.find(session => session.id === 'created')?.labels).toEqual({
      app: 'aixand-suite', feature: 'terminal', 'session.kind': 'shell', 'aixand.my_terminal': 'true',
    })
    expect(requests.filter(command => command.op === 'create')).toHaveLength(1)
    expect(requests.find(command => command.op === 'create')?.args.group).toBe(grouped ? 'development' : undefined)
    expect(requests.find(command => command.op === 'set-my-terminal')?.args).toEqual({ sessionId: 'created', myTerminal: true })
    await page.reload()
    await expandTerminalSection(page, 'My terminals')
    await expect(mine.getByRole('button', { name: /^Development running/ })).toBeVisible()
  })
}

test('a failed My terminals label update keeps the new terminal open and does not retry creation', async ({ page }) => {
  const { requests } = await creationFixture(page, true)
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await page.getByLabel('Session name', { exact: true }).fill('Development')
  await page.getByRole('button', { name: 'Create terminal', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'New terminal', exact: true })).not.toBeVisible()
  await expect(page.getByRole('region', { name: 'Terminal Development', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Terminal created, but could not add it to My terminals. Label update unavailable')
  expect(requests.filter(command => command.op === 'create')).toHaveLength(1)
  expect(requests.filter(command => command.op === 'set-my-terminal')).toHaveLength(1)
})

test('existing terminals require explicit selection and preserve the open pane across marking, reload, and removal', async ({ page }) => {
  const sessions: Session[] = [
    { id: 'plain', name: 'plain-shell', lifecycle: { state: 'running' } },
    { id: 'owned-shell', name: 'suite-shell', lifecycle: { state: 'running' }, labels: { app: 'aixand-suite', 'session.kind': 'shell' } },
    { id: 'pathspec', name: 'reviewer', lifecycle: { state: 'running' }, labels: { app: 'pathspec', role: 'reviewer', 'workflow.run_id': 'run-1' } },
  ]
  const requests: { op: string; args: Record<string, unknown> }[] = []
  let failMarking = false
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      requests.push(command)
      if (command.op === 'ack') return
      if (command.op === 'set-my-terminal' && failMarking) {
        socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Label update unavailable' }))
        return
      }
      let result: unknown = null
      if (command.op === 'list') result = { items: sessions, next_cursor: null, total: sessions.length }
      if (command.op === 'groups') result = { groups: [], defaults: { cwd: '/work', shell: '/bin/sh' } }
      if (command.op === 'attach') result = { stream: command.args.paneId }
      if (command.op === 'set-my-terminal') {
        const session = sessions.find((item) => item.id === command.args.sessionId)!
        session.labels ??= {}
        if (command.args.myTerminal) session.labels['aixand.my_terminal'] = 'true'
        else delete session.labels['aixand.my_terminal']
        result = { session }
      }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto('/#/terminals')
  const mine = page.getByRole('button', { name: 'My terminals', exact: true })
  const other = page.getByRole('button', { name: 'Others', exact: true })
  const pathspec = page.getByRole('button', { name: 'Pathspec', exact: true })
  await expect(other.locator('.tw-section-count')).toHaveText('2')
  await expect(mine).toHaveCount(0)
  await expandTerminalSection(page, 'Others')
  await expandTerminalSection(page, 'Pathspec')
  const reviewer = page.getByRole('button', { name: /^reviewer running/ })
  await reviewer.click()
  await expect.poll(() => requests.filter((command) => command.op === 'attach').length).toBe(1)
  const canvas = page.locator('.terminal-canvas')
  await canvas.evaluate((element) => element.setAttribute('data-retained', 'yes'))
  await page.getByRole('button', { name: 'Manage terminal reviewer', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add to My terminals', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(mine.locator('.tw-section-count')).toHaveText('1')
  await expect(pathspec).toHaveCount(0)
  await expect(canvas).toHaveAttribute('data-retained', 'yes')
  expect(sessions[2].labels).toEqual({ app: 'pathspec', role: 'reviewer', 'workflow.run_id': 'run-1', 'aixand.my_terminal': 'true' })
  expect(requests.filter((command) => ['attach', 'detach'].includes(command.op))).toHaveLength(1)
  await page.reload()
  await expect(mine.locator('.tw-section-count')).toHaveText('1')
  await page.getByRole('button', { name: 'Manage terminal reviewer', exact: true }).click()
  failMarking = true
  await page.getByRole('menuitem', { name: 'Remove from My terminals', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Label update unavailable')
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(mine.locator('.tw-section-count')).toHaveText('1')
  failMarking = false
  await page.getByRole('menuitem', { name: 'Remove from My terminals', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(mine).toHaveCount(0)
  await expect(pathspec.locator('.tw-section-count')).toHaveText('1')
  expect(sessions[2].labels).toEqual({ app: 'pathspec', role: 'reviewer', 'workflow.run_id': 'run-1' })
  expect(requests.filter((command) => ['stop', 'restart', 'remove', 'group-assign'].includes(command.op))).toHaveLength(0)
})
