import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { choose, color, menuState } from './terminal-ui.mjs'

test('menus support navigation, selection, confirmation and cancellation', () => {
  let state = { index: 0, selected: new Set() }
  state = menuState(state, { name: 'up' }, 3, true)
  assert.equal(state.index, 2)
  state = menuState(state, { name: 'space' }, 3, true)
  assert.deepEqual([...state.selected], [2])
  state = menuState(state, { name: 'down' }, 3, true)
  assert.equal(state.index, 0)
  assert.equal(menuState(state, { name: 'return' }, 3, true).done, true)
  assert.equal(menuState(state, { name: 'escape' }, 3, true).cancelled, true)
  assert.equal(menuState(state, { ctrl: true, name: 'c' }, 3, true).cancelled, true)
})

test('color is optional and noninteractive input never confirms a choice', async () => {
  assert.equal(color('Ready', 'success', { isTTY: false }, {}), 'Ready')
  assert.equal(color('Ready', 'success', { isTTY: true }, { NO_COLOR: '' }), 'Ready')
  assert.match(color('Ready', 'success', { isTTY: true }, {}), /\x1b\[32m/)
  await assert.rejects(choose('Remove?', [{ value: true, label: 'Remove' }], { input: { isTTY: false }, output: { isTTY: false } }), /explicit command options/)
})

test('real key events return choices and restore the terminal after success or cancellation', async () => {
  const input = new PassThrough(), output = new PassThrough()
  input.isTTY = true; output.isTTY = true
  input.isRaw = false
  input.setRawMode = value => { input.isRaw = value }
  const choices = [{ value: 'isolated', label: 'Isolated' }, { value: 'shared', label: 'Shared' }]
  const selected = choose('Mode', choices, { input, output })
  input.write('\x1b[B\r')
  assert.equal(await selected, 'shared')
  assert.equal(input.isRaw, false)
  const cancelled = choose('Remove?', choices, { input, output })
  input.emit('keypress', '', { name: 'escape' })
  await assert.rejects(cancelled, /Cancelled/)
  assert.equal(input.isRaw, false)
  assert.equal(input.listenerCount('keypress'), 0)
})
