export type Labels = Record<string, string>
export const MY_TERMINAL_LABEL = 'aixand.my_terminal'

export function isMyTerminal(labels?: Labels | null) {
  return labels?.[MY_TERMINAL_LABEL] === 'true'
}

const dimensions = [
  ['app', 'App'],
  ['project.id', 'Project'],
  ['workflow.run_id', 'Workflow'],
  ['role', 'Role'],
  ['session.kind', 'Kind'],
  ['service.name', 'Service'],
] as const

export function contextGroups(rows: { labels?: Labels | null }[]) {
  const groups = new Map<string, { id: string; label: string; key: string; value: string; count: number }>()
  for (const row of rows) {
    const labels = row.labels ?? {}
    for (const [key, title] of dimensions) {
      const value = labels[key]
      if (!value) continue
      const id = `@context:${JSON.stringify([key, value])}`
      const group = groups.get(id)
      if (group) group.count++
      else {
        const name = key === 'project.id' ? labels['project.name'] || value
          : key === 'workflow.run_id' && labels['workflow.name'] ? `${labels['workflow.name']} · ${value}` : value
        groups.set(id, { id, label: `${title}: ${name}`, key, value, count: 1 })
      }
    }
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export function labelText(labels?: Labels | null) {
  return Object.entries(labels ?? {}).map(([key, value]) => `${key}=${value}`).join(' ')
}

export function visibleLabels(labels?: Labels | null) {
  return Object.entries(labels ?? {}).filter(([key]) => !key.startsWith('agent_manager.'))
}

export function sessionKind(labels?: Labels | null) {
  return labels?.['session.kind'] ?? (labels?.feature === 'app-server' ? 'server' : undefined)
}

export function sessionTitle(session: { name: string; labels?: Labels | null }) {
  const labels = session.labels ?? {}
  if (sessionKind(labels) === 'server') {
    const service = labels['service.name'] ?? (labels.feature === 'app-server' ? 'codex-app-server' : '')
    if (service === 'codex-app-server')
      return ['Codex server', labels['agent_manager.profile']].filter(Boolean).join(' · ')
    if (service === 'aixand-server') return 'Aixand server'
    if (service === 'aixand-web') return 'Aixand web'
  }
  if (sessionKind(labels) !== 'server' && labels['workflow.step_id'] && labels.app) {
    const app = labels.app === 'pathspec' ? 'Pathspec' : labels.app === 'aixand-suite' ? 'Suite' : labels.app
    const role = labels.role ? labels.role[0].toUpperCase() + labels.role.slice(1) : undefined
    return [app, labels['workflow.step_id'], role].filter(Boolean).join(' · ')
  }
  return session.name
}
