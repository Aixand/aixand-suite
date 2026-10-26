import { configOptions, type ChatCommand, type SessionConfig } from './commands'
import type { ComposerMentionGroup, ComposerMentionOption } from './composerMentions'
import { mentionSlug } from './inboxReferences'

type ModelSettingKind = 'effort' | 'speed' | 'mode'
export const modelSettingShortcuts: (Omit<ComposerMentionGroup, 'options' | 'id'> & { id: ModelSettingKind })[] = [
  { id: 'effort', aliases: ['reasoning', 'thinking'], label: 'Effort', description: 'Choose reasoning effort', icon: 'scan' },
  { id: 'speed', aliases: ['fast'], label: 'Speed', description: 'Choose model speed', icon: 'sparkles' },
  { id: 'mode', label: 'Mode', description: 'Choose the agent mode', icon: 'layers' },
]

export function findModelSetting(settings: SessionConfig[] = [], commands: ChatCommand[] = [], kind: ModelSettingKind) {
  const names = kind === 'speed' ? ['fast', 'speed'] : kind === 'effort' ? ['reasoning', 'effort'] : ['mode', 'plan']
  const ids = kind === 'speed' ? ['servicetier', 'speed', 'fast', 'fastmode'] : kind === 'effort' ?
    ['effort', 'reasoningeffort', 'thinkinglevel'] : ['mode', 'agentmode', 'sessionmode']
  const pattern = kind === 'speed' ? /\bspeed\b|\bfast\b|service[ _-]?tier/i : kind === 'effort' ?
    /\beffort\b|reasoning|thinking[ _-]?level/i : /^(agent[ _-]?|session[ _-]?)?mode$/i
  const selectable = settings.filter(option => option.type === 'boolean' || option.type === 'select' && configOptions(option).length > 0)
  const advertised = commands.filter(command => command.execution === 'setting' && names.includes(command.name)).map(command => command.configId)
  return selectable.find(option => advertised.includes(option.id)) ??
    selectable.find(option => ids.includes(option.id.toLowerCase().replace(/[-_]/g, ''))) ??
    selectable.find(option => (option.category === 'model_config' || kind === 'mode' && option.category === 'mode') && pattern.test(option.name))
}

export function modelSettingMentions({ settings, speed, effort, mode, onSelect }: {
  settings: SessionConfig[]
  speed?: SessionConfig
  effort?: SessionConfig
  mode?: SessionConfig
  onSelect: (configId: string, value: string | boolean) => void
}): ComposerMentionGroup[] {
  const used = new Set(['inbox', 'file', 'project', 'profile', 'agent', 'model', 'prompt', 'skill', 'chat', 'workflow',
    ...modelSettingShortcuts.flatMap(item => [item.id, ...(item.aliases ?? [])])])
  return settings.flatMap(setting => {
    if (!['select', 'boolean'].includes(setting.type)) return []
    const isSpeed = setting === speed
    const shortcut = modelSettingShortcuts.find(item => item.id === (isSpeed ? 'speed' : setting === effort ? 'effort' : setting === mode ? 'mode' : ''))
    const slug = (value: string) => mentionSlug(value.replace(/([a-z0-9])([A-Z])/g, '$1-$2'))
    let id = shortcut?.id ?? slug(setting.id)
    if (!shortcut) {
      if (used.has(id)) id = `model-${id}`
      const base = id
      let suffix = 2
      while (used.has(id)) id = `${base}-${suffix++}`
      used.add(id)
    }
    const aliases = shortcut?.aliases ?? [slug(setting.name), setting.id.toLowerCase()]
      .filter((alias, index, all) => alias !== id && !used.has(alias) && !/[\s/:@]/.test(alias) && all.indexOf(alias) === index)
    for (const alias of aliases) used.add(alias)
    const values = setting.type === 'boolean' ? [
      { value: 'true', name: isSpeed ? 'Fast' : 'On' },
      { value: 'false', name: isSpeed ? 'Normal' : 'Off' },
    ] : configOptions(setting)
    const options: ComposerMentionOption[] = values.map(row => {
      const fast = isSpeed && (setting.type === 'boolean' ? row.value === 'true' :
        ['fast', 'priority'].includes(row.value.toLowerCase()) || /^fast$/i.test(row.name))
      const normal = isSpeed && (setting.type === 'boolean' ? row.value === 'false' :
        ['default', 'normal', 'standard'].includes(row.value.toLowerCase()) || /^(normal|standard|default)$/i.test(row.name))
      return { id: row.value, label: row.name,
        description: `${String(setting.currentValue) === row.value ? 'Current · ' : ''}${setting.name}`,
        keywords: fast ? ['fast', 'on', 'true'] : normal ? ['normal', 'standard', 'off', 'false'] : [],
      }
    })
    if (!options.length) return []
    return [{ ...shortcut, id, aliases, label: shortcut?.label ?? setting.name,
      description: `Choose ${setting.name.toLowerCase()}`, icon: shortcut?.icon ?? 'scan', options,
      onSelect: value => onSelect(setting.id, setting.type === 'boolean' ? value === 'true' : value),
    }]
  })
}
