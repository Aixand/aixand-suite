import { expandTerminalSection } from './terminal-helpers'
import { expect, test, type Page } from './fixtures'
import type { Session } from '../src/terminals/connection'
import type { GroupPage } from '../src/terminals/groups'

async function fixture(page: Page, outcome: 'success' | 'partial' | 'uncertain' = 'success', options: {
  unavailable?: boolean; onlyUnavailable?: boolean; forgetFailure?: boolean; catalogFailure?: boolean; paginated?: boolean
} = {}) {
  let sessions: Session[] = [
    { id: 'running', name: 'Keep running', lifecycle: { state: 'running' } },
    { id: 'stopped', name: 'Stopped shell', lifecycle: { state: 'stopped' } },
    { id: 'exited', name: 'Completed job', lifecycle: { state: 'exited', code: 0 } },
    { id: 'failed', name: 'Failed job', lifecycle: { state: 'failed' } },
  ]
  if (options.onlyUnavailable) sessions = sessions.filter(session => session.id === 'running')
  if (options.paginated) sessions = [...sessions.slice(1), sessions[0]]
  const data: GroupPage = { defaults: { cwd: '/work', shell: '/bin/sh' }, groups: [{
    id: 'saved', name: 'saved', cwd: '/work', shell: '/bin/sh', persistent: true, deleting: false, pending_name: null,
    members: [
      { key: 'running-slot', session_id: 'running', name: 'Keep running', restorable: true },
      ...(!options.onlyUnavailable ? [{ key: 'stopped-slot', session_id: 'stopped', name: 'Stopped shell', restorable: true }] : []),
      ...(options.unavailable ? [{ key: 'missing-slot', session_id: 'missing', name: 'Unavailable shell', restorable: true }] : []),
    ],
  }] }
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
      if (command.op === 'list') {
        if (options.catalogFailure) {
          socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Terminal catalog unavailable.' }))
          return
        }
        result = { items: options.paginated ? command.args.cursor ? sessions.slice(1) : sessions.slice(0, 1) : sessions,
          total: sessions.length, next_cursor: options.paginated && !command.args.cursor && sessions.length > 1 ? 'remaining' : null }
      }
      if (command.op === 'groups') result = data
      if (command.op === 'group-assign') {
        if (options.forgetFailure && command.args.sessionId === 'missing') {
          socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Saved group is busy.' }))
          return
        }
        data.groups.find(group => group.name === command.args.from)!.members =
          data.groups.find(group => group.name === command.args.from)!.members.filter(member => member.session_id !== command.args.sessionId)
      }
      if (command.op === 'attach') result = { stream: command.args.paneId, sessionId: command.args.sessionId }
      if (command.op === 'clean') {
        const candidates = sessions.filter(session => ['stopped', 'exited', 'failed'].includes(session.lifecycle.state))
        const removed = candidates.filter(session => outcome === 'success' || session.id === 'exited').map(session => session.id)
        sessions = sessions.filter(session => !removed.includes(session.id))
        if (outcome === 'uncertain') {
          socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Cleanup outcome is uncertain. Refresh before trying again.' }))
          return
        }
        result = { selected: candidates.length, succeeded: removed.map(session_id => ({ session_id })),
          failures: outcome === 'partial' ? [{ session_id: 'stopped', message: 'A restart is scheduled.' }, { session_id: 'failed', message: 'Session is busy.' }] : [] }
      }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
      if (command.op === 'attach') socket.send(JSON.stringify({ type: 'output', stream: command.args.paneId,
        sequence: '1', start: '0', offset: '7', data: Buffer.from('Ready\r\n').toString('base64') }))
    })
  })
  await page.goto('/#/terminals')
  await expandTerminalSection(page)
  await page.getByRole('button', { name: 'Keep running running', exact: true }).click()
  await expect(page.locator('.terminal-canvas')).toBeVisible()
  return requests
}

async function openCleanup(page: Page) {
  await page.getByRole('button', { name: 'Terminal options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Clean up inactive terminals', exact: true }).click()
  return page.getByRole('alertdialog', { name: 'Clean up inactive terminals?', exact: true })
}

test('cleanup covers hidden finished and unavailable sessions and preserves the running terminal and workspace', async ({ page }) => {
  const requests = await fixture(page, 'success', { unavailable: true, paginated: true })
  await page.locator('.terminal-canvas').evaluate(element => element.setAttribute('data-retained', 'yes'))
  let dialog = await openCleanup(page)
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Terminal options', exact: true })).toBeFocused()
  expect(requests.filter(command => command.op === 'clean')).toHaveLength(0)
  await page.getByRole('button', { name: 'Search terminals', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search terminals', exact: true }).fill('Completed job')
  dialog = await openCleanup(page)
  await expect(dialog).toContainText('4 finished or unavailable terminals')
  await dialog.getByRole('button', { name: 'Clean up', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Removed 4 terminals.')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search terminals', exact: true }).fill('')
  await expect(page.locator('.tw-library-row')).toHaveCount(1)
  await expect(page.locator('.terminal-canvas')).toHaveAttribute('data-retained', 'yes')
  expect(requests.filter(command => command.op === 'clean')).toEqual([expect.objectContaining({ args: { confirmed: true } })])
  expect(requests.filter(command => command.op === 'attach')).toHaveLength(1)
  expect(requests.filter(command => ['stop', 'restart', 'remove', 'detach'].includes(command.op))).toHaveLength(0)
  expect(requests.filter(command => command.op === 'group-assign').map(command => command.args)).toEqual([
    { sessionId: 'stopped', from: 'saved', to: null }, { sessionId: 'missing', from: 'saved', to: null },
  ])
  await page.getByRole('button', { name: 'Terminal options', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Clean up inactive terminals', exact: true })).toHaveAttribute('aria-disabled', 'true')
})

test('cleanup remains available when only unavailable saved terminals need removal', async ({ page }) => {
  const requests = await fixture(page, 'success', { unavailable: true, onlyUnavailable: true })
  const dialog = await openCleanup(page)
  await expect(dialog).toContainText('1 finished or unavailable terminal')
  await expect(dialog).toContainText('unavailable saved shells')
  await dialog.getByRole('button', { name: 'Clean up', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Removed 1 terminal.')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.locator('.tw-library-row')).toHaveCount(1)
  expect(requests.filter(command => command.op === 'group-assign').map(command => command.args.sessionId)).toEqual(['missing'])
})

test('cleanup reports unavailable entries that could not be forgotten without retrying them', async ({ page }) => {
  const requests = await fixture(page, 'success', { unavailable: true, onlyUnavailable: true, forgetFailure: true })
  const dialog = await openCleanup(page)
  await dialog.getByRole('button', { name: 'Clean up', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('0 terminals. 1 could not be removed.')
  await expect(dialog.getByRole('alert')).toContainText('Unavailable shell: Saved group is busy.')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.tw-library-row[data-status=unavailable]')).toHaveCount(1)
  expect(requests.filter(command => command.op === 'group-assign')).toHaveLength(1)
})

test('cleanup requires a complete catalog before removing saved terminals', async ({ page }) => {
  const options = { unavailable: true, onlyUnavailable: true, catalogFailure: false }
  const requests = await fixture(page, 'success', options)
  const dialog = await openCleanup(page)
  options.catalogFailure = true
  await dialog.getByRole('button', { name: 'Clean up', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Terminal catalog unavailable.')
  expect(requests.filter(command => ['clean', 'group-assign'].includes(command.op))).toHaveLength(0)
  await expect(page.locator('.tw-library-row[data-status=unavailable]')).toHaveCount(1)
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
