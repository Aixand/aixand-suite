import { expandTerminalSection } from './terminal-helpers'
import { expect, test, type WebSocketRoute } from './fixtures'

test('streams bytes, sends keyboard input, resumes, and automatically restores a history gap', async ({
  page,
}) => {
  const requests: { op: string; args: Record<string, unknown> }[] = []
  const session = {
    id: 'session-1',
    name: 'development',
    lifecycle: { state: 'running' },
  }
  let simulateGap = false
  let connectionCount = 0
  let loseConnection = () => {}
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    loseConnection = () => socket.close({ code: 1001, reason: 'Test connection lost' })
    connectionCount++
    const stream = `stream-${connectionCount}`
    let offset = 0
    let sequence = 0
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
      let result: unknown = null
      if (command.op === 'list')
        result = { items: [session], next_cursor: null, total: 1 }
      if (command.op === 'attach') result = { stream, sessionId: session.id }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
      if (command.op === 'attach') {
        offset = Number(command.args.offset ?? 0)
        if (command.args.screen) {
          socket.send(
            JSON.stringify({
              type: 'screen',
              stream,
              sequence: String(++sequence),
              offset: String(offset),
              columns: 80,
              rows: 24,
              data: Buffer.from('RESTORED_SCREEN\r\n').toString('base64'),
            })
          )
        } else if (simulateGap)
          socket.send(
            JSON.stringify({ type: 'gap', stream, reason: 'replay_evicted' })
          )
        else output('CONNECTED_SHELL\r\n')
      }
      if (command.op === 'input')
        output(Buffer.from(command.args.data, 'base64').toString())
    })
  })
  await page.goto('/#/terminals')
  await expandTerminalSection(page)
  await page.getByRole('button', { name: 'development running' }).click()
  await expect(page.locator('.terminal-live')).toContainText('CONNECTED_SHELL')
  await expect(page.locator('.xterm-viewport')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  const attaches = requests.filter((request) => request.op === 'attach').length
  await page.getByRole('button', { name: /^Color mode:/ }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Color mode: Dark' })).toBeFocused()
  await expect(page.locator('.aixand-app')).toHaveAttribute('data-bbb-mode', 'dark')
  await expect(page.locator('.terminal-canvas')).toHaveCSS('background-color', 'rgb(28, 28, 28)')
  await expect(page.locator('.xterm-viewport')).toHaveCSS('background-color', 'rgb(28, 28, 28)')
  await expect(page.locator('.terminal-live')).toContainText('CONNECTED_SHELL')
  expect(requests.filter((request) => request.op === 'attach')).toHaveLength(attaches)
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('echo hello')
  await page.keyboard.press('Control+c')
  await expect
    .poll(() =>
      requests
        .filter((request) => request.op === 'input')
        .map((request) =>
          Buffer.from(request.args.data as string, 'base64').toString()
        )
        .join('')
    )
    .toContain('echo hello\x03')
  await expect
    .poll(() => requests.some((request) => request.op === 'ack'))
    .toBe(true)
  simulateGap = true
  loseConnection()
  await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Disconnected')
  await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Connected')
  await expect(page.locator('.terminal-live')).toContainText('RESTORED_SCREEN')
  const resumes = requests.filter((request) => request.op === 'attach')
  expect(BigInt(resumes[1].args.offset as string)).toBeGreaterThan(0n)
  expect(resumes[2].args.screen).toBe(true)
  await expect(page.getByRole('status')).toContainText('Current screen restored. Some earlier output is unavailable.')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('AFTER_RECOVERY')
  await expect(page.locator('.terminal-live')).toContainText('AFTER_RECOVERY')
  await page.reload()
  await expect(page.getByLabel('Terminal access key')).toHaveCount(0)
})

test('legacy terminal links reach the live Terminals page', async ({
  page,
}) => {
  await page.goto('/#/terminal/release-demo')
  await expect(
    page.getByRole('heading', { name: 'Terminals', exact: true, level: 1 })
  ).toBeVisible()
  await expect(page.getByLabel('Terminal access key')).toHaveCount(0)
})

test('fullscreen is optional and only expands the terminal container', async ({ page }) => {
  await page.routeWebSocket('**/api/terminals/ws', (socket) => socket.close({ code: 1011, reason: 'Fixture backend unavailable' }))
  await page.goto('/#/terminals')
  const topbar = page.locator('.app-body > .topbar')
  const sidebar = page.getByRole('complementary', { name: 'Workspace sidebar' })
  await expect(topbar).toHaveCount(0)
  await expect(sidebar).toBeVisible()
  expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await page.getByRole('button', { name: 'Terminal options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Enter fullscreen', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className))
    .toBe('terminal-workspace')
  await page.getByRole('button', { name: 'Terminal options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Exit fullscreen', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true)
  await expect(page.locator('.tw-topbar')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0)
  await expect(page.locator('.tw-statusbar .tw-connection')).toHaveText('Disconnected')
  await expect(topbar).toHaveCount(0)
  await expect(sidebar).toBeVisible()
})

test('tiles live sessions, preserves panes across tabs, and closes only the chosen pane', async ({
  page,
}) => {
  const commands: { op: string; args: Record<string, unknown> }[] = []
  const sessions = ['alpha', 'beta', 'gamma'].map((name) => ({
    id: name,
    name,
    lifecycle: { state: 'running' },
  }))
  const activeSockets = new Set<WebSocketRoute>()
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    activeSockets.add(socket)
    socket.onClose(() => { activeSockets.delete(socket); socket.close() })
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      commands.push(command)
      if (command.op === 'auth') {
        socket.send(JSON.stringify({ type: 'ready' }))
        return
      }
      if (command.op === 'ack') return
      const result =
        command.op === 'list'
          ? { items: sessions, next_cursor: null, total: sessions.length }
          : command.op === 'attach'
            ? { stream: command.args.paneId }
            : null
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
      if (command.op === 'attach') {
        const data = Buffer.from(`${command.args.sessionId}_OUTPUT\r\n`)
        socket.send(
          JSON.stringify({
            type: 'output',
            stream: command.args.paneId,
            sequence: '1',
            start: '0',
            offset: String(data.length),
            data: data.toString('base64'),
          })
        )
      }
    })
  })
  await page.goto('/#/terminals')
  await expandTerminalSection(page)
  await page.getByRole('button', { name: 'alpha running' }).click()
  const alpha = page.getByRole('region', {
    name: 'Terminal alpha',
    exact: true,
  })
  await expect(alpha).toContainText('alpha_OUTPUT')
  await alpha
    .locator('.terminal-canvas')
    .evaluate((element) => element.setAttribute('data-retained', 'yes'))
  await page
    .getByRole('button', { name: 'beta running' })
    .click({ modifiers: ['Shift'] })
  const beta = page.getByRole('region', { name: 'Terminal beta', exact: true })
  await expect(beta).toContainText('beta_OUTPUT')
  await expect(alpha.locator('.terminal-canvas')).toHaveAttribute(
    'data-retained',
    'yes'
  )
  expect(commands.filter((command) => command.op === 'attach')).toHaveLength(2)
  await page
    .getByRole('button', { name: 'alpha running' })
    .click({ modifiers: ['Shift'] })
  await expect(page.getByRole('region', { name: /^Terminal / })).toHaveCount(2)
  expect(commands.filter((command) => command.op === 'attach')).toHaveLength(2)
  const initialAlpha = await alpha.boundingBox()
  const initialBeta = await beta.boundingBox()
  const beforeMove = commands.filter(
    (command) => command.op === 'detach'
  ).length
  const betaElement = page.locator('section[data-session-id="beta"]')
  async function beginMove() {
    const header = (await beta.locator('.tile-header').boundingBox())!
    await page.mouse.move(header.x + 30, header.y + header.height / 2)
    await page.mouse.down()
    await page.mouse.move(header.x + 45, header.y + header.height / 2, {
      steps: 3,
    })
    await expect(betaElement).toHaveAttribute('data-lifted', 'true')
    await expect(betaElement).toHaveCSS('opacity', '0')
    expect((await alpha.boundingBox())!.width).toBeGreaterThan(
      initialAlpha!.width
    )
  }
  await beginMove()
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(betaElement).not.toHaveAttribute('data-lifted')
  expect(await alpha.boundingBox()).toEqual(initialAlpha)
  expect(await beta.boundingBox()).toEqual(initialBeta)
  async function dropAt(side: 'left' | 'right' | 'top' | 'bottom' | 'center') {
    await beginMove()
    const bounds = (await alpha.boundingBox())!
    const x =
      bounds.x +
      (side === 'left'
        ? 10
        : side === 'right'
          ? bounds.width - 10
          : bounds.width / 2)
    const y =
      bounds.y +
      (side === 'top'
        ? 10
        : side === 'bottom'
          ? bounds.height - 10
          : bounds.height / 2)
    await page.mouse.move(x, y)
    await page.mouse.move(x, y)
    await expect(alpha.locator('.tile-drop-overlay')).toHaveAttribute(
      'data-drop-zone',
      side
    )
    await page.mouse.up()
    await expect(betaElement).not.toHaveAttribute('data-lifted')
  }
  await dropAt('center')
  expect(await alpha.boundingBox()).toEqual(initialAlpha)
  expect(await beta.boundingBox()).toEqual(initialBeta)
  for (const side of ['left', 'top', 'bottom', 'right'] as const) {
    await dropAt(side)
    await expect.poll(async () => {
      const a = (await alpha.boundingBox())!,
        b = (await beta.boundingBox())!
      if (side === 'left') return b.x + b.width < a.x
      if (side === 'right') return a.x + a.width < b.x
      if (side === 'top') return b.y + b.height < a.y
      return a.y + a.height < b.y
    }).toBe(true)
    await expect(alpha.locator('.terminal-canvas')).toHaveAttribute(
      'data-retained',
      'yes'
    )
  }
  expect(commands.filter((command) => command.op === 'attach')).toHaveLength(2)
  expect(commands.filter((command) => command.op === 'detach')).toHaveLength(
    beforeMove
  )
  const firstWidth = (await alpha.boundingBox())!.width
  const divider = page.getByRole('separator', { name: 'Resize columns' })
  const box = (await divider.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 100, box.y + box.height / 2)
  await page.mouse.up()
  expect((await alpha.boundingBox())!.width).toBeGreaterThan(firstWidth + 50)
  await divider.focus()
  await page.keyboard.press('Enter')
  await expect(divider).toHaveAttribute('aria-valuenow', '50')
  await page.getByRole('button', { name: 'Maximize pane beta' }).click()
  await expect(alpha).toBeHidden()
  await page.getByRole('button', { name: 'Restore pane layout' }).click()
  await expect(alpha).toBeVisible()
  await page.getByRole('button', { name: 'New workspace tab' }).click()
  await expect(alpha).toBeHidden()
  await expect(page.getByRole('tab', { name: /Workspace 2/ })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.getByRole('tab', { name: /Workspace 1/ }).click()
  await expect(alpha).toContainText('alpha_OUTPUT')
  await expect(alpha.locator('.terminal-canvas')).toHaveAttribute(
    'data-retained',
    'yes'
  )
  expect(commands.filter((command) => command.op === 'attach')).toHaveLength(2)
  const detachCount = commands.filter(
    (command) => command.op === 'detach'
  ).length
  await page.getByRole('button', { name: 'Close pane beta' }).click()
  await expect(beta).toHaveCount(0)
  await expect(alpha).toBeVisible()
  await expect
    .poll(() => commands.filter((command) => command.op === 'detach').length)
    .toBe(detachCount + 1)
  await expect(page.getByRole('button', { name: 'beta running' })).toBeVisible()
  await page.getByRole('button', { name: 'Split down' }).click()
  await expect(
    page.getByRole('separator', { name: 'Resize rows' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Close pane empty' }).click()
  await expect(page.getByRole('separator', { name: /^Resize (columns|rows)$/ })).toHaveCount(0)
  const targetBounds = (await alpha.boundingBox())!
  const gammaItem = page.getByRole('button', { name: 'gamma running' })
  await gammaItem.dragTo(alpha, {
    targetPosition: { x: targetBounds.width / 2, y: targetBounds.height / 2 },
  })
  await expect(
    page.getByRole('region', { name: 'Terminal gamma', exact: true })
  ).toHaveCount(0)
  await gammaItem.dragTo(alpha, {
    targetPosition: { x: 10, y: targetBounds.height / 2 },
  })
  const gamma = page.getByRole('region', {
    name: 'Terminal gamma',
    exact: true,
  })
  await expect(gamma).toContainText('gamma_OUTPUT')
  expect((await gamma.boundingBox())!.x).toBeLessThan(
    (await alpha.boundingBox())!.x
  )
  expect(activeSockets.size).toBe(1)
})
