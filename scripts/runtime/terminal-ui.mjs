// Terminal controls for setup and maintenance. No application state is stored here.
import { emitKeypressEvents } from 'node:readline'
import { stdin, stdout } from 'node:process'

export function color(text, kind = 'info', output = stdout, env = process.env) {
  if (!output.isTTY || 'NO_COLOR' in env || env.TERM === 'dumb') return text
  const code = { info: 36, success: 32, warning: 33, error: 31, selected: 1 }[kind] || 0
  return `\x1b[${code}m${text}\x1b[0m`
}

export function menuState(state, key, count, multiple) {
  if (key.name === 'escape' || key.ctrl && key.name === 'c') return { ...state, cancelled: true }
  if (key.name === 'up') return { ...state, index: (state.index + count - 1) % count }
  if (key.name === 'down') return { ...state, index: (state.index + 1) % count }
  if (multiple && key.name === 'space') {
    const selected = new Set(state.selected)
    if (selected.has(state.index)) selected.delete(state.index)
    else selected.add(state.index)
    return { ...state, selected }
  }
  if (multiple && key.name === 'a') return { ...state, selected: state.selected.size === count ? new Set() : new Set(Array.from({ length: count }, (_value, index) => index)) }
  if (key.name === 'return') return { ...state, done: true }
  return state
}

export async function choose(title, choices, { multiple = false, initial, input = stdin, output = stdout } = {}) {
  if (!choices.length) throw new Error('No choices are available.')
  if (!input.isTTY || !output.isTTY) throw new Error('Use explicit command options outside an interactive terminal.')
  let state = { index: Math.max(0, choices.findIndex(row => row.value === initial)), selected: new Set() }
  let lines = 0
  const plain = process.env.TERM === 'dumb'
  const clip = text => {
    const width = Math.max(16, (output.columns || 80) - 2)
    const clean = String(text).replace(/[\x00-\x1f\x7f]/g, ' ')
    let result = '', used = 0
    for (const character of clean) {
      used += character.codePointAt(0) > 255 ? 2 : 1
      if (used > width - 3) return result + '...'
      result += character
    }
    return result
  }
  const render = () => {
    if (lines && !plain) output.write(`\x1b[${lines}A\x1b[J`)
    const height = Math.max(3, (output.rows || 24) - 5)
    const start = Math.min(Math.max(0, state.index - height + 1), Math.max(0, choices.length - height))
    const rows = [clip(title), ...choices.slice(start, start + height).map((row, offset) => {
      const index = start + offset
      const marker = multiple ? (state.selected.has(index) ? '[x]' : '[ ]') : (state.index === index ? '>' : ' ')
      const line = `${state.index === index && multiple ? '>' : ' '} ${marker} ${row.label}${row.detail ? ' — ' + row.detail : ''}`
      return state.index === index ? color(clip(line), 'info', output) : clip(line)
    }), clip(`${state.index + 1}/${choices.length}` + (multiple ? '  Space: select  A: all' : '  Up/Down: move')), clip('Enter: continue  Esc: cancel')]
    output.write(rows.join('\n') + '\n'); lines = rows.length
  }
  const raw = input.isRaw
  emitKeypressEvents(input)
  input.setRawMode(true)
  input.resume()
  output.write(plain ? '' : '\x1b[?25l')
  try {
    render()
    return await new Promise((resolve, reject) => {
      const finish = (error, result) => {
        input.removeListener('keypress', press)
        input.removeListener('end', ended)
        input.removeListener('error', failed)
        if (error) reject(error); else resolve(result)
      }
      const ended = () => finish(new Error('Input closed. No choice was confirmed.'))
      const failed = error => finish(error)
      const press = (_text, key) => {
        state = menuState(state, key, choices.length, multiple)
        if (state.cancelled) return finish(new Error('Cancelled.'))
        if (state.done) return finish(null, multiple ? choices.filter((_row, index) => state.selected.has(index)).map(row => row.value) : choices[state.index].value)
        render()
      }
      input.on('keypress', press); input.once('end', ended); input.once('error', failed)
    })
  } finally {
    input.setRawMode(Boolean(raw))
    if (!raw) input.pause()
    output.write(plain ? '' : '\x1b[?25h')
  }
}

export async function confirm(title) {
  return await choose(title, [{ value: false, label: 'Cancel' }, { value: true, label: 'Continue' }])
}
