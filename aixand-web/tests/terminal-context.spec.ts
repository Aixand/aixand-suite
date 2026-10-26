import { expect, test } from './fixtures'
import { contextGroups, sessionKind } from '../src/terminals/context'

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
