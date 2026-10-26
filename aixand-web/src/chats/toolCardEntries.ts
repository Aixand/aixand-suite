import type { ManagementAction } from '../agents/AgentManagementCard'
import type { ProjectRun, Transfer } from '../connect/model'
import type { Discovery } from '../projects/model'
import type { TranscriptEntry } from './ActivityGroup'
import type { ChatItem, ChatLaunch, ChatWorkflow } from './model'

export type ToolCard =
  | { kind: 'projectRun'; value: ProjectRun }
  | { kind: 'transfer'; value: Transfer }
  | { kind: 'discovery'; value: Discovery }
  | { kind: 'launch'; value: ChatLaunch }
  | { kind: 'workflow'; value: ChatWorkflow }
  | { kind: 'agentManagement'; value: ManagementAction }
export type ConversationEntry = TranscriptEntry | { kind: 'card'; card: ToolCard }

function anchorItem(items: ChatItem[], card: ToolCard): ChatItem | undefined {
  const value = card.value
  const call = value.sourceCallId && items.find((item) => item.id === value.sourceCallId)
  if (call) return call
  // Older jobs have no explicit anchor. Their original tool output includes
  // the saved identity; use its first occurrence rather than later status calls.
  const identities = card.kind === 'workflow' ? [card.value.key, card.value.id] : [value.id]
  const tools = card.kind === 'agentManagement' ? [card.value.tool] : card.kind === 'projectRun' ? ['test_project_across_devices', 'copy_project_to_device', 'test_project_on_device'] : card.kind === 'transfer' ? ['send_file'] : card.kind === 'discovery' ? ['discover_projects'] : card.kind === 'launch' ? ['start_project_chat', 'start_remote_chat'] : ['start_project_workflow', 'start_project_audit_workflow']
  const output = items.find((item) => ['dynamicToolCall', 'mcpToolCall'].includes(item.type) &&
    tools.some((tool) => item.text.split('\n')[0].includes(tool)) &&
    identities.some((id) => id && item.text.includes(id)))
  if (output) return output
  return value.sourceTurnId ? [...items].reverse().find((item) => item.turnId === value.sourceTurnId) : undefined
}

export function toolCardEntries(items: ChatItem[], cards: ToolCard[]): ConversationEntry[] {
  const anchored = new Map<string, ToolCard[]>()
  const entries: ConversationEntry[] = []
  for (const card of cards) {
    const item = anchorItem(items, card)
    if (item) anchored.set(item.id, [...(anchored.get(item.id) ?? []), card])
    // An unavailable/truncated origin belongs before the retained history.
    // Never attach an older card to a new turn merely because it is latest.
    else entries.push({ kind: 'card', card })
  }
  for (const item of items) {
    if (item.type === 'userMessage' || item.type === 'agentMessage') entries.push({ kind: 'message', item })
    else {
      const previous = entries.at(-1)
      if (previous?.kind === 'activity') previous.items.push(item)
      else entries.push({ kind: 'activity', items: [item] })
    }
    for (const card of anchored.get(item.id) ?? []) entries.push({ kind: 'card', card })
  }
  return entries
}
