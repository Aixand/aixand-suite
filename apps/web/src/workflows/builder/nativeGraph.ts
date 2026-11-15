import type { Connection, Edge } from '@xyflow/react'
import type { CanvasDraft, NodeKind, WorkflowNode } from './model'

export const nativeNodeKinds = ['chat', 'collector', 'human-inbox'] as const
export const isNativeNode = (kind: NodeKind) => nativeNodeKinds.includes(kind as typeof nativeNodeKinds[number])
export type NativePlan = {
  steps: { id: string; title: string; instruction: string; dependsOn: string[] }[];
  deliveryStep: string;
  resourceCapture?: 'stage' | 'workflow';
}

export function nativeConnectionAllowed(connection: Connection | Edge, nodes: WorkflowNode[], edges: Edge[]) {
  const { source, target, sourceHandle, targetHandle } = connection
  const from = nodes.find((node) => node.id === source)
  const to = nodes.find((node) => node.id === target)
  if (!from || !to || source === target || sourceHandle !== 'out' || targetHandle !== 'in' ||
    edges.some((edge) => edge.source === source && edge.target === target)) return false
  if (!(from.data.kind === 'chat' && ['chat', 'collector', 'human-inbox'].includes(to.data.kind) ||
    from.data.kind === 'collector' && to.data.kind === 'chat')) return false
  if (from.data.kind === 'collector' && edges.some((edge) => edge.source === source) ||
    to.data.kind === 'human-inbox' && edges.some((edge) => edge.target === target)) return false
  const visited = new Set<string>()
  const pending = [target]
  while (pending.length) {
    const id = pending.pop()!
    if (id === source) return false
    if (visited.has(id)) continue
    visited.add(id)
    for (const edge of edges) if (edge.source === id) pending.push(edge.target)
  }
  return true
}

export function nativeDependencies(nodeId: string, nodes: WorkflowNode[], edges: Edge[]): string[] {
  return [...new Set(edges.filter((edge) => edge.target === nodeId).flatMap((edge) =>
    nodes.find((node) => node.id === edge.source)?.data.kind === 'collector'
      ? edges.filter((input) => input.target === edge.source).map((input) => input.source)
      : [edge.source]))]
}

export function nativeGraphIssues(nodes: WorkflowNode[], edges: Edge[]): string[] {
  const issues: string[] = []
  const chats = nodes.filter((node) => node.data.kind === 'chat')
  const inboxes = nodes.filter((node) => node.data.kind === 'human-inbox')
  if (!chats.length || chats.length > 16) issues.push('Use 1–16 project chat nodes.')
  if (inboxes.length !== 1) issues.push('Use one Main inbox node for human delivery.')
  if (nodes.some((node) => !isNativeNode(node.data.kind))) issues.push('Use Project chat, Collector inbox, and Main inbox nodes in this workflow.')
  if (edges.some((edge) => !nativeConnectionAllowed(edge, nodes, edges.filter((entry) => entry.id !== edge.id))))
    issues.push('Connect chat reports to chats or collectors, then one final chat to Main inbox. Cycles and duplicate connections are invalid.')
  for (const chat of chats) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(chat.id)) issues.push(`${chat.data.label}: use a stage ID of up to 64 letters, numbers, underscores, or hyphens.`)
    if (!chat.data.label.trim() || chat.data.label.length > 120) issues.push('Give every chat a name of up to 120 characters.')
    if (!chat.data.prompt.trim() || chat.data.prompt.length > 20000) issues.push(`${chat.data.label}: enter role instructions of up to 20000 characters.`)
  }
  for (const collector of nodes.filter((node) => node.data.kind === 'collector')) {
    if (!edges.some((edge) => edge.target === collector.id)) issues.push(`${collector.data.label}: connect the reports to collect.`)
    if (edges.filter((edge) => edge.source === collector.id).length !== 1) issues.push(`${collector.data.label}: connect one chat to consume all collected reports.`)
  }
  if (inboxes.length === 1) {
    const inbox = inboxes[0]
    if (edges.filter((edge) => edge.target === inbox.id).length !== 1) issues.push('Connect the final chat to Main inbox.')
    const ancestors = new Set<string>()
    const pending = [inbox.id]
    while (pending.length) {
      const id = pending.pop()!
      if (ancestors.has(id)) continue
      ancestors.add(id)
      for (const edge of edges) if (edge.target === id) pending.push(edge.source)
    }
    for (const node of nodes) if (!ancestors.has(node.id)) issues.push(`${node.data.label}: connect this stage into the path to Main inbox.`)
  }
  return issues
}

export function compileNativeCanvas(draft: CanvasDraft): NativePlan {
  const issues = nativeGraphIssues(draft.nodes, draft.edges)
  if (!draft.name.trim() || draft.name.length > 120) issues.unshift('Enter a workflow name of up to 120 characters.')
  if (issues.length) throw new Error(issues.join('\n'))
  const inbox = draft.nodes.find((node) => node.data.kind === 'human-inbox')!
  return {
    steps: draft.nodes.filter((node) => node.data.kind === 'chat').map((node) => ({
      id: node.id, title: node.data.label.trim(), instruction: node.data.prompt.trim(),
      dependsOn: nativeDependencies(node.id, draft.nodes, draft.edges),
    })),
    deliveryStep: draft.edges.find((edge) => edge.target === inbox.id)!.source,
    ...(draft.native?.resourceCapture ? { resourceCapture: draft.native.resourceCapture } : {}),
  }
}
