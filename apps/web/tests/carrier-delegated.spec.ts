import { test, expect, mockAuthentication, type Page } from './fixtures'
import type { DelegatedTaskDetail } from '../src/carrier/client'

const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'
const parent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const child = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
function task(id = first): DelegatedTaskDetail {
  const value: DelegatedTaskDetail = { taskId: id, attemptId: first, status: id === first ? 'completed' : 'failed', mode: 'conversation', provider: 'codex',
    title: id === first ? 'Historical audit' : 'Failed investigation', parentChat: { id: parent, title: 'Parent audit' }, childChat: { id: child, title: 'Audit worker' },
    executionId: 'assigned-execution', turnId: 'assigned-turn', reportAccepted: true, executionOutcome: 'stopped',
    report: { outcome: 'completed', body: 'Saved report\n<script>window.reportExecuted=true</script>', artifacts: [
      { uri: 'javascript:alert(1)', description: 'Unsafe URI remains text', sha256: 'a'.repeat(64) }, { uri: 'file:///private/result.txt' },
    ] }, receipt: { messageId: 44, acknowledged: true }, error: null }
  if (id === second) { value.reportAccepted = false; value.report = null; value.receipt = null; value.error = 'Assigned execution failed before report'; value.executionOutcome = 'failed' }
  return value
}
async function fixture(page: Page) {
  await mockAuthentication(page)
  const calls: { op: string; args: Record<string, any> }[] = []
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  let listError = false, detailError = false, empty = false, badChat = false, holdFirst = false
  let release = () => {}
  await page.routeWebSocket(/\/api\/(agents|terminals|workflows|workflow-jobs|vox)\/ws/, socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      const result = command.op === 'catalog' ? { profiles: [], auths: [], capabilities: [], cwd: '/fixture' } :
        command.op === 'sessions' ? { runs: [], runtimeError: null } : []
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.routeWebSocket('**/api/carrier/ws', socket => {
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw)); calls.push(command)
      let result: unknown = []
      if (command.op === 'snapshot') result = { status: { connected: true, syncing: false, version: 1, outgoing_history: true, instance: 'fixture' }, messages: [], counts: {}, total: 0, next_offset: null }
      if (command.op === 'mailboxes') result = [{ id: 'user', name: 'Your inbox', address: 'fixture/user', role: 'human' }]
      if (command.op === 'directory') result = { sessions: [], next_after: null }
      if (command.op === 'delegated_tasks') {
        if (listError) return socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Temporary tasks failure' }))
        result = { tasks: empty ? [] : [task(command.args.before ? second : first), ...(!command.args.before ? [task(second)] : [])], next_before: empty || command.args.before ? null : 10 }
      }
      if (command.op === 'delegated_task') {
        if (detailError) return socket.send(JSON.stringify({ type: 'error', id: command.id, message: 'Temporary details failure' }))
        const detail = task(command.args.taskId)
        if (badChat) detail.childChat = { id: 'javascript:alert(1)', title: 'Invalid child' }
        const send = () => socket.send(JSON.stringify({ type: 'result', id: command.id, result: detail }))
        if (holdFirst && command.args.taskId === first) { release = send; return }
        return send()
      }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
    socket.send(JSON.stringify({ type: 'ready' }))
  })
  await page.goto('/#/carrier')
  await page.getByRole('button', { name: 'Delegated work', exact: true }).click()
  return { calls, pageErrors, setListError: (value: boolean) => { listError = value }, setDetailError: (value: boolean) => { detailError = value },
    setEmpty: () => { empty = true }, setBadChat: () => { badChat = true }, holdFirst: () => { holdFirst = true }, release: () => release() }
}

test('empty human inbox does not hide historical tasks, report, receipt or safe chat links', async ({ page }) => {
  const f = await fixture(page)
  await page.getByRole('button', { name: /Historical audit/ }).click()
  const reader = page.getByRole('article', { name: 'Delegated work details' })
  await expect(reader.getByRole('heading', { name: 'Historical audit' })).toBeVisible()
  await expect(reader).toContainText('Recorded execution outcome')
  await expect(reader.locator('dd').filter({ hasText: /^stopped$/ })).toHaveCount(1)
  await expect(reader).toContainText('Report outcome: completed')
  await expect(reader).toContainText('Message: 44')
  await expect(reader).toContainText('Acknowledged')
  await expect(reader.getByRole('link', { name: 'Parent audit' })).toHaveAttribute('href', `#/chat/${parent}`)
  await expect(reader.getByRole('link', { name: 'Audit worker' })).toHaveAttribute('href', `#/chat/${child}`)
  await expect(reader.getByText('javascript:alert(1)', { exact: true })).toBeVisible()
  await expect(reader.locator('a[href^="javascript:"], a[href^="file:"]')).toHaveCount(0)
  await expect(reader.getByRole('button')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).reportExecuted)).toBeUndefined()
  expect(f.calls.some(call => ['acknowledge', 'send', 'cancel'].includes(call.op))).toBe(false)
  expect(f.pageErrors).toEqual([])
  await page.screenshot({ path: 'delegated-history.png' })
})

test('pagination and list retry retain last good rows and leave inbox usable', async ({ page }) => {
  const f = await fixture(page)
  await expect(page.getByRole('button', { name: /Historical audit/ })).toBeVisible()
  await page.getByRole('button', { name: 'Older tasks', exact: true }).click()
  await expect(page.getByRole('button', { name: /Historical audit/ })).toHaveCount(0)
  expect(f.calls.filter(c => c.op === 'delegated_tasks').at(-1)?.args).toEqual({ limit: 25, before: 10 })
  await page.getByRole('button', { name: 'Newer tasks', exact: true }).click()
  await expect(page.getByRole('button', { name: /Historical audit/ })).toBeVisible()
  f.setListError(true)
  await page.getByRole('button', { name: 'Refresh delegated work' }).click()
  await expect(page.getByRole('alert')).toContainText('Temporary tasks failure')
  await expect(page.getByRole('button', { name: /Historical audit/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh delegated work' })).toBeEnabled()
  await page.getByRole('group', { name: 'Inbox filters' }).getByRole('button', { name: /^Inbox/ }).click()
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  f.setListError(false)
  await page.getByRole('button', { name: 'Delegated work', exact: true }).click()
  await expect(page.getByRole('button', { name: /Historical audit/ })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('late detail response cannot overwrite a newer selection; failed task has no invented report or receipt', async ({ page }) => {
  const f = await fixture(page); f.holdFirst()
  await page.getByRole('button', { name: /Historical audit/ }).click()
  await expect.poll(() => f.calls.filter(c => c.op === 'delegated_task').length).toBe(1)
  await page.getByRole('button', { name: /Failed investigation/ }).click()
  const reader = page.getByRole('article', { name: 'Delegated work details' })
  await expect(reader.getByRole('heading', { name: 'Failed investigation' })).toBeVisible()
  f.release()
  await expect(reader.getByRole('heading', { name: 'Historical audit' })).toHaveCount(0)
  await expect(reader).toContainText('No report recorded.')
  await expect(reader).toContainText('No receipt recorded.')
  await expect(reader.getByRole('alert')).toContainText('Assigned execution failed before report')
})

test('detail errors preserve saved report, clear loading and retry; invalid chat has no link', async ({ page }) => {
  const f = await fixture(page); f.setBadChat()
  await page.getByRole('button', { name: /Historical audit/ }).click()
  const reader = page.getByRole('article', { name: 'Delegated work details' })
  await expect(reader.getByRole('heading', { name: 'Historical audit' })).toBeVisible()
  await expect(reader.getByRole('link', { name: 'Invalid child' })).toHaveCount(0)
  f.setDetailError(true)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(reader.getByRole('alert')).toContainText('Temporary details failure')
  await expect(reader).toContainText('Saved report')
  await expect(reader.getByText('Loading task details…')).toHaveCount(0)
  f.setDetailError(false)
  await reader.getByRole('button', { name: 'Retry task details' }).click()
  await expect(reader.getByRole('alert')).toHaveCount(0)
})

test('visible section polls; leaving stops requests; empty task history is explicit', async ({ page }) => {
  await page.clock.install()
  const f = await fixture(page)
  await expect(page.getByRole('button', { name: /Historical audit/ })).toBeVisible()
  const initial = f.calls.filter(c => c.op === 'delegated_tasks').length
  await page.clock.runFor(5100)
  await expect.poll(() => f.calls.filter(c => c.op === 'delegated_tasks').length).toBeGreaterThan(initial)
  await page.getByRole('group', { name: 'Inbox filters' }).getByRole('button', { name: /^Inbox/ }).click()
  const count = f.calls.filter(c => c.op === 'delegated_tasks').length
  await page.clock.runFor(11000)
  expect(f.calls.filter(c => c.op === 'delegated_tasks').length).toBe(count)
  f.setEmpty()
  await page.getByRole('button', { name: 'Delegated work', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'No delegated work yet' })).toBeVisible()
})

test('mobile navigation opens task reader and returns to its list', async ({ page }) => {
  // Enter on desktop first so the shared fixture can select the sidebar section.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await fixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: /Historical audit/ }).click()
  await expect(page.getByRole('heading', { name: 'Historical audit' })).toBeFocused()
  await expect(page.getByRole('region', { name: 'Delegated work', exact: true })).toBeHidden()
  await page.getByRole('button', { name: 'Back to delegated work' }).click()
  await expect(page.getByRole('heading', { name: 'Delegated work', exact: true })).toBeFocused()
  await page.screenshot({ path: 'delegated-mobile.png' })
})
