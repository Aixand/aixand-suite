import { expandTerminalSection } from './terminal-helpers'
import { expect, test, type Page, type WebSocketRoute } from './fixtures'

const restoredNotice =
  'Current screen restored. Some earlier output is unavailable.'

async function terminalFixture(page: Page, initialGap = false) {
  const requests: { op: string; args: Record<string, unknown> }[] = []
  const session = {
    id: 'existing-session',
    name: 'development',
    lifecycle: { state: 'running' },
  }
  let socket: WebSocketRoute
  let stream = ''
  let sequence = 0
  let offset = 0n
  let attachments = 0
  let screenMode: 'send' | 'hold' | 'fail' | 'gap' = 'send'
  let resumeFails = false
  let rejectInput = false
  let holdInspect = false
  let closes = 0
  let resumeHolds = false
  const emit = (event: object) => socket.send(JSON.stringify(event))
  const gap = (target = stream) =>
    emit({ type: 'gap', stream: target, reason: 'source_retention_evicted' })
  const interrupt = () =>
    emit({
      type: 'stream-error',
      stream,
      message: 'Output acknowledgement timed out.',
    })
  function output(text: string, skip = false) {
    const bytes = Buffer.from(text)
    const start = offset + (skip ? 10n : 0n)
    offset = start + BigInt(bytes.length)
    emit({
      type: 'output',
      stream,
      sequence: String(++sequence),
      start: String(start),
      offset: String(offset),
      data: bytes.toString('base64'),
    })
  }
  function screen() {
    // Preserve exact checkpoints beyond JavaScript's safe integer range.
    offset = 9007199254740993n
    emit({
      type: 'screen',
      stream,
      sequence: String(++sequence),
      offset: String(offset),
      columns: 80,
      rows: 24,
      cursorRow: 1,
      cursorColumn: 0,
      data: Buffer.from('RESTORED_SCREEN\r\n').toString('base64'),
    })
  }
  await page.routeWebSocket('**/api/terminals/ws', (route) => {
    socket = route
    route.onClose(() => {
      closes++
    })
    emit({ type: 'ready' })
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw))
      requests.push(command)
      if (command.op === 'auth') {
        emit({ type: 'ready' })
        return
      }
      if (command.op === 'ack') return
      if (command.op === 'inspect' && holdInspect) return
      if (command.op === 'input' && rejectInput) {
        rejectInput = false
        emit({
          type: 'error',
          id: command.id,
          code: 'timeout',
          submission: 'admitted',
          retryable: true,
          message: 'Delivery may be uncertain; the action was not retried.',
        })
        return
      }
      if (
        command.op === 'attach' &&
        command.args.screen &&
        screenMode === 'fail'
      ) {
        emit({
          type: 'error',
          id: command.id,
          message: 'Screen snapshot unavailable.',
        })
        return
      }
      let result: unknown = null
      if (command.op === 'list')
        result = { items: [session], next_cursor: null, total: 1 }
      if (command.op === 'groups')
        result = {
          groups: [],
          defaults: { cwd: '/workspace', shell: '/bin/sh' },
        }
      if (command.op === 'attach') {
        stream = `stream-${++attachments}`
        offset = BigInt(command.args.offset)
        result = { stream }
      }
      emit({ type: 'result', id: command.id, result })
      if (command.op === 'attach') {
        if (command.args.screen) {
          if (screenMode === 'send') screen()
          else if (screenMode === 'gap') gap()
        } else if (resumeFails) interrupt()
        else if (initialGap && attachments === 1) gap()
        else if (!resumeHolds) output('CONNECTED_SHELL\r\n')
      }
      if (command.op === 'input')
        output(Buffer.from(command.args.data, 'base64').toString())
    })
  })
  await page.goto('/#/terminals')
  await expandTerminalSection(page)
  await page
    .getByRole('button', { name: 'development running', exact: true })
    .click()
  const pane = page.getByRole('region', {
    name: 'Terminal development',
    exact: true,
  })
  await expect(pane).toContainText(
    initialGap ? 'RESTORED_SCREEN' : 'CONNECTED_SHELL'
  )
  await expect(pane.locator('.tile-indicator')).toHaveClass(/is-live/)
  return {
    pane,
    requests,
    gap,
    interrupt,
    screen,
    output,
    backend: (phase: string) => emit({ type: 'backend-state', phase }),
    rejectInput: () => {
      rejectInput = true
    },
    holdInspect: () => {
      holdInspect = true
    },
    closes: () => closes,
    stream: () => stream,
    snapshotMode: (mode: typeof screenMode) => {
      screenMode = mode
    },
    failResumes: (fail: boolean) => {
      resumeFails = fail
    },
    holdResumes: () => {
      resumeHolds = true
    },
    attaches: () => requests.filter((request) => request.op === 'attach'),
    inputs: () =>
      requests
        .filter((request) => request.op === 'input')
        .map((request) =>
          Buffer.from(request.args.data as string, 'base64').toString()
        )
        .join(''),
    mutations: () =>
      requests.filter((request) =>
        ['create', 'restart', 'stop', 'remove'].includes(request.op)
      ),
  }
}

test('opening a session with expired output restores its screen automatically and allows input', async ({
  page,
}) => {
  const f = await terminalFixture(page, true)
  await expect(f.pane.getByRole('status')).toHaveText(restoredNotice)
  await expect(f.pane.getByRole('alert')).toHaveCount(0)
  await expect(
    f.pane.getByRole('button', { name: 'Restore current screen' })
  ).toHaveCount(0)
  expect(f.attaches().map((request) => request.args.screen)).toEqual([
    false,
    true,
  ])
  await f.pane.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('AFTER_RECOVERY')
  await expect.poll(f.inputs).toBe('AFTER_RECOVERY')
  expect(f.mutations()).toEqual([])
})

test('a missing byte interval restores the screen and resumes at its exact checkpoint', async ({
  page,
}) => {
  const f = await terminalFixture(page)
  f.output('MISSING_INTERVAL', true)
  await expect(f.pane.getByRole('status')).toHaveText(restoredNotice)
  f.output('CONTINUED_OUTPUT\r\n')
  await expect(f.pane).toContainText('CONTINUED_OUTPUT')
  f.interrupt()
  await expect.poll(() => f.attaches().length).toBe(3)
  expect(f.attaches()[2].args.screen).toBe(false)
  expect(BigInt(f.attaches()[2].args.offset as string)).toBeGreaterThan(
    9007199254740993n
  )
  await expect(f.pane.getByRole('status')).toHaveText(restoredNotice)
  expect(f.mutations()).toEqual([])
})

test('a stream interruption resumes output without claiming that history was lost', async ({
  page,
}) => {
  const f = await terminalFixture(page)
  f.interrupt()
  await expect.poll(() => f.attaches().length).toBe(2)
  await expect(f.pane.locator('.tile-indicator')).toHaveClass(/is-live/)
  expect(f.attaches()[1].args.screen).toBe(false)
  expect(BigInt(f.attaches()[1].args.offset as string)).toBeGreaterThan(0n)
  await expect(f.pane.locator('.tile-note')).toHaveCount(0)
  await expect(f.pane.getByRole('alert')).toHaveCount(0)
  expect(f.mutations()).toEqual([])
})

test('input waits for the restored display and stale stream events cannot trigger another recovery', async ({
  page,
}) => {
  const f = await terminalFixture(page)
  f.snapshotMode('hold')
  const oldStream = f.stream()
  f.gap()
  await expect.poll(() => f.attaches().length).toBe(2)
  await expect(f.pane.locator('.tile-indicator')).not.toHaveClass(/is-live/)
  await f.pane.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('DISCARD_THIS')
  f.gap(oldStream)
  f.screen()
  await expect(f.pane.getByRole('status')).toHaveText(restoredNotice)
  await page.keyboard.type('SEND_THIS')
  await expect.poll(f.inputs).toBe('SEND_THIS')
  expect(f.attaches()).toHaveLength(2)
  expect(f.mutations()).toEqual([])
})

test('a quiet recovered connection can automatically recover a later interruption', async ({
  page,
}) => {
  const f = await terminalFixture(page)
  await page.clock.install()
  f.holdResumes()
  f.interrupt()
  await expect.poll(() => f.attaches().length).toBe(2)
  await expect(f.pane.locator('.tile-indicator')).toHaveClass(/is-live/)
  await page.clock.fastForward(1100)
  f.interrupt()
  await expect.poll(() => f.attaches().length).toBe(3)
  await expect(f.pane.getByRole('alert')).toHaveCount(0)
  expect(f.attaches().every((request) => request.args.screen === false)).toBe(
    true
  )
  expect(f.mutations()).toEqual([])
})

test('failed automatic restoration offers a manual retry that does not restart the shell', async ({
  page,
}) => {
  const f = await terminalFixture(page)
  f.snapshotMode('fail')
  f.gap()
  await expect(f.pane.getByRole('alert')).toContainText(
    'Could not restore the current screen. Screen snapshot unavailable.'
  )
  f.snapshotMode('send')
  await f.pane
    .getByRole('button', { name: 'Restore current screen', exact: true })
    .click()
  await expect(f.pane.getByRole('status')).toHaveText(restoredNotice)
  await expect(f.pane.getByRole('alert')).toHaveCount(0)
  expect(f.attaches()).toHaveLength(3)
  expect(f.mutations()).toEqual([])
})

test('a gap during restoration stops automatic retries and leaves a manual recovery action', async ({
  page,
}) => {
  const f = await terminalFixture(page)
  f.snapshotMode('gap')
  f.gap()
  await expect(
    f.pane.getByRole('button', { name: 'Restore current screen', exact: true })
  ).toBeVisible()
  expect(f.attaches()).toHaveLength(2)
  f.snapshotMode('send')
  await f.pane
    .getByRole('button', { name: 'Restore current screen', exact: true })
    .click()
  await expect(f.pane.getByRole('status')).toHaveText(restoredNotice)
  expect(f.mutations()).toEqual([])
})

test('repeated stream failures offer connection retry without a missing-output warning', async ({
  page,
}) => {
  const f = await terminalFixture(page)
  f.failResumes(true)
  f.interrupt()
  await expect(f.pane.getByRole('alert')).toContainText(
    'Output acknowledgement timed out.'
  )
  expect(f.attaches()).toHaveLength(2)
  await expect(
    f.pane.getByRole('button', { name: 'Restore current screen' })
  ).toHaveCount(0)
  f.failResumes(false)
  await f.pane
    .getByRole('button', { name: 'Retry connection', exact: true })
    .click()
  await expect(f.pane.locator('.tile-indicator')).toHaveClass(/is-live/)
  await expect(f.pane.getByRole('alert')).toHaveCount(0)
  await expect(f.pane.locator('.tile-note')).toHaveCount(0)
  expect(f.mutations()).toEqual([])
})

test('an accepted attachment without a screen times out and can be restored manually', async ({
  page,
}) => {
  const f = await terminalFixture(page)
  await page.clock.install()
  f.snapshotMode('hold')
  f.gap()
  await expect.poll(() => f.attaches().length).toBe(2)
  await page.clock.fastForward(10_100)
  await expect(f.pane.getByRole('alert')).toContainText(
    'The current screen did not arrive.'
  )
  f.snapshotMode('send')
  await f.pane
    .getByRole('button', { name: 'Restore current screen', exact: true })
    .click()
  await expect(f.pane.getByRole('status')).toHaveText(restoredNotice)
  expect(f.mutations()).toEqual([])
})

test('SDK recovery on an open WebSocket resumes typing without replacing a healthy stream', async ({
  page,
}) => {
  const f = await terminalFixture(page)
  const closes = f.closes()
  f.backend('recovering')
  await expect(f.pane.getByRole('status')).toHaveText(
    'Reconnecting… typing paused.'
  )
  await f.pane.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('DO_NOT_REPLAY')
  f.output('OUTPUT_DURING_RECOVERY\r\n')
  await expect(f.pane).toContainText('OUTPUT_DURING_RECOVERY')
  f.backend('connected')
  await expect(f.pane.locator('.tile-indicator')).toHaveClass(/is-live/)
  await page.keyboard.type('FRESH_INPUT')
  await expect.poll(f.inputs).toBe('FRESH_INPUT')
  expect(f.attaches()).toHaveLength(1)
  expect(f.closes()).toBe(closes)
})

test('uncertain input is never replayed and does not disable later input', async ({
  page,
}) => {
  const f = await terminalFixture(page)
  const closes = f.closes()
  f.rejectInput()
  await f.pane.locator('.xterm-helper-textarea').focus()
  await f.pane.locator('.xterm-helper-textarea').evaluate((element) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'UNCERTAIN_INPUT')
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, clipboardData })
    )
  })
  await expect(f.pane.getByRole('status')).toContainText(
    'Delivery may be uncertain'
  )
  await page.keyboard.type('FRESH_INPUT')
  await expect.poll(f.inputs).toBe('UNCERTAIN_INPUTFRESH_INPUT')
  expect(f.attaches()).toHaveLength(1)
  expect(f.closes()).toBe(closes)
})

test('an inspector read timeout does not disconnect the terminal workspace', async ({
  page,
}) => {
  const f = await terminalFixture(page)
  await page.clock.install()
  const closes = f.closes()
  f.holdInspect()
  await page.getByRole('button', { name: 'Toggle terminal inspector' }).click()
  await expect
    .poll(() => f.requests.some((request) => request.op === 'inspect'))
    .toBe(true)
  await page.clock.runFor(15_100)
  await expect(
    page.getByRole('complementary', { name: 'Terminal inspector' })
  ).toContainText('The terminal request timed out.')
  await f.pane.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('AFTER_READ_TIMEOUT')
  await expect.poll(f.inputs).toBe('AFTER_READ_TIMEOUT')
  expect(f.closes()).toBe(closes)
})
