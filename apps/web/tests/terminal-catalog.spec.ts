import { expandTerminalSection } from './terminal-helpers'
import { expect, test } from './fixtures'
import { applyMetadata, reconcileSessions } from '../src/terminals/catalog'
import type { Session, TerminalEvent } from '../src/terminals/connection'

const session = (id: string, revision = '1'): Session => ({
  id,
  name: id,
  revision,
  lifecycle: { state: 'running' },
})

test('catalog updates preserve unchanged objects and reject stale revisions above the JS integer boundary', () => {
  const first = session('one', '9007199254740993')
  const second = session('two')
  const items = [first, second]
  expect(reconcileSessions(items, [{ ...first }, { ...second }])).toBe(items)
  const newer = session('two', '2')
  const next = reconcileSessions(items, [
    session('one', '9007199254740992'),
    newer,
  ])
  expect(next[0]).toBe(first)
  expect(next[1]).toBe(newer)
})

test('leaving the first watched page does not delete a session from the complete catalog', () => {
  const items = Array.from({ length: 101 }, (_, index) =>
    session(String(index))
  )
  const delta: TerminalEvent = {
    type: 'metadata',
    kind: 'sessions',
    payload: {
      item: 'session_delta_batch',
      value: {
        from_revision: '1',
        to_revision: '2',
        order: [],
        total: 101,
        deltas: [
          { kind: 'removed', session_id: '0' },
          { kind: 'updated', session_id: '100', summary: session('100', '2') },
        ],
      },
    },
  }
  const next = applyMetadata(items, delta, false)
  expect(next).toHaveLength(101)
  expect(next.find((item) => item.id === '0')).toBe(items[0])
  expect(next.find((item) => item.id === '100')?.revision).toBe('2')
  expect(applyMetadata(items, { ...delta, scope: 'open' }, false)).toHaveLength(
    100
  )
})

test('healthy complete watches apply deltas without refetching the catalog or replacing the pane', async ({
  page,
}) => {
  const shell = session('live')
  let catalogReads = 0
  let attaches = 0
  let update = () => {}
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    const emit = (message: unknown) => socket.send(JSON.stringify(message))
    emit({ type: 'ready' })
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw))
      if (command.op === 'ack') return
      let result: unknown = null
      if (command.op === 'list') {
        catalogReads++
        result = { items: [shell], total: 1, next_cursor: null }
      }
      if (command.op === 'groups')
        result = { groups: [], defaults: { cwd: '/', shell: '/bin/sh' } }
      if (command.op === 'attach') {
        attaches++
        result = { stream: 'output' }
      }
      if (command.op === 'watch') result = { stream: 'catalog' }
      emit({ type: 'result', id: command.id, result })
      if (command.op === 'watch') {
        emit({
          type: 'metadata',
          kind: 'sessions',
          stream: 'catalog',
          sequence: '1',
          payload: {
            item: 'session_snapshot',
            value: {
              items: [shell],
              total: 1,
              next_cursor: null,
              snapshot_revision: '9007199254740993',
            },
          },
        })
        update = () =>
          emit({
            type: 'metadata',
            kind: 'sessions',
            stream: 'catalog',
            sequence: '2',
            payload: {
              item: 'session_delta_batch',
              value: {
                from_revision: '9007199254740993',
                to_revision: '9007199254740994',
                order: ['live'],
                total: 1,
                deltas: [
                  {
                    kind: 'updated',
                    session_id: 'live',
                    summary: { ...shell, name: 'renamed', revision: '2' },
                  },
                ],
              },
            },
          })
      }
    })
  })
  await page.goto('/#/terminals')
  await expandTerminalSection(page)
  await page.getByRole('button', { name: 'live running', exact: true }).click()
  const emulator = page.locator('.terminal-emulator .xterm')
  await expect(emulator).toHaveCount(1)
  await emulator.evaluate((element) =>
    element.setAttribute('data-kept-instance', 'true')
  )
  const reads = catalogReads
  await page.clock.install()
  update()
  await expect(
    page.getByRole('button', { name: 'renamed running', exact: true })
  ).toBeVisible()
  await page.clock.runFor(5100)
  expect(catalogReads).toBe(reads)
  expect(attaches).toBe(1)
  await expect(emulator).toHaveAttribute('data-kept-instance', 'true')
})

test('a late catalog response cannot resurrect sessions absent from a newer complete watch', async ({
  page,
}) => {
  let finishList = () => {}
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    const emit = (value: unknown) => socket.send(JSON.stringify(value))
    emit({ type: 'ready' })
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw))
      if (command.op === 'ack') return
      if (command.op === 'list') {
        finishList = () =>
          emit({
            type: 'result',
            id: command.id,
            result: {
              items: [session('removed'), session('current')],
              total: 2,
              next_cursor: null,
            },
          })
        return
      }
      emit({
        type: 'result',
        id: command.id,
        result:
          command.op === 'watch'
            ? { stream: 'newer' }
            : { groups: [], defaults: { cwd: '/', shell: '/bin/sh' } },
      })
      if (command.op === 'watch')
        emit({
          type: 'metadata',
          kind: 'sessions',
          stream: 'newer',
          sequence: '1',
          payload: {
            item: 'session_snapshot',
            value: {
              items: [session('current')],
              total: 1,
              next_cursor: null,
              snapshot_revision: '2',
            },
          },
        })
    })
  })
  await page.goto('/#/terminals')
  await expandTerminalSection(page)
  await expect(
    page.getByRole('button', { name: 'current running', exact: true })
  ).toBeVisible()
  await page.clock.install()
  finishList()
  await page.clock.runFor(100)
  await expect(
    page.getByRole('button', { name: 'removed running', exact: true })
  ).toHaveCount(0)
})
