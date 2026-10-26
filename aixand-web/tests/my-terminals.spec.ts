import { expect, test } from './fixtures'
import type { Session } from '../src/terminals/connection'

test('My terminals requires explicit selection and preserves the open pane across marking, reload, and removal', async ({ page }) => {
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
  const other = page.getByRole('button', { name: 'Other terminals', exact: true })
  const pathspec = page.getByRole('button', { name: 'Pathspec', exact: true })
  await expect(other.locator('.tw-section-count')).toHaveText('2')
  await expect(mine).toHaveCount(0)
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
