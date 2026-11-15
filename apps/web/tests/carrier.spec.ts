import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

test.skip(
  !process.env.AIXAND_CARRIER_TEST_ROOT,
  'Run npm run test:carrier with isolated local services',
)
const root = process.env.AIXAND_CARRIER_TEST_ROOT ?? ''
const upstream = process.env.AIXAND_CARRIER_SERVICE_URL ?? ''
function credentials(name: string) {
  return JSON.parse(readFileSync(join(root, name + '.json'), 'utf8'))
}
async function call(name: string, path: string, body?: object) {
  const response = await fetch(upstream + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${credentials(name).token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  expect(response.ok).toBe(true)
  return response.json()
}
async function connect(page: Page) {
  await page.goto('/#/carrier')
  await expect(
    page.getByRole('button', { name: 'Compose', exact: true }),
  ).toBeEnabled()
  await expect(page.locator('.carrier-sidebar .carrier-connection-status')).toHaveText('Connected')
}

test('persistent read/archive preferences converge across tabs and acknowledgment retains history', async ({
  page,
  context,
}) => {
  const incoming = await call('peer', '/send', {
    to: 'suite/local/user',
    content: 'Live inbox review',
    message_id: 'browser-review',
  })
  await connect(page)
  const other = await context.newPage()
  await connect(other)
  await page.getByRole('button', { name: /Live inbox review/ }).click()
  await expect(
    page.getByRole('heading', { name: 'Live inbox review' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await other
    .getByRole('group', { name: 'Inbox filters' })
    .getByRole('button', { name: /^Archived/ })
    .click()
  await expect(
    other.getByRole('button', { name: /Live inbox review/ }),
  ).toBeVisible()
  expect(
    (await call('peer', '/delivery_status?message_id=browser-review')).status,
  ).toBe('stored')
  await page.reload()
  await page
    .getByRole('group', { name: 'Inbox filters' })
    .getByRole('button', { name: /^Archived/ })
    .click()
  await page.getByRole('button', { name: /Live inbox review/ }).click()
  await page.getByRole('button', { name: 'Move to inbox' }).click()
  await page
    .getByRole('group', { name: 'Inbox filters' })
    .getByRole('button', { name: /^Inbox/ })
    .click()
  await page.getByRole('button', { name: /Live inbox review/ }).click()
  await page.getByRole('button', { name: 'Acknowledge', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await call('peer', '/delivery_status?message_id=browser-review'))
          .status,
    )
    .toBe('acknowledged')
  await page.getByRole('button', { name: 'Mark unread', exact: true }).click()
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Home', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Needs you', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('list', { name: 'Work needing you' }).getByRole('link', { name: /Live inbox review/ }),
  ).toHaveCount(0)
  expect(
    (await call('user', '/receive')).messages.some(
      (message: any) => message.id === incoming.id,
    ),
  ).toBe(true)
  await other.close()
})

test('a Carrier reply draft survives other pages and reload without sending until requested', async ({ page, context }) => {
  const text = `Retained reply ${randomUUID()}`
  const original = await call('peer', '/send', { to: 'suite/local/user', content: text, message_id: randomUUID() })
  await connect(page)
  await page.getByRole('button', { name: new RegExp(text) }).click()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  const reply = `Reply kept across navigation ${randomUUID()}`
  await page.getByLabel('Message', { exact: true }).fill(reply)
  const other = await context.newPage()
  await connect(other)
  await other.close()
  await page.getByRole('navigation').getByRole('link', { name: 'Home', exact: true }).click()
  await page.getByRole('navigation').getByRole('link', { name: 'Carrier', exact: true }).click()
  await page.getByRole('button', { name: 'Resume draft', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(reply)
  await page.reload()
  await page.getByRole('button', { name: 'Resume draft', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(reply)
  await expect(page.getByRole('combobox', { name: 'To address', exact: true })).toHaveValue('peer')
  expect((await call('peer', '/receive')).messages.filter((item: any) => item.content === reply)).toHaveLength(0)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.carrier-composer')).toHaveCount(0)
  const received = (await call('peer', '/receive')).messages.filter((item: any) => item.content === reply)
  expect(received).toHaveLength(1)
  expect(received[0].reply_to).toBe(original.id)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Compose', exact: true })).toBeEnabled()
})

test('Carrier retains a draft during storage failures and makes the reload limitation visible', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage && key === 'aixand.carrier.draft.v1') throw new DOMException('Storage full', 'QuotaExceededError')
      return setItem.call(this, key, value)
    }
  })
  await connect(page)
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.getByRole('combobox', { name: 'To address', exact: true }).fill('peer')
  await page.getByLabel('Message', { exact: true }).fill('Kept in memory when storage is full')
  await expect(page.getByRole('alert').filter({ hasText: 'cannot be restored after a reload' })).toBeVisible()
  await page.getByRole('navigation').getByRole('link', { name: 'Home', exact: true }).click()
  await page.getByRole('navigation').getByRole('link', { name: 'Carrier', exact: true }).click()
  await page.getByRole('button', { name: 'Resume draft', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Kept in memory when storage is full')
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Compose', exact: true })).toBeEnabled()
})

test('an unreadable Carrier draft is retained without crashing or starting a send', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('aixand.carrier.draft.v1', '{invalid-draft'))
  await connect(page)
  await expect(page.getByRole('alert').filter({ hasText: 'saved draft could not be restored' })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('aixand.carrier.draft.v1'))).toBe('{invalid-draft')
  await expect(page.locator('.carrier-composer')).toHaveCount(0)
})

test('dark Carrier separates acknowledgment from reading and groups message management', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('aixand.appearance', 'dark'))
  const text = `Dark inbox action ${randomUUID()}`
  const key = randomUUID()
  await call('peer', '/send', { to: 'suite/local/user', content: text, message_id: key })
  await connect(page)
  await page.getByRole('button', { name: new RegExp(text) }).click()
  const actions = page.getByRole('toolbar', { name: 'Message actions', exact: true })
  await expect(actions.getByRole('button', { name: 'Acknowledge', exact: true })).toBeEnabled()
  expect((await call('peer', `/delivery_status?message_id=${key}`)).status).toBe('stored')
  await actions.getByRole('button', { name: 'More message actions', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Archive', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Mark unread', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await actions.getByRole('button', { name: 'Acknowledge', exact: true }).click()
  await expect.poll(async () => (await call('peer', `/delivery_status?message_id=${key}`)).status).toBe('acknowledged')
  await expect(actions.getByRole('button', { name: 'Reply', exact: true })).toBeEnabled()
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
})

test('compose, reply correlation, external sent history and conversation rendering', async ({
  page,
}) => {
  const incoming = await call('peer', '/send', {
    to: 'suite/local/user',
    content: 'Can you review the patch?',
    message_id: 'browser-question',
  })
  await connect(page)
  await page.getByRole('button', { name: /Can you review the patch/ }).click()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(page.getByRole('form', { name: 'Reply to message' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Can you review the patch?' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'To address', exact: true })).toHaveValue('peer')
  await page
    .getByLabel('Message', { exact: true })
    .fill('I will review the patch')
  const accessibility = await new AxeBuilder({ page })
    .include('.carrier-composer')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze()
  expect(accessibility.violations).toEqual([])
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.carrier-composer')).toHaveCount(0)
  const answer = (await call('peer', '/receive')).messages.find(
    (message: any) => message.reply_to === incoming.id,
  )
  expect(answer.content).toBe('I will review the patch')
  await call('peer', '/send', {
    to: 'suite/local/user',
    reply_to: answer.id,
    content: 'Thank you for reviewing',
    message_id: 'browser-thanks',
  })
  await expect(
    page.getByRole('button', { name: /Thank you for reviewing/ }),
  ).toBeVisible()
  await page.getByRole('button', { name: /Thank you for reviewing/ }).click()
  await page.locator('.carrier-history > summary').click()
  await expect(
    page.getByRole('region', { name: 'Conversation' }),
  ).toContainText('I will review the patch')
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.getByRole('combobox', { name: 'To address', exact: true }).fill('peer')
  await page.getByLabel('Message', { exact: true }).fill('A fresh conversation')
  await expect(page.getByRole('listbox')).toBeHidden()
  mkdirSync('artifacts/carrier-live', { recursive: true })
  await page.screenshot({ path: 'artifacts/carrier-live/compose-desktop.png' })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.carrier-composer')).toHaveCount(0)
  await call('user', '/send', {
    to: 'peer',
    content: 'Sent outside the browser',
    message_id: 'external-send',
  })
  await page
    .getByRole('group', { name: 'Inbox filters' })
    .getByRole('button', { name: /^Sent/ })
    .click()
  await expect(
    page.getByRole('button', { name: /Sent outside the browser/ }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Search messages', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search messages' }).fill('fresh conversation')
  await expect(
    page.getByRole('button', { name: /A fresh conversation/ }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Sent outside the browser/ }),
  ).toHaveCount(0)
})

test('Carrier works on mobile and remains accessible in both themes', async ({
  page,
}) => {
  await connect(page)
  for (const mode of ['light', 'dark']) {
    await page.evaluate(
      (value) => localStorage.setItem('aixand.appearance', value),
      mode,
    )
    await page.reload()
    await expect(
      page.getByRole('button', { name: 'Compose', exact: true }),
    ).toBeEnabled()
    for (const width of [1440, 900, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      const result = await new AxeBuilder({ page })
        .include('#main-content')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
      expect(result.violations, `${mode} ${width}`).toEqual([])
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true)
    }
  }
  await page.setViewportSize({ width: 1440, height: 1100 })
  mkdirSync('artifacts/carrier-live', { recursive: true })
  await page.screenshot({
    path: 'artifacts/carrier-live/inbox.png',
    fullPage: true,
  })
  await page.locator('.carrier-message-row').first().click()
  await expect(page.locator('.carrier-subject h2')).toBeVisible()
  await page.screenshot({ path: 'artifacts/carrier-live/conversation-desktop.png' })
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await expect(page.getByRole('button', { name: 'Back to messages' })).toBeVisible()
    await page.getByRole('button', { name: 'Reply', exact: true }).click()
    await expect(page.getByLabel('Message', { exact: true })).toBeFocused()
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole('button', { name: 'Close composer' }).click()
    await page.evaluate(() => { document.documentElement.style.fontSize = '' })
  }
})

test('attached workspace fills the main area and compact search preserves the reader size', async ({ page }) => {
  await call('peer', '/send', { to: 'suite/local/user', content: 'Find this compact search message', message_id: 'compact-search' })
  await call('peer', '/send', { to: 'suite/local/user', content: 'Another inbox message', message_id: 'compact-search-other' })
  await connect(page)
  await expect(page.getByRole('complementary', { name: 'Mailbox navigation' }).getByRole('heading', { name: 'Carrier', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Carrier', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('searchbox', { name: 'Search messages' })).toHaveCount(0)
  const rail = await page.locator('.navigation-rail').boundingBox()
  const sidebar = await page.locator('.carrier-sidebar').boundingBox()
  const main = await page.locator('#main-content').boundingBox()
  const heading = await page.locator('.carrier-list-heading').boundingBox()
  const reader = await page.locator('.carrier-reader').boundingBox()
  expect(sidebar!.x).toBeCloseTo(rail!.x + rail!.width)
  expect(sidebar!.y).toBeCloseTo(main!.y)
  expect(sidebar!.y + sidebar!.height).toBeCloseTo(main!.y + main!.height)
  expect(heading!.y).toBeCloseTo(main!.y)
  const footer = await page.locator('.workspace-sidebar__footer').boundingBox()
  expect(footer!.y + footer!.height).toBeCloseTo(main!.y + main!.height)
  await page.getByRole('button', { name: 'Search messages', exact: true }).click()
  const search = page.getByRole('searchbox', { name: 'Search messages' })
  await expect(search).toBeFocused()
  await search.fill('compact search')
  await expect(page.getByRole('button', { name: /Find this compact search message/ })).toBeVisible()
  await expect(page.locator('.carrier-message-row')).toHaveCount(1)
  const expandedReader = await page.locator('.carrier-reader').boundingBox()
  expect(expandedReader!.y).toBeCloseTo(reader!.y)
  expect(expandedReader!.height).toBeCloseTo(reader!.height)
  mkdirSync('artifacts/carrier-live', { recursive: true })
  await page.screenshot({ path: 'artifacts/carrier-live/search-expanded.png', animations: 'disabled' })
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(search).toBeVisible()
  await search.press('Escape')
  await expect(search).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Search messages', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Search messages', exact: true }).click()
  await search.fill('compact search')
  await page.getByRole('button', { name: 'Close message search' }).click()
  await expect(search).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Search messages', exact: true })).toBeFocused()
  await expect(page.locator('.carrier-message-row')).not.toHaveCount(1)
})

test('mobile drawer contains connection controls and restores focus after composing and resizing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await connect(page)
  const openFolders = page.getByRole('button', { name: 'Open mailboxes and folders' })
  await openFolders.click()
  await expect(page.getByRole('dialog').locator('.carrier-connection-status')).toHaveText('Connected')
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Carrier connection' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Carrier connection' }).click()
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  mkdirSync('artifacts/carrier-live', { recursive: true })
  await page.screenshot({ path: 'artifacts/carrier-live/mobile-folder-drawer.png', animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(openFolders).toBeFocused()
  await openFolders.click()
  await page.getByRole('dialog').getByRole('button', { name: 'Compose', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await openFolders.click()
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeFocused()
})

test('mobile reader preserves list context and a draft can resume after folder navigation', async ({ page }) => {
  await call('peer', '/send', { to: 'suite/local/user', content: 'Mobile conversation review', message_id: 'mobile-review' })
  await page.setViewportSize({ width: 390, height: 844 })
  await connect(page)
  await page.getByRole('button', { name: /Mobile conversation review/ }).click()
  await expect(page.getByRole('heading', { name: 'Mobile conversation review' })).toBeFocused()
  await expect(page.locator('.carrier-list-pane')).toBeHidden()
  await expect(page.locator('.carrier-reader')).toBeVisible()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused()
  await page.getByLabel('Message', { exact: true }).fill('A mobile reply draft')
  await page.getByRole('button', { name: 'Close composer' }).click()
  await page.getByRole('button', { name: 'Back to messages' }).click()
  await expect(page.getByRole('button', { name: /Mobile conversation review/ })).toBeFocused()
  await page.getByRole('button', { name: 'Open mailboxes and folders' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Sent', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Resume draft', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('A mobile reply draft')
  await expect(page.getByRole('combobox', { name: 'To address', exact: true })).toHaveValue('peer')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.carrier-composer')).toHaveCount(0)
  await expect.poll(async () => (await call('peer', '/receive')).messages.some((item: any) => item.content === 'A mobile reply draft')).toBe(true)
  const result = await new AxeBuilder({ page }).include('#main-content').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
  expect(result.violations).toEqual([])
  mkdirSync('artifacts/carrier-live', { recursive: true })
  await page.screenshot({ path: 'artifacts/carrier-live/mobile-conversation.png' })
})

test('connection controls keep cached messages readable and sending requires a connection', async ({ page }) => {
  await connect(page)
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0)
  const firstMessage = page.locator('.carrier-message-row').first()
  await expect(firstMessage).toBeVisible()
  await page.getByRole('button', { name: 'Carrier connection', exact: true }).click()
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.carrier-sidebar .carrier-connection-status')).toHaveText('Disconnected')
  await expect(firstMessage).toBeVisible()
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.getByRole('combobox', { name: 'To address', exact: true }).fill('peer')
  await page.getByLabel('Message', { exact: true }).fill('Offline draft kept in the composer')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Offline draft kept in the composer')
})

test('retrying an interrupted send retains the original recipient, body and operation', async ({ page }) => {
  let interrupted = false
  const attempts: { id: string; args: Record<string, unknown> }[] = []
  await page.routeWebSocket('**/api/carrier/ws', socket => {
    const server = socket.connectToServer()
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      if (command.op === 'send') attempts.push(command)
      server.send(raw)
    })
    server.onMessage(raw => {
      const response = JSON.parse(String(raw))
      if (!interrupted && response.type === 'result' && attempts.some(item => item.id === response.id)) {
        interrupted = true
        socket.close({ code: 1011, reason: 'Interrupted send confirmation' })
        server.close()
      } else socket.send(raw)
    })
  })
  await connect(page)
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.getByRole('combobox', { name: 'To address', exact: true }).fill('peer')
  await page.getByLabel('Message', { exact: true }).fill('Send exactly once despite a lost response')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'To address', exact: true })).toBeDisabled()
  await expect(page.getByLabel('Message', { exact: true })).toBeDisabled()
  await expect(page.locator('.carrier-sidebar .carrier-connection-status')).toHaveText('Connected')
  await page.reload()
  await page.getByRole('button', { name: 'Resume draft', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Send exactly once despite a lost response')
  await expect(page.getByLabel('Message', { exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Retry same send', exact: true }).click()
  await expect(page.locator('.carrier-composer')).toHaveCount(0)
  expect(attempts).toHaveLength(2)
  expect(attempts[1].args).toEqual(attempts[0].args)
  const received = (await call('peer', '/receive')).messages.filter((item: any) => item.content === 'Send exactly once despite a lost response')
  expect(received).toHaveLength(1)
})

test('mailbox switching respects read-only roles and resumes a draft with its original sender', async ({ page }) => {
  const commands: { op: string; args: Record<string, unknown> }[] = []
  const timestamp = new Date().toISOString()
  const makeMessage = (readonly: boolean) => ({ id: readonly ? '502' : '501', title: readonly ? 'Agent mailbox message' : 'Personal mailbox message', source: 'Peer', body: 'A mailbox-specific update.', content: 'A mailbox-specific update.', sender: 'peer', recipient: readonly ? 'agent/demo' : 'suite/local/user', created_at: timestamp, reply_to: null, acknowledged_at: null, read: false, archived: false, direction: 'incoming', metadata: null })
  await page.routeWebSocket('**/api/carrier/ws', socket => {
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      commands.push(command)
      let result: unknown = []
      if (command.op === 'mailboxes') result = [
        { id: 'user', name: 'Your inbox', address: 'suite/local/user', role: 'human' },
        { id: 'agent', name: 'Agent inbox', address: 'agent/demo', role: 'agent' },
      ]
      if (command.op === 'directory') result = { sessions: [{ address: 'peer', name: 'Peer' }], next_after: null }
      if (command.op === 'snapshot') result = { status: { connected: true, syncing: false, version: 1, outgoing_history: true }, messages: [makeMessage(command.args.mailbox === 'agent')], counts: { Inbox: 1, Unread: 1, Pending: 1 }, total: 1, next_offset: null }
      if (command.op === 'conversation') result = { messages: [makeMessage(command.args.mailbox === 'agent')], total: 1, partial: false }
      if (command.op === 'send') result = { status: 'stored', id: 503 }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
    socket.send(JSON.stringify({ type: 'ready' }))
  })
  await connect(page)
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  await page.getByRole('combobox', { name: 'To address', exact: true }).fill('peer')
  await page.getByLabel('Message', { exact: true }).fill('Keep the original sender')
  await page.getByRole('button', { name: 'Close composer' }).click()
  const mailbox = page.locator('.carrier-sidebar').getByRole('button', { name: /Mailbox/ })
  await mailbox.click()
  await page.getByRole('option', { name: /Agent inbox/ }).click()
  await page.getByRole('button', { name: /Agent mailbox message/ }).click()
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Acknowledge', exact: true })).toHaveCount(0)
  expect(commands.some(item => item.op === 'set_message_state' && item.args.mailbox === 'agent')).toBe(false)
  await page.getByRole('button', { name: 'Resume draft', exact: true }).click()
  await expect(mailbox).toContainText('Your inbox')
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep the original sender')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('.carrier-composer')).toHaveCount(0)
  expect(commands.find(item => item.op === 'send')?.args.mailbox).toBe('user')
  await expect(page.getByRole('heading', { name: 'Agent mailbox message', exact: true })).toHaveCount(0)
  await mailbox.click()
  await page.getByRole('option', { name: /Agent inbox/ }).click()
  await expect(page.getByRole('button', { name: 'Compose', exact: true })).toBeDisabled()
})

async function carrierRequest(page: Page, op: string, args: Record<string, unknown>) {
  return page.evaluate(async ({ op, args, id }) => {
    const url = new URL('/api/carrier/ws', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return await new Promise<any>((resolve, reject) => {
      const socket = new WebSocket(url)
      const timeout = setTimeout(() => { socket.close(); reject(new Error('Carrier request timed out')) }, 15000)
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.type === 'ready') socket.send(JSON.stringify({ id, op, args }))
        if (message.id === id) {
          clearTimeout(timeout); socket.close()
          if (message.type === 'error') reject(new Error(message.message))
          else resolve(message.result)
        }
      }
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('Carrier connection failed')) }
      socket.onclose = () => { clearTimeout(timeout); reject(new Error('Carrier response interrupted')) }
    })
  }, { op, args, id: randomUUID() })
}

test('chat resolves a real Carrier reference without switching folders or consuming the message', async ({ page }) => {
  const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const messageKey = randomUUID()
  const incoming = await call('peer', '/send', { to: 'suite/local/user', message_id: messageKey,
    content: JSON.stringify({ schema: 'aixand.carrier', version: 1, kind: 'agent.update', title: 'Chat inbox reference', body: 'The complete live message\nIncludes its second line.' }) })
  const sends: Record<string, unknown>[] = []
  const chat = { id: chatId, provider: 'codex', profile: 'work', auth: null, cwd: '/workspace', project: '', mode: 'chat', title: 'Live inbox context',
    status: 'running', turnId: 'original-turn', createdAt: 1, updatedAt: 2, revision: 1, items: [], requests: [], queue: { paused: false, reason: null, messages: [] } }
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw))
      if (command.op === 'chat-steer') sends.push(command.args)
      const result = command.op === 'catalog' ? { profiles: [{ id: 'codex/work', provider: 'codex', profile: 'work', auth: null, active_runs: 0 }], auths: [], capabilities: [], cwd: chat.cwd } :
        command.op === 'mcp-catalog' ? { servers: [] } : command.op === 'chat-workflow-runs' ? { runs: [], nextOffset: null } :
          command.op === 'chat-list' ? [chat] : ['chat-open', 'chat-steer'].includes(command.op) ? chat : []
      route.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await connect(page)
  await expect(page.getByRole('button', { name: /Chat inbox reference/ })).toBeVisible()
  await page.getByRole('group', { name: 'Inbox filters' }).getByRole('button', { name: /^Archived/ }).click()
  await page.evaluate((id) => { location.hash = `#/chat/${id}` }, chatId)
  const input = page.getByRole('textbox', { name: 'Instructions', exact: true })
  await input.fill('Summarize @inbox/user:chat-inbox-reference')
  await page.getByRole('option', { name: /Chat inbox reference/ }).click()
  await page.getByRole('button', { name: 'Preview inbox message: Chat inbox reference' }).click()
  await expect(page.getByRole('dialog', { name: 'Chat inbox reference' })).toContainText('Includes its second line.')
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await input.press('Enter')
  await expect(input).toHaveValue('')
  expect(sends).toHaveLength(1)
  expect(sends[0].text).toContain('The complete live message\\nIncludes its second line.')
  const instance = (await carrierRequest(page, 'status', {})).instance
  expect(await carrierRequest(page, 'message_get', { id: incoming.id, instance })).toMatchObject({ read: false, archived: false, acknowledged_at: null })
  expect((await call('peer', `/delivery_status?message_id=${messageKey}`)).status).toBe('stored')
  await page.getByRole('navigation').getByRole('link', { name: 'Carrier', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Inbox filters' }).getByRole('button', { name: /^Archived/ })).toHaveAttribute('aria-pressed', 'true')
})

test('Carrier launches a real fixture agent and delivers while its authenticated browser is closed', async ({ page, context }) => {
  await connect(page)
  await carrierRequest(page, 'launch', { key: randomUUID(), provider: 'codex', profile: 'research',
    prompt: 'Validate the Carrier connection', mode: 'chat' })
  await expect.poll(async () => (await call('user', '/receive')).messages.map((message: any) => message.content), { timeout: 40000 })
    .toContain('Reply: Validate the Carrier connection')
  await page.close()
  const sent = (await call('user', '/sent')).messages.find((message: any) => message.content.includes('Validate the Carrier connection'))
  const queued = await call('user', '/send', { to: sent.recipient, content: 'Browser is closed', message_id: 'browser-closed' })
  await expect.poll(async () => (await call('user', `/receive?reply_to=${queued.id}`)).messages.map((message: any) => message.content), { timeout: 40000 })
    .toContain('Reply: Browser is closed')
  const reopened = await context.newPage()
  await connect(reopened)
  await expect(reopened.getByRole('button', { name: /Reply: Browser is closed/ })).toBeVisible()
  await reopened.getByRole('button', { name: 'Agent conversations', exact: true }).click()
  await reopened.locator('.carrier-list-pane').getByRole('button', { name: /Validate the Carrier connection/ }).click()
  await reopened.getByRole('button', { name: 'Stop agent', exact: true }).click()
  await expect(reopened.getByRole('button', { name: 'Stop agent', exact: true })).toHaveCount(0)
})

test('Carrier retries a lost launch response with the same operation and no duplicate agent', async ({ page }) => {
  let lost = false
  const attempts: { id: string; args: { key: string } }[] = []
  await page.routeWebSocket('**/api/carrier/ws', (socket) => {
    const upstreamSocket = socket.connectToServer()
    socket.onMessage((message) => {
      const value = JSON.parse(String(message))
      if (value.op === 'launch') attempts.push(value)
      upstreamSocket.send(message)
    })
    upstreamSocket.onMessage((message) => {
      const value = JSON.parse(String(message))
      if (!lost && value.type === 'result' && attempts.some((item) => item.id === value.id)) {
        lost = true
        socket.close({ code: 1011, reason: 'Fixture interrupted the launch confirmation' })
        upstreamSocket.close()
      } else socket.send(message)
    })
  })
  await connect(page)
  const args = { key: randomUUID(), provider: 'codex', profile: 'research', prompt: 'Launch only once after interruption', mode: 'chat' }
  await expect(carrierRequest(page, 'launch', args)).rejects.toThrow('interrupted')
  await carrierRequest(page, 'launch', args)
  expect(attempts).toHaveLength(2)
  expect(attempts[1].args).toEqual(attempts[0].args)
  const sent = (await call('user', '/sent')).messages.filter((message: any) => message.content === 'Launch only once after interruption')
  expect(sent).toHaveLength(1)
  await expect.poll(async () => (await call('user', '/receive')).messages.map((message: any) => message.content), { timeout: 40000 })
    .toContain('Reply: Launch only once after interruption')
  await page.getByRole('button', { name: 'Agent conversations', exact: true }).click()
  await page.locator('.carrier-list-pane').getByRole('button', { name: /Launch only once after interruption/ }).click()
  await expect(page.getByRole('button', { name: 'Stop agent', exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Stop agent', exact: true }).last().click()
})
