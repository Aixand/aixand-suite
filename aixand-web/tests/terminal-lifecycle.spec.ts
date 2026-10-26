import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
import type { Session } from '../src/terminals/connection'

async function fixture(page: Page, state = 'running', scheduled = false) {
  const requests: { op: string; args: Record<string, unknown> }[] = []
  const session: Session = {
    id: 'development-id',
    name: 'development',
    lifecycle: { state },
    started_at_millis: 1,
    restart_count: 0,
    restart_status: { state: scheduled ? 'scheduled' : 'idle' },
  }
  const other: Session = {
    id: 'other-id',
    name: 'other',
    lifecycle: { state: 'running' },
  }
  let sessions = [session, other]
  let failure = ''
  let publish = () => {}
  let loseConnection = () => {}
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    loseConnection = () => socket.close({ code: 1001, reason: 'Test connection lost' })
    publish = () =>
      socket.send(JSON.stringify({ type: 'metadata', kind: 'sessions' }))
    let offset = 0
    let sequence = 0
    let stream = ''
    function output(data: string) {
      const bytes = Buffer.from(data)
      const start = offset
      offset += bytes.length
      socket.send(
        JSON.stringify({
          type: 'output',
          stream,
          sequence: String(++sequence),
          start: String(start),
          offset: String(offset),
          data: bytes.toString('base64'),
        })
      )
    }
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      requests.push(command)
      if (command.op === 'auth') {
        socket.send(JSON.stringify({ type: 'ready' }))
        return
      }
      if (command.op === 'ack') return
      const mutation = ['stop', 'restart', 'remove'].includes(command.op)
      if (mutation && failure) {
        socket.send(
          JSON.stringify({ type: 'error', id: command.id, message: failure })
        )
        return
      }
      let result: unknown = null
      if (command.op === 'list')
        result = { items: sessions, next_cursor: null, total: sessions.length }
      if (command.op === 'stop') {
        session.lifecycle = { state: 'stopped' }
        session.restart_status = { state: 'not_scheduled' }
        result = { session, already_terminal: false }
      }
      if (command.op === 'restart') {
        session.lifecycle = { state: 'running' }
        session.started_at_millis = (session.started_at_millis ?? 0) + 1
        session.restart_count = (session.restart_count ?? 0) + 1
        session.restart_status = { state: 'idle' }
        result = { session }
      }
      if (command.op === 'remove') {
        sessions = sessions.filter((item) => item.id !== session.id)
        result = { session_id: session.id, removal_revision: 2 }
      }
      if (command.op === 'attach') {
        stream = command.args.paneId
        result = { stream }
      }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
      if (command.op === 'attach') {
        if (command.args.screen) {
          socket.send(
            JSON.stringify({
              type: 'screen',
              stream,
              sequence: String(++sequence),
              offset: String(offset),
              columns: 80,
              rows: 24,
              data: Buffer.from('RESTARTED_SCREEN\r\n').toString('base64'),
            })
          )
        } else {
          offset = Number(command.args.offset ?? 0)
          output('BEFORE_CLEAR\r\n')
        }
      }
      if (command.op === 'input')
        output(Buffer.from(command.args.data, 'base64').toString())
    })
  })
  await page.goto('/#/terminals')
  if (['stopped', 'exited'].includes(state))
    await page.getByRole('button', { name: 'Stopped and exited sessions', exact: true }).click()
  await page
    .getByRole('button', { name: `development ${state}`, exact: true })
    .click()
  const pane = page.getByRole('region', {
    name: 'Terminal development',
    exact: true,
  })
  await expect(pane).toContainText('BEFORE_CLEAR')
  return {
    requests,
    pane,
    session,
    addSessions: (items: Session[]) => {
      sessions.push(...items)
      publish()
    },
    disconnect: () => loseConnection(),
    fail: (message: string) => {
      failure = message
    },
    update: (state: string, scheduled = false) => {
      session.lifecycle = { state }
      session.restart_status = { state: scheduled ? 'scheduled' : 'idle' }
      publish()
    },
    actions: () =>
      page
        .getByRole('button', {
          name: 'Terminal actions for development',
          exact: true,
        })
        .click(),
    mutations: () =>
      requests.filter((request) =>
        ['stop', 'restart', 'remove'].includes(request.op)
      ),
  }
}

test('clear screen preserves the process, byte cursor, and live input', async ({
  page,
}) => {
  const context = await fixture(page)
  const before = context.requests.filter((request) =>
    ['input', 'attach', 'detach'].includes(request.op)
  ).length
  await context.actions()
  await page.getByRole('menuitem', { name: 'Clear screen', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(
    context.pane.locator('.xterm-accessibility-tree')
  ).not.toContainText('BEFORE_CLEAR')
  expect(
    context.requests.filter((request) =>
      ['input', 'attach', 'detach'].includes(request.op)
    )
  ).toHaveLength(before)
  await context.pane.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('AFTER_CLEAR')
  await expect(context.pane).toContainText('AFTER_CLEAR')
  await expect(context.pane.getByRole('alert')).toHaveCount(0)
  expect(context.mutations()).toEqual([])
  context.disconnect()
  await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Disconnected')
  await context.actions()
  await expect(
    page.getByRole('menuitem', { name: 'Stop gracefully', exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole('menuitem', { name: 'Clear screen', exact: true })
  ).toBeEnabled()
})

test('runs lifecycle actions directly, resumes a restarted process, and removes only a finished session', async ({
  page,
}) => {
  const context = await fixture(page)
  await context.actions()
  await expect(
    page.getByRole('menuitem', { name: 'Remove', exact: true })
  ).toBeDisabled()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(context.mutations()).toEqual([])
  await context.actions()
  await page.getByRole('menuitem', { name: 'Stop gracefully', exact: true }).click()
  await page.getByRole('button', { name: 'Stopped and exited sessions', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'development stopped', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('menu')).toHaveCount(0)
  expect(context.mutations()).toEqual([
    {
      op: 'stop',
      id: expect.any(String),
      args: { sessionId: 'development-id', force: false },
    },
  ])
  const inputCount = context.requests.filter(
    (request) => request.op === 'input'
  ).length
  await context.pane.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('IGNORED')
  expect(
    context.requests.filter((request) => request.op === 'input')
  ).toHaveLength(inputCount)
  await context.actions()
  await expect(
    page.getByRole('menuitem', { name: 'Stop gracefully', exact: true })
  ).toBeDisabled()
  await page.getByRole('menuitem', { name: 'Restart', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'development running', exact: true })
  ).toBeVisible()
  await expect(context.pane).toContainText('RESTARTED_SCREEN')
  await context.pane.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('RESTARTED_INPUT')
  await expect(context.pane).toContainText('RESTARTED_INPUT')
  await context.actions()
  await page.getByRole('menuitem', { name: 'Force restart', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  // Closed panes are still manageable in the sidebar.
  await page
    .getByRole('button', { name: 'Close pane development', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Manage terminal development', exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Force stop', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page
    .getByRole('button', { name: 'development stopped', exact: true })
    .click()
  await context.actions()
  await page
    .getByRole('menuitem', { name: 'Remove', exact: true })
    .click()
  await expect(
    page.getByRole('region', { name: 'Terminal development', exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', {
      name: 'Manage terminal development',
      exact: true,
    })
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'other running', exact: true })
  ).toBeVisible()
  expect(context.mutations().map(({ op, args }) => ({ op, args }))).toEqual([
    { op: 'stop', args: { sessionId: 'development-id', force: false } },
    { op: 'restart', args: { sessionId: 'development-id', force: false } },
    { op: 'restart', args: { sessionId: 'development-id', force: true } },
    { op: 'stop', args: { sessionId: 'development-id', force: true } },
    { op: 'remove', args: { sessionId: 'development-id', confirmed: true } },
  ])
})

test('uses status dots and keeps stopped and exited sessions in a bottom disclosure', async ({ page }) => {
  const context = await fixture(page)
  const additional: Session[] = Array.from({ length: 35 }, (_, index) => ({
    id: `worker-${index}`,
    name: `worker-${String(index).padStart(2, '0')}`,
    lifecycle: { state: 'running' },
  }))
  additional.push(
    { id: 'finished', name: 'finished', lifecycle: { state: 'exited', code: 0 } },
    { id: 'paused', name: 'paused', lifecycle: { state: 'stopped' } },
    { id: 'failed', name: 'failed', lifecycle: { state: 'failed' } },
  )
  context.addSessions(additional)
  const toggle = page.getByRole('button', { name: 'Stopped and exited sessions', exact: true })
  const list = page.locator('.tw-session-list')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toContainText('2')
  await expect(list.locator('.tw-library-row[data-status=stopped]')).toBeHidden()
  await expect(list.locator('.tw-library-row[data-status=exited]')).toBeHidden()
  await expect(page.getByRole('button', { name: 'failed failed', exact: true })).toBeVisible()
  const row = page.getByRole('button', { name: 'development running', exact: true })
  await expect(row.locator('.tw-session-status')).toBeVisible()
  await expect(row).toHaveAccessibleName('development running')
  const initial = (await toggle.boundingBox())!
  const bounds = (await list.boundingBox())!
  expect(Math.abs(initial.y + initial.height - bounds.y - bounds.height)).toBeLessThan(1)
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight })
  expect(Math.abs((await toggle.boundingBox())!.y - initial.y)).toBeLessThan(1)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await list.evaluate((element) => { element.scrollTop = 0 })
  expect((await toggle.boundingBox())!.y).toBeGreaterThan(bounds.y + bounds.height)
  const stopped = page.getByRole('button', { name: 'paused stopped', exact: true })
  const exited = page.getByRole('button', { name: 'finished exited · exit 0', exact: true })
  await stopped.scrollIntoViewIfNeeded()
  await expect(stopped).toBeVisible()
  await expect(exited).toBeVisible()
  expect(await stopped.locator('.tw-session-status').evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toEqual(await exited.locator('.tw-session-status').evaluate((element) => getComputedStyle(element).backgroundColor))
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toBeFocused()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(stopped).toBeHidden()
  expect(Math.abs((await toggle.boundingBox())!.y + initial.height - bounds.y - bounds.height)).toBeLessThan(1)
  await page.getByRole('button', { name: 'Search terminals', exact: true }).click()
  await page.getByLabel('Search terminals', { exact: true }).fill('paused')
  await expect(toggle).toContainText('1')
  await expect(list.locator('.tw-library-row[data-status=running]')).toHaveCount(0)
  await toggle.click()
  await expect(stopped).toBeVisible()
})

test('retains the session and shows a failed mutation without retrying it', async ({
  page,
}) => {
  const context = await fixture(page)
  context.fail(
    'Stop outcome is uncertain. Inspect the session before trying again.'
  )
  await context.actions()
  await page.getByRole('menuitem', { name: 'Force stop', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Stop outcome is uncertain'
  )
  expect(context.mutations()).toHaveLength(1)
  await expect(
    page.getByRole('button', { name: 'development running', exact: true })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await context.actions()
  await expect(
    page.getByRole('menuitem', { name: 'Remove', exact: true })
  ).toBeDisabled()
})

test('cancels a scheduled restart before allowing removal', async ({
  page,
}) => {
  const context = await fixture(page, 'exited', true)
  await context.actions()
  await expect(
    page.getByRole('menuitem', { name: 'Remove', exact: true })
  ).toBeDisabled()
  await page
    .getByRole('menuitem', { name: 'Cancel scheduled restart', exact: true })
    .click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await context.actions()
  await expect(
    page.getByRole('menuitem', { name: 'Remove', exact: true })
  ).toBeEnabled()
  expect(context.mutations().map(({ op, args }) => ({ op, args }))).toEqual([
    { op: 'stop', args: { sessionId: 'development-id', force: false } },
  ])
})

test('offers force stop while graceful stopping is in progress', async ({
  page,
}) => {
  const context = await fixture(page, 'stopping')
  await context.actions()
  await expect(
    page.getByRole('menuitem', { name: 'Stop gracefully', exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole('menuitem', { name: 'Force stop', exact: true })
  ).toBeEnabled()
  await expect(
    page.getByRole('menuitem', { name: 'Restart', exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole('menuitem', { name: 'Remove', exact: true })
  ).toBeDisabled()
})

test('updates menu actions when a scheduled restart changes externally', async ({ page }) => {
  const context = await fixture(page, 'exited', true)
  await context.actions()
  await expect(page.getByRole('menuitem', { name: 'Cancel scheduled restart', exact: true })).toBeEnabled()
  context.update('running')
  await expect(page.getByRole('menuitem', { name: 'Cancel scheduled restart', exact: true })).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Stop gracefully', exact: true })).toBeEnabled()
  await expect(page.getByRole('menuitem', { name: 'Remove', exact: true })).toBeDisabled()
  expect(context.mutations()).toEqual([])
})
