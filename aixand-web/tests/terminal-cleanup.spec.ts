import { expect, test, type Page } from './fixtures'
import type { Session } from '../src/terminals/connection'

async function fixture(page: Page, outcome: 'success' | 'partial' | 'uncertain' = 'success') {
  let sessions: Session[] = [
    { id: 'running', name: 'Keep running', lifecycle: { state: 'running' } },
    { id: 'stopped', name: 'Stopped shell', lifecycle: { state: 'stopped' } },
    { id: 'exited', name: 'Completed job', lifecycle: { state: 'exited', code: 0 } },
    { id: 'failed', name: 'Failed job', lifecycle: { state: 'failed' } },
  ]
  const requests: { op: string; args: Record<string, unknown> }[] = []
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
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      requests.push(command)
      if (command.op === 'ack') return
      let result: unknown = null
      if (command.op === 'list') result = { items: sessions, total: sessions.length, next_cursor: null }
      if (command.op === 'groups') result = { groups: [], defaults: { cwd: '/work', shell: '/bin/sh' } }
      if (command.op === 'attach') result = { stream: command.args.paneId, sessionId: command.args.sessionId }
      if (command.op === 'clean') {
        const removed = outcome === 'success' ? ['stopped', 'exited', 'failed'] : ['exited']
        sessions = sessions.filter(session => !removed.includes(session.id))
        if (outcome === 'uncertain') {
          socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Cleanup outcome is uncertain. Refresh before trying again.' }))
          return
        }
        result = { selected: 3, succeeded: removed.map(session_id => ({ session_id })),
          failures: outcome === 'partial' ? [{ session_id: 'stopped', message: 'A restart is scheduled.' }, { session_id: 'failed', message: 'Session is busy.' }] : [] }
      }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
      if (command.op === 'attach') socket.send(JSON.stringify({ type: 'output', stream: command.args.paneId,
        sequence: '1', start: '0', offset: '7', data: Buffer.from('Ready\r\n').toString('base64') }))
    })
  })
  await page.goto('/#/terminals')
  await page.getByRole('button', { name: 'Keep running running', exact: true }).click()
  await expect(page.locator('.terminal-canvas')).toBeVisible()
  return requests
}

async function openCleanup(page: Page) {
  await page.getByRole('button', { name: 'Terminal options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Clean up finished terminals', exact: true }).click()
  return page.getByRole('alertdialog', { name: 'Clean up finished terminals?', exact: true })
}

test('cleanup covers hidden finished sessions and preserves the running terminal and workspace', async ({ page }) => {
  const requests = await fixture(page)
  await page.locator('.terminal-canvas').evaluate(element => element.setAttribute('data-retained', 'yes'))
  let dialog = await openCleanup(page)
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Terminal options', exact: true })).toBeFocused()
  expect(requests.filter(command => command.op === 'clean')).toHaveLength(0)
  await page.getByRole('button', { name: 'Search terminals', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search terminals', exact: true }).fill('Completed job')
  dialog = await openCleanup(page)
  await expect(dialog).toContainText('3 finished terminals')
  await dialog.getByRole('button', { name: 'Clean up', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Removed 3 terminals.')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search terminals', exact: true }).fill('')
  await expect(page.locator('.tw-library-row')).toHaveCount(1)
  await expect(page.locator('.terminal-canvas')).toHaveAttribute('data-retained', 'yes')
  expect(requests.filter(command => command.op === 'clean')).toEqual([expect.objectContaining({ args: { confirmed: true } })])
  expect(requests.filter(command => command.op === 'attach')).toHaveLength(1)
  expect(requests.filter(command => ['stop', 'restart', 'remove', 'detach'].includes(command.op))).toHaveLength(0)
  await page.getByRole('button', { name: 'Terminal options', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Clean up finished terminals', exact: true })).toHaveAttribute('aria-disabled', 'true')
})

for (const outcome of ['partial', 'uncertain'] as const) {
  test(`cleanup reports ${outcome} failures and reconciles without retrying`, async ({ page }) => {
    const requests = await fixture(page, outcome)
    const dialog = await openCleanup(page)
    await dialog.getByRole('button', { name: 'Clean up', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText(outcome === 'partial' ? '2 could not be removed.' : 'Cleanup outcome is uncertain.')
    if (outcome === 'partial') await expect(dialog).toContainText('A restart is scheduled.')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('.tw-library-row[data-status=exited]')).toHaveCount(0)
    await expect(page.locator('.tw-library-row[data-status=stopped]')).toHaveCount(1)
    await expect(page.locator('.tw-library-row[data-status=failed]')).toHaveCount(1)
    expect(requests.filter(command => command.op === 'clean')).toHaveLength(1)
    await expect(page.locator('.terminal-canvas')).toBeVisible()
  })
}
