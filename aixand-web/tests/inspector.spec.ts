import { expect, test } from './fixtures'

test('inspects focused sessions, pins, streams events, recovers gaps and resizes', async ({
  page,
}) => {
  const sessions = ['alpha', 'beta'].map((name) => ({
    id: name,
    name,
    lifecycle: { state: 'running' },
    health: { status: 'healthy' },
    foreground: {
      interaction: {
        state: 'requested',
        modality: 'text',
        basis: {
          confidence_basis_points: 9500,
          disposition: 'affirmative',
          source: 'shell',
          evidence_observed_at_millis: Date.now(),
        },
      },
    },
  }))
  const requests: { op: string; args: Record<string, unknown> }[] = []
  let send: (value: object) => void = () => {}
  let detailRequests = 0
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    send = (value) => socket.send(JSON.stringify(value))
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      requests.push(command)
      if (command.op === 'auth') {
        send({ type: 'ready' })
        return
      }
      if (command.op === 'ack') return
      let result: unknown = null
      if (command.op === 'list')
        result = { items: sessions, total: 2, next_cursor: null }
      if (command.op === 'attach')
        result = { stream: `terminal-${command.args.sessionId}` }
      if (command.op === 'inspect') {
        detailRequests++
        result = {
          summary: sessions.find((s) => s.id === command.args.sessionId),
          configuration: {
            metadata: { project: 'inspector-test' },
            environment_variable_names: ['TERM'],
          },
        }
      }
      if (command.op === 'events')
        result = { items: [], checkpoint: '9007199254740993', gap: null }
      if (command.op === 'watch-events') result = { stream: 'events' }
      send({ type: 'result', id: command.id, result })
    })
  })
  await page.goto('/#/terminals')
  await page.getByRole('button', { name: 'alpha running', exact: true }).click()
  await page.getByRole('button', { name: 'Toggle terminal inspector' }).click()
  const inspector = page.getByRole('complementary', {
    name: 'Terminal inspector',
  })
  await expect(inspector).toContainText('95% confidence')
  await inspector.getByRole('button', { name: 'Pin', exact: true }).click()
  await page.getByRole('button', { name: 'beta running', exact: true }).click()
  await expect(inspector.locator('.inspector-target')).toContainText('alpha')
  await inspector.getByRole('button', { name: 'Unpin', exact: true }).click()
  await expect(inspector.locator('.inspector-target')).toContainText('beta')
  await inspector.getByRole('button', { name: 'JSON', exact: true }).click()
  await expect(inspector.locator('pre')).toContainText('inspector-test')
  await expect
    .poll(() =>
      requests.some(
        (r) =>
          r.op === 'watch-events' &&
          r.args.sessionId === 'beta' &&
          r.args.after === '9007199254740993'
      )
    )
    .toBe(true)
  send({
    type: 'metadata',
    kind: 'events',
    stream: 'events',
    sequence: '1',
    payload: {
      item: 'session_event',
      value: {
        session_id: 'beta',
        sequence: '9007199254740994',
        kind: 'interaction_changed',
        occurred_at_millis: Date.now(),
      },
    },
  })
  await inspector.getByRole('button', { name: 'Events', exact: true }).click()
  await expect(inspector).toContainText('interaction_changed')
  await expect
    .poll(() =>
      requests.some((r) => r.op === 'ack' && r.args.stream === 'events')
    )
    .toBe(true)
  const before = detailRequests
  send({ type: 'metadata-gap', kind: 'events', stream: 'events' })
  await expect(inspector).toContainText('Live updates interrupted')
  await expect.poll(() => detailRequests).toBeGreaterThan(before)
  const separator = inspector.getByRole('separator')
  await separator.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(separator).toHaveAttribute('aria-valuenow', '410')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(inspector).toBeVisible()
  expect((await inspector.boundingBox())!.width).toBeLessThanOrEqual(390)
  await inspector
    .getByRole('button', { name: 'Close terminal inspector' })
    .click()
  await expect(inspector).toHaveCount(0)
  await expect
    .poll(() =>
      requests.some((r) => r.op === 'unwatch' && r.args.kind === 'events')
    )
    .toBe(true)
})
