import { expandTerminalSection } from './terminal-helpers'
import { expect, test, type Page } from './fixtures'

async function fixture(page: Page) {
  const requests: { op: string; args: Record<string, unknown> }[] = []
  const session = {
    id: 'resize-session',
    name: 'resize-shell',
    lifecycle: { state: 'running' },
  }
  let delayResize = false
  let rejectResize = false
  let finishResize = () => {}
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      requests.push(command)
      if (command.op === 'ack') return
      if (command.op === 'resize' && rejectResize) {
        rejectResize = false
        socket.send(
          JSON.stringify({
            type: 'error',
            id: command.id,
            message: 'Resize was rejected.',
          })
        )
        return
      }
      if (command.op === 'resize' && delayResize) {
        delayResize = false
        finishResize = () =>
          socket.send(
            JSON.stringify({
              type: 'result',
              id: command.id,
              result: null,
            })
          )
        return
      }
      const result =
        command.op === 'list'
          ? { items: [session], next_cursor: null, total: 1 }
          : command.op === 'attach'
            ? { stream: command.args.paneId }
            : null
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
    })
  })
  await page.goto('/#/terminals')
  await expandTerminalSection(page)
  await page.evaluate(() => document.fonts.load('13px "JetBrainsMono Nerd Font Mono"'))
  await page
    .getByRole('button', { name: 'resize-shell running', exact: true })
    .click()
  const pane = page.getByRole('region', {
    name: 'Terminal resize-shell',
    exact: true,
  })
  const resizes = () => requests.filter((request) => request.op === 'resize')
  await expect.poll(() => resizes().length).toBeGreaterThan(0)
  return {
    pane,
    resizes,
    rejectNextResize: () => {
      rejectResize = true
    },
    delayNextResize: () => {
      delayResize = true
    },
    finishResize: () => finishResize(),
  }
}

test('fits the terminal inside the visible content area and sends each new size', async ({
  page,
}) => {
  const { pane, resizes } = await fixture(page)
  async function fits() {
    await expect
      .poll(() =>
        pane.locator('.xterm').evaluate((element) => {
          const screen = element
            .querySelector('.xterm-screen')!
            .getBoundingClientRect()
          const viewport = element.getBoundingClientRect()
          return (
            screen.bottom <= viewport.bottom + 1 &&
            screen.right <= viewport.right + 1
          )
        })
      )
      .toBe(true)
  }
  await fits()
  const initial = resizes().at(-1)!.args
  await page.setViewportSize({ width: 1000, height: 700 })
  await expect
    .poll(() => resizes().at(-1)!.args.columns)
    .toBeLessThan(initial.columns as number)
  await expect
    .poll(() => resizes().at(-1)!.args.rows)
    .toBeLessThan(initial.rows as number)
  await fits()
  const narrow = resizes().at(-1)!.args
  await page.setViewportSize({ width: 1440, height: 1100 })
  await expect.poll(() => resizes().at(-1)!.args).toEqual(initial)
  await fits()

  await page.getByRole('button', { name: 'Split right', exact: true }).click()
  await expect
    .poll(() => resizes().at(-1)!.args.columns)
    .toBeLessThan(narrow.columns as number)
  await fits()
  await pane.getByRole('button', { name: 'Maximize pane resize-shell' }).click()
  await expect.poll(() => resizes().at(-1)!.args).toEqual(initial)
  await fits()
  await page.getByRole('button', { name: 'Restore pane layout' }).click()
  await expect
    .poll(() => resizes().at(-1)!.args.columns)
    .toBeLessThan(initial.columns as number)
  await fits()
})

test('a rejected resize leaves the output stream and keyboard usable', async ({
  page,
}) => {
  const { pane, resizes, rejectNextResize } = await fixture(page)
  rejectNextResize()
  await page.setViewportSize({ width: 1000, height: 700 })
  await expect(pane.getByRole('status')).toContainText('Resize was rejected.')
  await expect(pane.locator('.tile-indicator')).toHaveClass(/is-live/)
  await expect
    .poll(() =>
      pane
        .locator('.xterm-helper-textarea')
        .evaluate((element) => !(element as HTMLTextAreaElement).disabled)
    )
    .toBe(true)
  const rejected = resizes().length
  await page.setViewportSize({ width: 1440, height: 1100 })
  await expect.poll(() => resizes().length).toBeGreaterThan(rejected)
})

test('coalesces layout changes while the backend is acknowledging a resize', async ({
  page,
}) => {
  const { pane, resizes, delayNextResize, finishResize } = await fixture(page)
  const initialCount = resizes().length
  const initialColumns = resizes().at(-1)!.args.columns as number
  delayNextResize()
  await page.setViewportSize({ width: 1000, height: 700 })
  await expect.poll(() => resizes().length).toBe(initialCount + 1)
  const narrowColumns = resizes().at(-1)!.args.columns as number
  const screenWidth = await pane
    .locator('.xterm-screen')
    .evaluate((element) => element.clientWidth)
  await page.setViewportSize({ width: 1200, height: 850 })
  await expect
    .poll(() =>
      pane.locator('.xterm-screen').evaluate((element) => element.clientWidth)
    )
    .toBeGreaterThan(screenWidth)
  expect(resizes()).toHaveLength(initialCount + 1)
  finishResize()
  await expect.poll(() => resizes().length).toBe(initialCount + 2)
  const latestColumns = resizes().at(-1)!.args.columns as number
  expect(latestColumns).toBeGreaterThan(narrowColumns)
  expect(latestColumns).toBeLessThan(initialColumns)
})
