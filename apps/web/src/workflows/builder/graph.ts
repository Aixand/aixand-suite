import type { Connection, Edge } from '@xyflow/react'
import type { WorkflowNode } from './model'

export const dependencyEdges = (edges: Edge[]) => edges.filter((edge) => edge.sourceHandle !== 'tools').sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
export function graphConnectionAllowed(link: Connection | Edge, nodes: WorkflowNode[], edges: Edge[]) {
  const from = nodes.find((node) => node.id === link.source)
  const to = nodes.find((node) => node.id === link.target)
  if (!from || !to || from.id === to.id || edges.some((edge) => edge.source === link.source && edge.target === link.target)) return false
  if (link.sourceHandle === 'tools' || link.targetHandle === 'request')
    return from.data.kind === 'agent' && to.data.kind === 'tool' &&
      link.sourceHandle === 'tools' && link.targetHandle === 'request' && !edges.some((edge) => edge.target === to.id)
  if (link.sourceHandle !== 'out' || link.targetHandle !== 'in' ||
    ['done', 'human-inbox', 'tool'].includes(from.data.kind) || to.data.kind === 'tool') return false
  const visited = new Set<string>()
  const pending = [to.id]
  while (pending.length) {
    const id = pending.pop()!
    if (id === from.id) return false
    if (visited.has(id)) continue
    visited.add(id)
    pending.push(...dependencyEdges(edges).filter((edge) => edge.source === id).map((edge) => edge.target))
  }
  return true
}
export function graphOrder(nodes: WorkflowNode[], edges: Edge[]) {
  const required = nodes.filter((node) => node.data.kind !== 'tool')
  const ordered: WorkflowNode[] = []
  const seen = new Set<string>()
  while (ordered.length < required.length) {
    const ready = required.filter((node) => !seen.has(node.id) && dependencyEdges(edges)
      .filter((edge) => edge.target === node.id).every((edge) => seen.has(edge.source))).sort((a, b) => a.id.localeCompare(b.id))
    if (!ready.length) throw new Error('Dependency connections contain a cycle or a missing node.')
    for (const node of ready) { ordered.push(node); seen.add(node.id) }
  }
  return ordered
}
export function graphAncestors(id: string, edges: Edge[]) {
  const found = new Set<string>()
  const pending = dependencyEdges(edges).filter((edge) => edge.target === id).map((edge) => edge.source)
  while (pending.length) {
    const parent = pending.pop()!
    if (found.has(parent)) continue
    found.add(parent)
    pending.push(...dependencyEdges(edges).filter((edge) => edge.target === parent).map((edge) => edge.source))
  }
  return found
}
export function graphIssues(nodes: WorkflowNode[], edges: Edge[]) {
  const issues: string[] = []
  if (!nodes.length) return ['Add a task, project chat, or agent session to start.']
  if (edges.some((edge) => !graphConnectionAllowed(edge, nodes, edges.filter((entry) => entry.id !== edge.id)))) issues.push('Check connection ports, duplicate links, and dependency cycles. Adviser links use the agent’s side port.')
  if (nodes.filter((node) => node.data.kind === 'human-inbox').length > 1) issues.push('Use one Main inbox node for human delivery.')
  const terminals = nodes.filter((node) => ['done', 'result', 'human-inbox'].includes(node.data.kind) && !dependencyEdges(edges).some((edge) => edge.source === node.id))
  if (!terminals.length) issues.push('Finish a path with Result, Done, or Main inbox.')
  const human = nodes.find((node) => node.data.kind === 'human-inbox')
  if (human && terminals.some((node) => node.id !== human.id)) issues.push('Connect all workflow results into Main inbox before human delivery.')
  const contributing = new Set(terminals.flatMap((node) => [node.id, ...graphAncestors(node.id, edges)]))
  for (const node of nodes) {
    if (node.data.kind === 'tool') continue // A detached adviser is saved but does not run.
    if (!contributing.has(node.id)) issues.push(`${node.data.label}: connect this node to a workflow output.`)
    if (['send', 'wait', 'message', 'reply', 'ack', 'collector', 'result', 'human-inbox', 'done'].includes(node.data.kind) && !dependencyEdges(edges).some((edge) => edge.target === node.id)) issues.push(`${node.data.label}: connect a prerequisite.`)
    if (node.data.kind === 'agent' && !dependencyEdges(edges).some((edge) => edge.target === node.id)) issues.push(`${node.data.label}: connect a task or report to give this agent work.`)
  }
  return issues
}
