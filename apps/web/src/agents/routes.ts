export const agentSections = [
  { id: 'sessions', label: 'Sessions', icon: 'rotate-ccw-clock', group: 'work' },
  { id: 'profiles', label: 'Profiles', icon: 'user-round', group: 'work' },
  { id: 'prompts', label: 'Prompts', icon: 'scroll-text', group: 'configuration' },
  { id: 'skills', label: 'Skills', icon: 'box', group: 'configuration' },
  { id: 'tools', label: 'Tools (MCP)', icon: 'layers', group: 'configuration' },
  { id: 'providers', label: 'Providers', icon: 'box', group: 'setup' },
  { id: 'logins', label: 'Saved logins', icon: 'mail', group: 'setup' },
  { id: 'operations', label: 'Operations', icon: 'refresh-cw', group: 'utility' },
] as const
export type AgentSection = typeof agentSections[number]['id']
export const AGENT_NAVIGATION_KEY = 'aixand.agents.navigation.v1'
type Navigation = { last: AgentSection; routes: Partial<Record<AgentSection, string>> }
let memory: Navigation = { last: 'sessions', routes: {} }
let memoryOnly = false

export function agentSection(route: string) {
  const path = route.split('?')[0]
  return agentSections.find(section => path === `agents/${section.id}` || section.id === 'sessions' && path.startsWith('agents/sessions/'))
}
function readNavigation(): Navigation {
  if (memoryOnly) return memory
  try {
    const value = JSON.parse(localStorage.getItem(AGENT_NAVIGATION_KEY) ?? 'null')
    if (!value || typeof value !== 'object') return memory
    const last = agentSections.find(section => section.id === value.last)?.id ?? 'sessions'
    const routes: Navigation['routes'] = {}
    for (const section of agentSections) {
      const route: unknown = value.routes?.[section.id]
      if (typeof route === 'string' && route.length <= 4096 && agentSection(route)?.id === section.id) routes[section.id] = route
    }
    return { last, routes }
  } catch { return memory }
}
export function agentRoute(section?: AgentSection) {
  const state = readNavigation()
  const target = section ?? state.last
  return state.routes[target] ?? `agents/${target}`
}
export function rememberAgentRoute(route: string) {
  const section = agentSection(route)
  if (!section || route.length > 4096) return
  const state = readNavigation()
  memory = { last: section.id, routes: { ...state.routes, [section.id]: route } }
  try { localStorage.setItem(AGENT_NAVIGATION_KEY, JSON.stringify(memory)); memoryOnly = false }
  catch { memoryOnly = true }
}
export function canonicalAgentRoute(route: string) {
  if (/^(?:sessions|prompts|skills)(?:[/?]|$)/.test(route)) return `agents/${route}`
  return /^agents\/?$/.test(route) ? agentRoute() : route
}
