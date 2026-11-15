import { codeRanges } from './inboxReferences'

export type ChatCommand = { name: string; description: string; inputHint?: string | null;
  execution: 'prompt' | 'setting' | 'native' | 'suite' | 'client' | 'terminal' | 'unsupported';
  configId?: string; action?: string; reason?: string; requiresIdle?: boolean; source?: string; acceptsArguments?: boolean; startsConversation?: boolean }
export type CommandOutput = { key: string; command: string; text: string; truncated?: boolean; format?: string; resource?: string | null; filename?: string }
export type CommandsState = 'loading' | 'ready' | 'unsupported' | 'error'
export type SessionConfig = { id: string; name: string; category?: string; type: string; currentValue: string | boolean; defaultUnknown?: boolean;
  options?: ({ value: string; name: string } | { group: string; name: string; options: { value: string; name: string }[] })[] }

export const configOptions = (option?: SessionConfig) => option?.options?.flatMap(row => 'options' in row ? row.options : [row]) ?? []

export function activeComposerCommand(text: string, caret: number) {
  if (caret < 0 || caret > text.length || codeRanges(text).some(range => caret > range.start && caret <= range.end)) return null
  const before = text.slice(0, caret)
  const match = [...before.matchAll(/(?:^|\s)\//g)].at(-1)
  if (!match) return null
  const start = match.index! + match[0].length - 1
  const query = before.slice(start + 1)
  if (/[\r\n]/.test(query)) return null
  const tail = /\s$/.test(before) ? '' : /^[^\s]*/.exec(text.slice(caret))![0]
  const end = caret + tail.length
  return { start, end, query, standalone: !text.slice(0, start).trim() && !text.slice(end).trim() }
}

export function commandInput(text: string, commands: ChatCommand[]) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const command = [...commands].sort((a, b) => b.name.length - a.name.length)
    .find(row => trimmed.startsWith('/' + row.name) && (!trimmed[row.name.length + 1] || /\s/.test(trimmed[row.name.length + 1])))
  return command ? { command, arguments: trimmed.slice(command.name.length + 1).trim() } : null
}

export function settingValue(command: ChatCommand, arguments_: string, option: SessionConfig) {
  if (command.name === 'plan') {
    if (arguments_ === 'status') return null
    return ['', 'on', 'plan'].includes(arguments_) ? 'plan' : ['off', 'default'].includes(arguments_) ? 'default' : 'plan'
  }
  if (command.name === 'fast') {
    if (arguments_ === 'status') return null
    if (!['', 'on', 'off'].includes(arguments_)) throw new Error('Use /fast on, /fast off, or /fast status.')
    const enabled = arguments_ === 'on' || !arguments_ && !['fast', 'priority', true].includes(option.currentValue)
    if (option.type === 'boolean') return enabled
    const values = configOptions(option)
    const value = enabled ? values.find(row => ['fast', 'priority'].includes(row.value))?.value : values.find(row => row.value === 'default')?.value
    if (!value) throw new Error('This session does not advertise that speed setting.')
    return value
  }
  if (option.type === 'boolean') {
    if (arguments_ === 'status') return null
    if (!['', 'on', 'off', 'true', 'false'].includes(arguments_)) throw new Error('Use on or off for this setting.')
    return arguments_ ? ['on', 'true'].includes(arguments_) : !option.currentValue
  }
  const value = configOptions(option).find(row => row.value === arguments_ || row.name.toLowerCase() === arguments_.toLowerCase())?.value
  if (!value) throw new Error('Choose a value from this session’s settings.')
  return value
}
