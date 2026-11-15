import { expect, test, type Page, type WebSocketRoute } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import { createHash } from 'node:crypto'
import type { ChatSnapshot } from '../src/chats/model'

const chatId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const childId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const grandchildId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const detachedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const title = 'Review the chat layout'

async function historyFixture(page: Page, options: {
  failDelete?: boolean; child?: boolean; grandchild?: boolean; detached?: boolean
  failPreview?: boolean; blockChild?: boolean; omitBroadcast?: boolean; hiddenChild?: boolean
  remoteWork?: boolean; workflowWork?: boolean; failStop?: boolean
} = {}) {
  const chat: ChatSnapshot = {
    id: chatId, provider: 'codex', profile: 'work', auth: null, cwd: '/workspace/aixand', project: 'Aixand',
    mode: 'work', title, status: 'completed', createdAt: 1, updatedAt: 2, revision: 1,
    items: [{ id: 'reply', type: 'agentMessage', text: 'The review is complete.' }], requests: [],
  }
  let chats: ChatSnapshot[] = [chat,
    ...(options.child || options.hiddenChild ? [{ ...chat, id: childId, title: 'Follow-up review', originChatId: chatId, parentChatId: chatId }] : []),
    ...(options.grandchild ? [{ ...chat, id: grandchildId, title: 'Nested follow-up', originChatId: childId, parentChatId: childId }] : []),
    ...(options.detached ? [{ ...chat, id: detachedId, title: 'Independent review', originChatId: chatId, parentChatId: null }] : []),
  ]
  function tree(id: string) {
    const ids = new Set([id])
    for (const parent of ids) for (const row of chats)
      if ((row.parentChatId === undefined ? row.originChatId : row.parentChatId) === parent) ids.add(row.id)
    return [...ids]
  }
  function preview(id: string) {
    const ids = tree(id)
    return { chatId: id, childCount: ids.length - 1,
      previewToken: createHash('sha256').update(JSON.stringify(ids.sort())).digest('hex'),
      activity: Object.fromEntries(['conversation', 'subtree'].map(scope => [scope, { remote: Boolean(options.remoteWork),
        hasWork: Boolean(options.remoteWork || options.workflowWork), activeChatIds: options.remoteWork ? [id] : [],
        workflowIds: options.workflowWork ? ['JOB-fixture'] : [] }])) }
  }
  const operations: { op: string; args: Record<string, unknown> }[] = []
  let failed = false
  let previewFailed = false
  let socket: WebSocketRoute
  await page.routeWebSocket('**/api/carrier/ws', (route) => {
    route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {})
  })
  await page.routeWebSocket('**/api/agents/ws', (route) => {
    socket = route
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.op === 'auth') { route.send(JSON.stringify({ type: 'ready' })); return }
      operations.push(message)
      if (message.op === 'chat-delete-preview' && options.failPreview && !previewFailed) {
        previewFailed = true
        route.send(JSON.stringify({ type: 'error', id: message.id, message: 'Could not check child conversations. Try again.' }))
        return
      }
      if (message.op === 'chat-delete-stop' && options.failStop) {
        route.send(JSON.stringify({ type: 'error', id: message.id, message: 'Stop could not be confirmed. You can still delete the conversation without stopping its work.' }))
        return
      }
      if (message.op === 'chat-delete') {
        if (options.failDelete && !failed) {
          failed = true
          route.send(JSON.stringify({ type: 'error', id: message.id, message: 'Connection interrupted. Try again.' }))
          return
        }
        const error = message.args.previewToken !== preview(message.args.chatId).previewToken ?
          'Child conversations changed. Review the deletion again before confirming.' :
          options.blockChild && message.args.scope === 'subtree' ? 'Return control from the terminal before deleting this conversation.' : ''
        if (error) {
          route.send(JSON.stringify({ type: 'error', id: message.id, message: error }))
          return
        }
        const deletedIds = message.args.scope === 'subtree' ? tree(message.args.chatId) : [message.args.chatId]
        chats = chats.filter((row) => !deletedIds.includes(row.id)).map((row) =>
          deletedIds.includes(row.parentChatId) ? { ...row, parentChatId: null } : row)
        if (!options.omitBroadcast) for (const id of deletedIds) route.send(JSON.stringify({ type: 'chat-deleted', chatId: id }))
        route.send(JSON.stringify({ type: 'result', id: message.id, result: { chatId: message.args.chatId, deleted: true, deletedIds } }))
        return
      }
      const result = message.op === 'catalog' ? {
        profiles: [{ id: 'codex/work', profile: 'work', provider: 'codex', auth: null, active_runs: 0 }],
        auths: [], capabilities: [], cwd: chat.cwd,
      } : message.op === 'chat-delete-preview' ? preview(message.args.chatId) :
        message.op === 'chat-list' ? chats.filter(row => !options.hiddenChild || row.id !== childId) : message.op === 'project-list' ? [{ id: 'project-ui', name: 'Aixand', path: chat.cwd }] :
        message.op === 'chat-open' ? chats.find((row) => row.id === message.args.chatId) :
        ['chat-launches', 'models', 'sessions', 'mcp-jobs'].includes(message.op) ? [] :
        message.op === 'mcp-catalog' ? { servers: [] } : {}
      route.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  await page.goto('/#/chat')
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toBeVisible()
  const mobile = page.getByRole('button', { name: 'Show chat history', exact: true })
  if (await mobile.isVisible()) await mobile.click()
  const history = page.getByRole('navigation', { name: 'Chat history', exact: true })
  const item = history.getByRole('button', { name: new RegExp(`^${title}`) })
  await expect(item).toBeVisible()
  return { history, item, operations, emitDeletion: () => socket.send(JSON.stringify({ type: 'chat-deleted', chatId })),
    addChild: () => {
      const row = { ...chat, id: grandchildId, title: 'New child', parentChatId: chatId }
      chats.push(row)
      socket.send(JSON.stringify({ type: 'chat-created', chat: row }))
    },
  }
}

test('hover actions are on the right and cancellation preserves the conversation', async ({ page }) => {
  const { history, item, operations } = await historyFixture(page)
  const remove = history.getByRole('button', { name: `Conversation actions for ${title}`, exact: true })
  await expect(remove).toHaveCSS('opacity', '0')
  await item.hover()
  await expect(remove).toHaveCSS('opacity', '1')
  await page.screenshot({ path: 'artifacts/chat-delete/hover.png', fullPage: true })
  const itemBounds = (await item.boundingBox())!
  const deleteBounds = (await remove.boundingBox())!
  expect(deleteBounds.x).toBeGreaterThan(itemBounds.x + itemBounds.width / 2)
  await remove.click()
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete conversation?' })
  await expect(dialog).toContainText(title)
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(item).toBeVisible()
  expect(operations.filter((op) => op.op === 'chat-delete')).toHaveLength(0)
  await remove.click()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(operations.filter((op) => op.op === 'chat-delete')).toHaveLength(0)
})

test('right-click deletion confirms, removes the open conversation and stays removed on reload', async ({ page }) => {
  const { history, item, operations } = await historyFixture(page)
  await item.click()
  await expect(page).toHaveURL(`/#/chat/${chatId}`)
  await item.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Conversation actions' })
  await expect(menu).toBeVisible()
  await page.screenshot({ path: 'artifacts/chat-delete/context-menu.png', fullPage: true })
  expect(operations.filter((op) => op.op === 'chat-delete')).toHaveLength(0)
  await menu.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete conversation?' })
  await expect(dialog).toBeVisible()
  expect(operations.filter((op) => op.op === 'chat-delete')).toHaveLength(0)
  await dialog.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(item).toHaveCount(0)
  await expect(page).toHaveURL('/#/chat')
  await expect(page.getByRole('heading', { name: 'Where should we start?', exact: true })).toBeVisible()
  expect(operations.filter((op) => op.op === 'chat-delete')).toHaveLength(1)
  await expect(history.getByRole('button', { name: 'Aixand, 0 conversations', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Search history', exact: true }).click()
  const search = page.getByRole('dialog', { name: 'Search history', exact: true })
  await search.getByRole('searchbox').fill(title)
  await expect(search.getByRole('menuitem', { name: new RegExp(title) })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByRole('region', { name: 'Recent conversations', exact: true })).toContainText('Your conversations will appear here.')
})

test('context menu supports keyboard activation and dismisses without deleting', async ({ page }) => {
  const { item, operations } = await historyFixture(page)
  await item.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Conversation actions' })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(item).toBeFocused()
  await item.click({ button: 'right' })
  const outside = (await page.locator('.command-welcome h1').boundingBox())!
  await page.mouse.click(outside.x + outside.width / 2, outside.y + outside.height / 2)
  await expect(menu).toHaveCount(0)
  expect(operations.filter((op) => op.op === 'chat-delete')).toHaveLength(0)
})

test('failed deletion keeps the conversation and retries the same operation', async ({ page }) => {
  const { history, item, operations } = await historyFixture(page, { failDelete: true })
  await item.hover()
  await history.getByRole('button', { name: `Conversation actions for ${title}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete conversation?' })
  await dialog.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Connection interrupted. Try again.')
  await expect(item).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await expect(item).toHaveCount(0)
  const attempts = operations.filter((op) => op.op === 'chat-delete')
  expect(attempts).toHaveLength(2)
  expect(attempts[0].args.key).toBe(attempts[1].args.key)
})

test('deleting a parent preserves its child conversation and broadcasts update the open chat', async ({ page }) => {
  const { history, item, emitDeletion } = await historyFixture(page, { child: true })
  await item.click()
  emitDeletion()
  await expect(item).toHaveCount(0)
  await expect(page).toHaveURL('/#/chat')
  await expect(history.getByRole('button', { name: /^Follow-up review/ })).toBeVisible()
})

async function openDeletion(page: Page, item: ReturnType<Page['getByRole']>) {
  await item.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
  return page.getByRole('alertdialog', { name: 'Delete child conversations too?', exact: true })
}

test('parent deletion asks about children before confirmation and resets after cancellation', async ({ page }) => {
  const { item, operations } = await historyFixture(page, { child: true, grandchild: true })
  const choice = await openDeletion(page, item)
  await expect(choice).toContainText('2 attached child conversations')
  expect(operations.filter(op => op.op === 'chat-delete')).toHaveLength(0)
  await choice.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(item).toBeVisible()
  await openDeletion(page, item)
  await choice.getByRole('button', { name: 'Include children', exact: true }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Delete conversation?', exact: true })
  await expect(confirm).toContainText('All 3 conversations will be removed')
  expect(operations.filter(op => op.op === 'chat-delete')).toHaveLength(0)
  await confirm.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(choice).toBeVisible()
  await choice.getByRole('button', { name: 'Keep children', exact: true }).click()
  await expect(confirm).toContainText('child conversations will remain as independent conversations')
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  await openDeletion(page, item)
  await expect(choice).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(choice).toHaveCount(0)
  expect(operations.filter(op => op.op === 'chat-delete')).toHaveLength(0)
})

test('keeping children deletes only the parent and preserves the open child on reload', async ({ page }) => {
  const { history, item, operations } = await historyFixture(page, { child: true, grandchild: true })
  await page.getByRole('button', { name: `Expand sessions spawned from ${title}`, exact: true }).click()
  const child = history.getByRole('button', { name: /^Follow-up review/ })
  await child.click()
  await expect(page).toHaveURL(`/#/chat/${childId}`)
  const choice = await openDeletion(page, item)
  await choice.getByRole('button', { name: 'Keep children', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'Delete conversation?', exact: true })
    .getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await expect(item).toHaveCount(0)
  await expect(child).toBeVisible()
  await expect(page).toHaveURL(`/#/chat/${childId}`)
  const request = operations.find(op => op.op === 'chat-delete')!
  expect(request.args.scope).toBe('conversation')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Follow-up review', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Expand sessions spawned from Follow-up review', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Recent conversations' })).toContainText('Nested follow-up')
})

test('including children removes nested descendants and the open child while preserving detached chats', async ({ page }) => {
  const { history, item, operations } = await historyFixture(page, { child: true, grandchild: true, detached: true, omitBroadcast: true })
  await page.getByRole('button', { name: `Expand sessions spawned from ${title}`, exact: true }).click()
  await history.getByRole('button', { name: /^Follow-up review/ }).click()
  const choice = await openDeletion(page, item)
  await choice.getByRole('button', { name: 'Include children', exact: true }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Delete conversation?', exact: true })
  await confirm.getByRole('button', { name: 'Delete all 3 conversations', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(item).toHaveCount(0)
  await expect(page).toHaveURL('/#/chat')
  await expect(history.getByRole('button', { name: /^Independent review/ })).toBeVisible()
  await expect(history.getByRole('button', { name: /^Follow-up review|^Nested follow-up/ })).toHaveCount(0)
  expect(operations.filter(op => op.op === 'chat-delete')).toHaveLength(1)
  expect(operations.find(op => op.op === 'chat-delete')!.args.scope).toBe('subtree')
  await page.getByRole('button', { name: 'Search history', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search history', exact: true }).fill('Follow-up')
  await expect(page.getByRole('menuitem', { name: /Follow-up review|Nested follow-up/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.reload()
  const recent = page.getByRole('region', { name: 'Recent conversations', exact: true })
  await expect(recent).toContainText('Independent review')
  await expect(recent).not.toContainText(title)
  await expect(recent).not.toContainText('Follow-up review')
})

test('child counts come from the server even when a child is absent from loaded history', async ({ page }) => {
  const { item, operations } = await historyFixture(page, { hiddenChild: true })
  const choice = await openDeletion(page, item)
  await expect(choice).toContainText('1 attached child conversation')
  await choice.getByRole('button', { name: 'Include children', exact: true }).click()
  await page.getByRole('button', { name: 'Delete all 2 conversations', exact: true }).click()
  await expect(item).toHaveCount(0)
  expect(operations.filter(op => op.op === 'chat-delete')).toHaveLength(1)
})

test('a changed family requires a new choice and confirmation', async ({ page }) => {
  const { item, operations, addChild } = await historyFixture(page, { child: true })
  const choice = await openDeletion(page, item)
  await choice.getByRole('button', { name: 'Include children', exact: true }).click()
  addChild()
  await page.getByRole('button', { name: 'Delete all 2 conversations', exact: true }).click()
  await expect(choice).toBeVisible()
  await expect(choice.getByRole('alert')).toContainText('Child conversations changed')
  await expect(choice).toContainText('2 attached child conversations')
  await expect(item).toBeVisible()
  await choice.getByRole('button', { name: 'Include children', exact: true }).click()
  await page.getByRole('button', { name: 'Delete all 3 conversations', exact: true }).click()
  await expect(item).toHaveCount(0)
  const attempts = operations.filter(op => op.op === 'chat-delete')
  expect(attempts).toHaveLength(2)
  expect(attempts[0].args.key).not.toBe(attempts[1].args.key)
  expect(attempts[0].args.previewToken).not.toBe(attempts[1].args.previewToken)
})

test('a failed group deletion retries the same confirmed scope and request key', async ({ page }) => {
  const { item, operations } = await historyFixture(page, { child: true, failDelete: true })
  const choice = await openDeletion(page, item)
  await choice.getByRole('button', { name: 'Include children', exact: true }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Delete conversation?', exact: true })
  await confirm.getByRole('button', { name: 'Delete all 2 conversations', exact: true }).click()
  await expect(confirm.getByRole('alert')).toContainText('Connection interrupted')
  await expect(item).toBeVisible()
  await confirm.getByRole('button', { name: 'Delete all 2 conversations', exact: true }).click()
  await expect(item).toHaveCount(0)
  const attempts = operations.filter(op => op.op === 'chat-delete')
  expect(attempts).toHaveLength(2)
  expect(attempts[0].args).toEqual(attempts[1].args)
})

test('a blocked child keeps the whole group and permits switching to parent-only deletion', async ({ page }) => {
  const { history, item, operations } = await historyFixture(page, { child: true, blockChild: true })
  const choice = await openDeletion(page, item)
  await choice.getByRole('button', { name: 'Include children', exact: true }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Delete conversation?', exact: true })
  await confirm.getByRole('button', { name: 'Delete all 2 conversations', exact: true }).click()
  await expect(confirm.getByRole('alert')).toContainText('Return control from the terminal')
  await expect(item).toBeVisible()
  await confirm.getByRole('button', { name: 'Back', exact: true }).click()
  await choice.getByRole('button', { name: 'Keep children', exact: true }).click()
  await confirm.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await expect(item).toHaveCount(0)
  await expect(history.getByRole('button', { name: /^Follow-up review/ })).toBeVisible()
  const attempts = operations.filter(op => op.op === 'chat-delete')
  expect(attempts[0].args.key).not.toBe(attempts[1].args.key)
})

test('a failed preview can be retried without enabling deletion prematurely', async ({ page }) => {
  const { item, operations } = await historyFixture(page, { child: true, failPreview: true })
  await item.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('alert')).toContainText('Could not check child conversations')
  await expect(dialog.getByRole('button', { name: 'Delete conversation', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('alertdialog', { name: 'Delete child conversations too?', exact: true })).toBeVisible()
  expect(operations.filter(op => op.op === 'chat-delete')).toHaveLength(0)
})

test.describe('touch devices', () => {
  test.use({ hasTouch: true })

  test('mobile history exposes deletion and the confirmation is accessible', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const { history, item } = await historyFixture(page)
    const remove = history.getByRole('button', { name: `Conversation actions for ${title}`, exact: true })
    await expect(remove).toHaveCSS('opacity', '1')
    await remove.tap()
    await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).tap()
    const dialog = page.getByRole('alertdialog', { name: 'Delete conversation?' })
    await expect(dialog).toBeVisible()
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: 'artifacts/chat-delete/mobile-confirmation.png', fullPage: true })
    await dialog.getByRole('button', { name: 'Delete conversation', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Chat history' })).toBeVisible()
    await expect(item).toHaveCount(0)
  })

  test('both child-deletion steps are accessible on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const { history, item } = await historyFixture(page, { child: true, grandchild: true })
    await history.getByRole('button', { name: `Conversation actions for ${title}`, exact: true }).tap()
    await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).tap()
    const choice = page.getByRole('alertdialog', { name: 'Delete child conversations too?', exact: true })
    await expect(choice).toBeVisible()
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.screenshot({ path: 'artifacts/chat-delete/mobile-child-choice.png', fullPage: true })
    await choice.getByRole('button', { name: 'Include children', exact: true }).tap()
    const confirm = page.getByRole('alertdialog', { name: 'Delete conversation?', exact: true })
    await expect(confirm).toContainText('All 3 conversations will be removed')
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.screenshot({ path: 'artifacts/chat-delete/mobile-child-confirmation.png', fullPage: true })
    await confirm.getByRole('button', { name: 'Delete all 3 conversations', exact: true }).tap()
    await expect(item).toHaveCount(0)
  })
})


test('offline work does not block removing conversation history', async ({ page }) => {
  const { item, operations } = await historyFixture(page, { remoteWork: true })
  await item.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete conversation?' })
  await expect(dialog).toContainText('If the device is offline, that work may continue')
  await dialog.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await expect(item).toHaveCount(0)
  expect(operations.filter(operation => operation.op === 'chat-delete-stop')).toHaveLength(0)
})

test('an unconfirmed stop keeps ordinary deletion available', async ({ page }) => {
  const { item, operations } = await historyFixture(page, { remoteWork: true, failStop: true })
  await item.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete conversation?' })
  await dialog.getByRole('button', { name: 'Stop and delete', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Stop could not be confirmed')
  await expect(item).toBeVisible()
  expect(operations.filter(operation => operation.op === 'chat-delete')).toHaveLength(0)
  await dialog.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await expect(item).toHaveCount(0)
})

test('workflow cancellation has an explicit label and precedes history deletion', async ({ page }) => {
  const { item, operations } = await historyFixture(page, { workflowWork: true })
  await item.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete conversation?' })
  await expect(dialog).toContainText('including later tasks')
  await dialog.getByRole('button', { name: 'Cancel workflow and delete', exact: true }).click()
  await expect(item).toHaveCount(0)
  const actions = operations.filter(operation => ['chat-delete-stop', 'chat-delete'].includes(operation.op))
  expect(actions.map(operation => operation.op)).toEqual(['chat-delete-stop', 'chat-delete'])
})
