import { expect, test } from './fixtures'
import { expandTerminalSection } from './terminal-helpers'
import { contextGroups, sessionKind } from '../src/terminals/context'
import type { Session } from '../src/terminals/connection'

test('process classification takes precedence over legacy feature labels', () => {
  expect(sessionKind({ 'session.kind': 'agent', feature: 'app-server' })).toBe('agent')
  expect(sessionKind({ feature: 'app-server' })).toBe('server')
  expect(contextGroups([{ labels: { 'session.kind': 'server', 'service.name': 'runner' } }]))
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'session.kind', value: 'server', count: 1 }),
      expect.objectContaining({ key: 'service.name', value: 'runner', count: 1 }),
    ]))
})

test('servers group separately from Pathspec agents and open by stable session ID', async ({ page }) => {
  const sessions = [
    { id: 'server', name: 'agent-server-id', lifecycle: { state: 'running' },
      labels: { app: 'pathspec', 'session.kind': 'server', 'service.name': 'codex-app-server', 'agent_manager.profile': 'work' } },
    { id: 'reviewer', name: 'agent-review-id', lifecycle: { state: 'running' },
      labels: { app: 'pathspec', 'session.kind': 'agent', feature: 'workflow', 'workflow.step_id': 'CELL-001', role: 'reviewer' } },
    { id: 'job', name: 'maintenance', lifecycle: { state: 'running' },
      labels: { app: 'aixand-suite', 'session.kind': 'job' } },
    { id: 'shell', name: 'my-shell', lifecycle: { state: 'running' } },
  ]
  const requests: { op: string; args: Record<string, unknown> }[] = []
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      requests.push(command)
      if (command.op === 'ack') return
      let result: unknown = null
      if (command.op === 'list') result = { items: sessions, next_cursor: null, total: sessions.length }
      if (command.op === 'groups') result = { groups: [], defaults: { cwd: '/work', shell: '/bin/sh' } }
      if (command.op === 'attach') result = { stream: command.args.paneId, sessionId: command.args.sessionId }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto('/#/terminals')
  await expandTerminalSection(page, 'Servers')
  await expandTerminalSection(page, 'Pathspec')
  const server = page.getByRole('button', { name: /^Codex server · work running/ })
  const reviewer = page.getByRole('button', { name: /^Pathspec · CELL-001 · Reviewer running/ })
  await expect(server).toBeVisible()
  await expect(reviewer).toBeVisible()
  await expect(page.getByRole('button', { name: 'Jobs', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Servers', exact: true }).click()
  await expect(server).toBeHidden()
  await expect(reviewer).toBeVisible()
  await page.getByRole('button', { name: 'Servers', exact: true }).click()
  await server.click()
  await expect.poll(() => requests.some((request) => request.op === 'attach' && request.args.sessionId === 'server')).toBe(true)
  await page.getByRole('button', { name: 'Terminal actions for agent-server-id', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Stop gracefully', exact: true }))
    .toHaveAccessibleDescription(/All conversations using this Codex server are affected/)
  expect(sessions[0].name).toBe('agent-server-id')
  expect(requests.some((request) => ['stop', 'restart', 'create', 'remove'].includes(request.op))).toBe(false)
})

test('Servers takes priority over personal, app, and lifecycle sections above Stopped & failures', async ({ page }) => {
  const sessions: Session[] = [
    ...['starting', 'running', 'stopping', 'stopped', 'exited', 'failed'].map((state) => ({
      id: state,
      name: `server-${state}`,
      lifecycle: { state },
      labels: { app: 'pathspec', 'session.kind': 'server', 'aixand.my_terminal': 'true' },
    })),
    { id: 'legacy', name: 'legacy-server', lifecycle: { state: 'stopped' }, labels: { feature: 'app-server' } },
    { id: 'mine', name: 'my-shell', lifecycle: { state: 'running' }, labels: { 'aixand.my_terminal': 'true' } },
    { id: 'shell', name: 'stopped-shell', lifecycle: { state: 'stopped' } },
  ]
  let publish = () => {}
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    publish = () => socket.send(JSON.stringify({ type: 'metadata', kind: 'sessions' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      if (command.op === 'ack') return
      let result: unknown = null
      if (command.op === 'list') result = { items: sessions, next_cursor: null, total: sessions.length }
      if (command.op === 'groups') result = { groups: [], defaults: { cwd: '/work', shell: '/bin/sh' } }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto('/#/terminals')
  const list = page.locator('.tw-session-list')
  const servers = page.getByRole('button', { name: 'Servers', exact: true })
  const inactive = page.getByRole('button', { name: 'Stopped & failures', exact: true })
  await expect(servers.locator('.tw-section-count')).toHaveText('7')
  await expect(servers).toHaveAttribute('aria-expanded', 'false')
  await expect(inactive).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('button', { name: 'My terminals', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await servers.click()
  await expect(page.getByRole('button', { name: 'My terminals', exact: true }).locator('.tw-section-count')).toHaveText('1')
  await expect(inactive.locator('.tw-inactive-count')).toHaveText('1')
  await expect(list.locator('h3')).toHaveText(['My terminals1', 'Servers7', 'Stopped & failures1'])
  const serverRows = list.locator('[data-section="servers"] .tw-library-row')
  await expect(serverRows).toHaveCount(7)
  for (const row of await serverRows.all()) await expect(row).toBeVisible()
  const stoppedShell = page.getByRole('button', { name: 'stopped-shell stopped', exact: true })
  await expect(stoppedShell).toBeHidden()
  await inactive.click()
  await expect(stoppedShell).toBeVisible()
  await servers.click()
  for (const row of await serverRows.all()) await expect(row).toBeHidden()
  await expect(stoppedShell).toBeVisible()
  await inactive.click()
  await servers.click()
  for (const row of await serverRows.all()) await expect(row).toBeVisible()
  sessions.find((session) => session.id === 'running')!.lifecycle.state = 'stopped'
  publish()
  await expect(page.getByRole('button', { name: /^server-running stopped/ })).toBeVisible()
  await expect(servers.locator('.tw-section-count')).toHaveText('7')
  await expect(inactive.locator('.tw-inactive-count')).toHaveText('1')
  await page.reload()
  await expect(servers).toHaveAttribute('aria-expanded', 'true')
  await expect(inactive).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('button', { name: /^server-running stopped/ })).toBeVisible()
})

test('Servers and Stopped & failures remain visible when the catalog or search is empty', async ({ page }) => {
  const sessions: Session[] = []
  let publish = () => {}
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    publish = () => socket.send(JSON.stringify({ type: 'metadata', kind: 'sessions' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      if (command.op === 'ack') return
      let result: unknown = null
      if (command.op === 'list') result = { items: sessions, next_cursor: null, total: sessions.length }
      if (command.op === 'groups') result = { groups: [], defaults: { cwd: '/work', shell: '/bin/sh' } }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto('/#/terminals')
  const list = page.locator('.tw-session-list')
  const servers = page.getByRole('button', { name: 'Servers', exact: true })
  const inactive = page.getByRole('button', { name: 'Stopped & failures', exact: true })
  await expect(servers.locator('.tw-section-count')).toHaveText('0')
  await expect(inactive.locator('.tw-section-count')).toHaveText('0')
  await expect(list).toContainText('No terminals yet.')
  await expect(list.locator('.tw-bottom-sections > :last-child')).toHaveAttribute('data-section', 'inactive')
  expect((await servers.boundingBox())!.height).toBeLessThanOrEqual(30)
  sessions.push({ id: 'server', name: 'api-server', lifecycle: { state: 'running' }, labels: { 'session.kind': 'server' } })
  publish()
  await expect(servers.locator('.tw-section-count')).toHaveText('1')
  await page.getByRole('button', { name: 'Search terminals', exact: true }).click()
  await page.getByLabel('Search terminals', { exact: true }).fill('no-match')
  await expect(servers.locator('.tw-section-count')).toHaveText('0')
  await expect(list).toContainText('No matching terminals')
  await expect(servers).toBeVisible()
  await expect(inactive).toBeVisible()
  await page.getByLabel('Search terminals', { exact: true }).fill('')
  await expect(servers.locator('.tw-section-count')).toHaveText('1')
})
