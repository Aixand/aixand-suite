import { expect, test } from './fixtures'
import { terminalStatus } from '../src/terminals/status'
import type { Session } from '../src/terminals/connection'

const observation = (state: string, disposition = 'affirmative') => ({ state, basis: {
  disposition, source: disposition === 'unavailable' ? null : 'profile',
  confidence_basis_points: disposition === 'unavailable' ? 0 : 10000,
  evidence_observed_at_millis: disposition === 'unavailable' ? null : 1,
} })
const session = (id: string, foreground?: Session['foreground']): Session => ({
  id, name: id, revision: '1', lifecycle: { state: 'running' }, foreground, labels: { 'aixand.my_terminal': 'true' },
})

test('lifecycle and exit failures override old foreground observations', () => {
  const active = session('active', { execution: observation('active'), interaction: observation('requested') })
  for (const state of ['starting', 'stopping', 'stopped', 'exited', 'failed'])
    expect(terminalStatus({ ...active, lifecycle: { state } }).state).toBe(state)
  expect(terminalStatus({ ...active, lifecycle: { state: 'exited', code: 2 } }).state).toBe('failed')
  expect(terminalStatus(null).state).toBe('unavailable')
})

test('confirmed input requests distinguish text, private input, choices, and confirmation', () => {
  const requested = { ...observation('requested'), modality: 'text', semantic: 'shell.input' }
  expect(terminalStatus(session('input', { interaction: requested }))).toEqual({ state: 'waiting', label: 'Running · activity unknown · waiting for input' })
  expect(terminalStatus(session('secret', { interaction: { ...requested, modality: 'secret' } })).label).toContain('waiting for private input')
  expect(terminalStatus(session('choice', { interaction: { ...requested, modality: 'options' } })).label).toContain('waiting for a choice')
  expect(terminalStatus(session('permission', { interaction: { ...requested, modality: 'options', semantic: 'codex.workspace_trust' } })).label).toContain('waiting for confirmation')
})

test('running without foreground evidence or an input surface remains visibly alive', () => {
  for (const foreground of [undefined, { execution: observation('unknown', 'unavailable') },
    { interaction: observation('none') }, { interaction: observation('none', 'unavailable') },
    { execution: observation('active', 'unavailable'), interaction: observation('available', 'unavailable') },
    { interaction: observation('requested', 'inference') },
    { interaction: { state: 'requested' } }])
    expect(terminalStatus(session('normal', foreground))).toEqual({ state: 'running', label: 'Running · activity unknown' })
})

test('execution and interaction remain independent, with input requests taking attention', () => {
  const examples: [Session['foreground'], string, string][] = [
    [{ execution: observation('active'), interaction: observation('none') }, 'active', 'Running · active'],
    [{ execution: observation('active'), interaction: observation('available') }, 'active', 'Running · active · input available'],
    [{ execution: observation('active'), interaction: observation('requested') }, 'waiting', 'Running · active · waiting for input'],
    [{ execution: observation('quiescent'), interaction: observation('available') }, 'ready', 'Running · idle · input available'],
    [{ execution: observation('unknown', 'unavailable'), interaction: observation('available') }, 'ready', 'Running · activity unknown · input available'],
    [{ execution: observation('quiescent'), interaction: observation('none') }, 'idle', 'Running · idle'],
    [{ execution: observation('quiescent'), interaction: observation('requested') }, 'waiting', 'Running · idle · waiting for input'],
    [{ execution: observation('active'), constraint: observation('present') }, 'constrained', 'Running · active · runtime constraint present'],
    [{ interaction: observation('requested'), constraint: observation('present') }, 'waiting', 'Running · activity unknown · waiting for input · runtime constraint present'],
  ]
  for (const [foreground, state, label] of examples)
    expect(terminalStatus(session('example', foreground))).toEqual({ state, label })
})

test('inferred observations refine activity without inventing an actionable request', () => {
  expect(terminalStatus(session('active', { execution: observation('active', 'inference'), interaction: observation('none') })))
    .toEqual({ state: 'active', label: 'Running · active (inferred)' })
  expect(terminalStatus(session('idle', { execution: observation('quiescent', 'inference') })))
    .toEqual({ state: 'idle', label: 'Running · idle (inferred)' })
  expect(terminalStatus(session('available', { interaction: observation('available', 'inference') })))
    .toEqual({ state: 'ready', label: 'Running · activity unknown · input available (inferred)' })
  expect(terminalStatus(session('requested', { execution: observation('active'), interaction: observation('requested', 'inference') })))
    .toEqual({ state: 'active', label: 'Running · active' })
  expect(terminalStatus(session('constrained', { constraint: observation('present', 'inference') })))
    .toEqual({ state: 'constrained', label: 'Running · activity unknown · runtime constraint present (inferred)' })
})

test('sidebar dots show activity and update live without replacing the open terminal', async ({ page }) => {
  const sessions = [
    session('working', { execution: observation('active'), interaction: observation('none') }),
    session('waiting', { interaction: { ...observation('requested'), modality: 'text' } }),
    session('ready', { execution: observation('quiescent'), interaction: observation('available') }),
    session('idle', { execution: observation('quiescent') }),
    session('unknown', { execution: observation('unknown', 'unavailable') }),
    session('plain'),
    session('inferred', { execution: observation('active', 'inference'), interaction: observation('none') }),
    session('constrained', { execution: observation('active'), constraint: observation('present') }),
  ]
  const requests: string[] = []
  let update: (foreground: Session['foreground']) => void = () => {}
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
    const emit = (value: unknown) => socket.send(JSON.stringify(value))
    emit({ type: 'ready' })
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      requests.push(command.op)
      if (command.op === 'ack') return
      let result: unknown = null
      if (command.op === 'list') result = { items: sessions, total: sessions.length, next_cursor: null }
      if (command.op === 'groups') result = { groups: [], defaults: { cwd: '/work', shell: '/bin/sh' } }
      if (command.op === 'attach') result = { stream: 'output' }
      if (command.op === 'watch') result = { stream: 'catalog' }
      emit({ type: 'result', id: command.id, result })
      if (command.op === 'watch') {
        emit({ type: 'metadata', kind: 'sessions', stream: 'catalog', sequence: '1', payload: {
          item: 'session_snapshot', value: { items: sessions, total: sessions.length, next_cursor: null, snapshot_revision: '1' },
        } })
        let revision = 1
        update = foreground => {
          const from = String(revision++)
          emit({ type: 'metadata', kind: 'sessions', stream: 'catalog', sequence: String(revision), payload: {
            item: 'session_delta_batch', value: { from_revision: from, to_revision: String(revision), total: sessions.length,
              order: sessions.map(item => item.id), deltas: [{ kind: 'updated', session_id: 'working', summary: {
                ...sessions[0], revision: String(revision), foreground,
              } }] },
          } })
        }
      }
    })
  })
  await page.goto('/#/terminals')
  const row = (name: string) => page.getByRole('button', { name: `${name} running`, exact: true })
  const dot = (name: string) => row(name).locator('.tw-session-status')
  for (const [name, state, description] of [
    ['working', 'active', 'Running · active'], ['waiting', 'waiting', 'Running · activity unknown · waiting for input'],
    ['ready', 'ready', 'Running · idle · input available'], ['idle', 'idle', 'Running · idle'],
    ['unknown', 'running', 'Running · activity unknown'], ['plain', 'running', 'Running · activity unknown'],
    ['inferred', 'active', 'Running · active (inferred)'], ['constrained', 'constrained', 'Running · active · runtime constraint present'],
  ]) {
    await expect(dot(name)).toHaveAttribute('data-status', state)
    await expect(dot(name)).toHaveAttribute('title', description)
    await expect(row(name)).toHaveAccessibleDescription(description)
    expect(await row(name).getAttribute('title')).toContain(description)
    await expect(row(name)).toHaveText(name)
    expect(await dot(name).evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  }
  const workingColor = await dot('working').evaluate(element => getComputedStyle(element).color)
  for (const name of ['idle', 'unknown', 'plain', 'inferred'])
    expect(await dot(name).evaluate(element => getComputedStyle(element).color)).toBe(workingColor)
  for (const name of ['waiting', 'ready', 'constrained'])
    expect(await dot(name).evaluate(element => getComputedStyle(element).color)).not.toBe(workingColor)
  expect(await dot('working').evaluate(element => getComputedStyle(element).boxShadow))
    .not.toBe(await dot('unknown').evaluate(element => getComputedStyle(element).boxShadow))
  await expect(page.getByRole('region', { name: 'Terminals in My terminals', exact: true })).toHaveCSS('max-height', 'none')
  await page.screenshot({ path: 'artifacts/terminal-status/activity.png' })
  await row('working').click()
  const emulator = page.locator('.terminal-emulator .xterm')
  await expect(emulator).toHaveCount(1)
  await emulator.evaluate(element => element.setAttribute('data-retained', 'yes'))
  update({ execution: observation('active'), interaction: { ...observation('requested'), modality: 'text' } })
  await expect(dot('working')).toHaveAttribute('data-status', 'waiting')
  await expect(row('working')).toHaveAccessibleDescription('Running · active · waiting for input')
  update({ execution: observation('unknown', 'unavailable'), interaction: observation('none', 'unavailable') })
  await expect(dot('working')).toHaveAttribute('data-status', 'running')
  await expect(row('working')).toHaveAccessibleDescription('Running · activity unknown')
  expect(await dot('working').evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  await expect(emulator).toHaveAttribute('data-retained', 'yes')
  expect(requests.filter(op => op === 'attach')).toHaveLength(1)
  expect(requests.filter(op => op === 'inspect')).toHaveLength(0)
})
