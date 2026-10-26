import type { Connection, Edge, Node, XYPosition } from '@xyflow/react'
import type { PermissionMode } from '../../agents/permissions'
import type { ProfileSelection } from '../../agents/profileSelection'
import type { McpPolicy } from '../../agents/mcp'
import { isNativeNode } from './nativeGraph'
import { graphConnectionAllowed, graphIssues } from './graph'

// Canvas documents retain layout; runnable sequences compile to separate IR.
export const DRAFT_KEY = 'aixand.workflow.canvas.v1'
export const PREVIOUS_DRAFT_KEY = 'aixand.workflow.canvas.previous.v1'
export const nodeKinds = ['input', 'spawn', 'send', 'wait', 'mailbox', 'message', 'reply', 'ack', 'done', 'task', 'agent', 'tool', 'result', 'chat', 'collector', 'human-inbox'] as const
export const agentToolKinds = ['task', 'agent', 'tool', 'result'] as const
export type NodeKind = (typeof nodeKinds)[number]
export type StepData = {
  kind: NodeKind
  label: string
  description: string
  prompt: string
  agent: string
  provider?: string
  sdkApprovalPolicy?: 'ask' | 'deny'
  profile?: string
  permissionMode?: PermissionMode
  profileSelection?: ProfileSelection
  cwd?: string
  address?: string
  mailbox?: string
  message?: string
  mcp?: McpPolicy
  inputName?: string
  exportName?: string
}
export type WorkflowNode = Node<StepData, 'workflowStep'>
export type CanvasDraft = {
  format: 'aixand.workflow-canvas'
  version: 1
  name: string
  description: string
  mode?: 'agent-tools' | 'project-audit' | 'native-chat'
  native?: { projectId?: string; controllerChatId?: string; profile?: string; permissionMode?: PermissionMode; sdkApprovalPolicy?: 'ask' | 'deny'; profileSelection?: ProfileSelection; resourceCapture?: 'stage' | 'workflow' }
  nodes: WorkflowNode[]
  edges: Edge[]
}
export const library: { kind: NodeKind; title: string; description: string }[] =
  [
    { kind: 'input', title: 'Previous workflow result', description: 'Read a named input supplied by a previous workflow or at launch.' },
    {
      kind: 'spawn',
      title: 'Spawn agent',
      description: 'Start a new agent session.',
    },
    {
      kind: 'send',
      title: 'Send instruction',
      description: 'Send a task to an agent.',
    },
    {
      kind: 'wait',
      title: 'Wait for agent',
      description: 'Wait for the agent to finish its response.',
    },
    {
      kind: 'done',
      title: 'Done',
      description: 'Finish the workflow and close its agent sessions.',
    },
    { kind: 'mailbox', title: 'Open inbox', description: 'Open a Carrier inbox for the workflow coordinator.' },
    { kind: 'message', title: 'Send Carrier message', description: 'Send a task from an inbox to an agent.' },
    { kind: 'reply', title: 'Wait for Carrier reply', description: 'Wait for the recipient’s reply to this exact task.' },
    { kind: 'ack', title: 'Acknowledge reply', description: 'Accept the received Carrier reply.' },
    { kind: 'task', title: 'Task', description: 'Give the main agent a task.' },
    { kind: 'agent', title: 'Agent', description: 'Complete the task and decide which tools to use.' },
    { kind: 'tool', title: 'Agent tool', description: 'An optional adviser, available when the main agent needs it.' },
    { kind: 'result', title: 'Result', description: 'Collect completed outputs and optionally continue the workflow.' },
    { kind: 'chat', title: 'Project chat', description: 'Run instructions in a native project chat with the selected access and profile.' },
    { kind: 'collector', title: 'Collector inbox', description: 'Join completed outputs from every connected prerequisite.' },
    { kind: 'human-inbox', title: 'Main inbox', description: 'Deliver completed outputs to your human Main inbox.' },
  ]
export class UnsupportedNodesError extends Error {
  constructor() {
    super(
      'Only agent, Carrier messaging, and Done nodes are supported.',
    )
  }
}
export function createCanvasId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // LAN HTTP origins lack randomUUID but still provide getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function makeNode(
  kind: NodeKind,
  position: XYPosition,
  label?: string,
): WorkflowNode {
  const item = library.find((item) => item.kind === kind)!
  return {
    id: createCanvasId(),
    type: 'workflowStep',
    position,
    data: {
      kind,
      label: label ?? item.title,
      description: item.description,
      prompt: '',
      agent: '',
      ...(['spawn', 'agent', 'tool'].includes(kind)
        ? { provider: 'codex', profile: 'default', cwd: '' }
        : {}),
      ...(kind === 'mailbox' ? { address: 'coordinator' } : {}),
      ...(kind === 'agent' || kind === 'tool' ? { address: '' } : {}),
    },
  }
}
export function sequentialDraft(): CanvasDraft {
  const steps: [string, NodeKind, string, Partial<StepData>][] = [
    [
      'spawn-x',
      'spawn',
      'Spawn agent X',
      { profile: 'backup', description: 'Start a fresh Codex session for X.' },
    ],
    [
      'send-x',
      'send',
      'Send instruction to X',
      { agent: 'spawn-x', prompt: 'Say hi.', description: 'Say hi.' },
    ],
    [
      'wait-x',
      'wait',
      'Wait for X',
      {
        agent: 'spawn-x',
        description: 'Finish X’s response before starting Y.',
      },
    ],
    [
      'spawn-y',
      'spawn',
      'Spawn agent Y',
      { profile: 'backup', description: 'Start Y after X has finished.' },
    ],
    [
      'send-y',
      'send',
      'Send instruction to Y',
      { agent: 'spawn-y', prompt: 'Say hi.', description: 'Say hi.' },
    ],
    [
      'wait-y',
      'wait',
      'Wait for Y',
      { agent: 'spawn-y', description: 'Wait until Y finishes its response.' },
    ],
    [
      'done',
      'done',
      'Done',
      { description: 'Finish the workflow and close its agent sessions.' },
    ],
  ]
  return {
    format: 'aixand.workflow-canvas',
    version: 1,
    name: 'Sequential hello',
    description:
      'X says hi, then Y says hi. Each response finishes before the next agent starts.',
    nodes: steps.map(([id, kind, label, data], index) => {
      const node = makeNode(kind, { x: 0, y: index * 160 }, label)
      return { ...node, id, data: { ...node.data, ...data } }
    }),
    edges: steps.slice(1).map(([target], index) => ({
      id: `${steps[index][0]}-${target}`,
      source: steps[index][0],
      target,
      sourceHandle: 'out',
      targetHandle: 'in',
      type: 'smoothstep',
    })),
  }
}
export function blankDraft(): CanvasDraft {
  return {
    format: 'aixand.workflow-canvas',
    version: 1,
    name: 'Untitled workflow',
    description: '',
    nodes: [],
    edges: [],
  }
}
export function projectAuditDraft(): CanvasDraft {
  const stages = [
    ['architecture', 'Architecture audit', 'Audit this project’s architecture. Report concrete design, dependency, maintainability and reliability problems with file references and evidence.'],
    ['security', 'Security audit', 'Audit this project’s security. Report concrete vulnerabilities, impact, severity and supporting evidence with file references.'],
    ['tasks', 'Task planning', 'Read both complete audit reports. Merge overlapping findings into a prioritized, actionable task list. For every task include priority, rationale, affected files, acceptance criteria and source finding references. Explain conflicting findings. Do not implement tasks.'],
  ]
  return {
    format: 'aixand.workflow-canvas', version: 1, name: 'Project audit',
    description: 'Parallel architecture and security audits → task planning → main inbox.',
    nodes: [
      ...stages.map(([id, label, prompt], index) => ({ ...makeNode('chat', { x: index === 0 ? -150 : index === 1 ? 150 : 0, y: index === 2 ? 440 : 0 }, label),
        id, data: { kind: 'chat' as const, label, prompt, description: index === 2 ? 'Combine both complete audit reports into an actionable task list.' : 'Audit with read-only project access.', agent: '' } })),
      { ...makeNode('collector', { x: 0, y: 220 }), id: 'audit-collector' },
      { ...makeNode('human-inbox', { x: 0, y: 660 }), id: 'main-inbox' },
    ],
    edges: [...['architecture', 'security'].map((source) => ({ id: `${source}-collector`, source, target: 'audit-collector', sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep' })),
      { id: 'collector-tasks', source: 'audit-collector', target: 'tasks', sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep' },
      { id: 'tasks-main', source: 'tasks', target: 'main-inbox', sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep' }],
  }
}
export function legacyBrainImplementerDraft(): CanvasDraft {
  const steps: [string, NodeKind, string, Partial<StepData>][] = [
    ['brain', 'spawn', 'Spawn Brain', {
      profile: 'backup', address: 'brain', description: 'An adviser that answers Implementer’s questions through Carrier.',
      prompt: 'You are Brain, an adviser for Implementer at {{implementer}}. Answer its questions through Carrier send, replying to the incoming numeric message ID with reply_to. Keep answers concise. Do not edit files, send unsolicited messages, or reply to an answer. End your turn after sending your answer so the managed inbox can deliver the next message.',
    }],
    ['implementer', 'spawn', 'Spawn Implementer', {
      profile: 'backup', address: 'implementer', description: 'Consult Brain, then return the result to the coordinator.',
      prompt: 'You are Implementer. Wait for a job from {{coordinator}} and remember its ORIGINAL numeric message ID. Ask Brain at {{brain}} one question using Carrier send without reply_to, because this is a new question to a different peer. End your turn. When Brain’s answer arrives, use it to finish the job. Send your final answer to {{coordinator}} with reply_to set to the ORIGINAL coordinator job ID. Do not send the final answer to Brain. Do not edit files.',
    }],
    ['coordinator', 'mailbox', 'Open coordinator inbox', { address: 'coordinator' }],
    ['task', 'message', 'Send task to Implementer', {
      agent: 'implementer', mailbox: 'coordinator',
      prompt: 'Ask Brain for a short friendly greeting, then reply to this task with that greeting.',
      description: 'Implementer asks Brain for a greeting and returns its answer through Carrier.',
    }],
    ['answer', 'reply', 'Wait for final reply', { message: 'task', description: 'Only Implementer’s reply to the original task completes this step.' }],
    ['accept', 'ack', 'Acknowledge final reply', { message: 'answer' }],
    ['wait-brain', 'wait', 'Wait for Brain', { agent: 'brain', description: 'Let Brain finish its current response.' }],
    ['wait-implementer', 'wait', 'Wait for Implementer', { agent: 'implementer', description: 'Let Implementer finish its final response.' }],
    ['done', 'done', 'Done', { description: 'Finish after the final reply and close both agent sessions.' }],
  ]
  return {
    format: 'aixand.workflow-canvas', version: 1, name: 'Brain and Implementer',
    description: 'Implementer consults Brain through Carrier and returns a final reply to the coordinator.',
    nodes: steps.map(([id, kind, label, data], index) => {
      const node = makeNode(kind, { x: 0, y: index * 160 }, label)
      return { ...node, id, data: { ...node.data, ...data } }
    }),
    edges: steps.slice(1).map(([target], index) => ({
      id: `${steps[index][0]}-${target}`, source: steps[index][0], target,
      sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep',
    })),
  }
}
export function brainImplementerDraft(): CanvasDraft {
  const steps: [string, NodeKind, string, XYPosition, Partial<StepData>][] = [
    ['task', 'task', 'Task', { x: 0, y: 0 }, {
      prompt: 'Say hi.', description: 'Give Implementer a task. It chooses whether to consult Brain.',
    }],
    ['implementer', 'agent', 'Implementer', { x: 0, y: 220 }, {
      profile: 'backup', address: 'implementer', description: 'Own the task and use tools only when needed.',
      prompt: 'You are Implementer. Complete the job from {{coordinator}} and remember its ORIGINAL numeric message ID. Decide whether advice from an available tool is useful. You may finish independently without using any tool, or consult a tool one or more times when needed. For each new tool question, use Carrier send without reply_to. Remember its numeric question ID and end your turn so the answer can arrive. Match the answer’s sender and reply_to to the question, then continue the ORIGINAL job. Ask follow-up questions only when useful, at most 5 per job. Return the final result to {{coordinator}} with reply_to set to the ORIGINAL job ID. Do not send the final result to a tool or reply to an answer. Stop with a clear explanation if blocked or unable to finish within 8 minutes. Do not edit files unless the task requests it.',
    }],
    ['brain', 'tool', 'Brain', { x: 420, y: 220 }, {
      profile: 'backup', address: 'brain', description: 'Advice and clarification, only when Implementer asks.',
      prompt: 'You are Brain, an optional adviser for {{implementer}}. Stay idle until a question is delivered. Answer only the question asked, through Carrier send with reply_to set to the incoming numeric message ID. Keep your answer concise. Do not edit files, send unsolicited messages, or reply to an answer. End your turn after answering so another question can be delivered.',
    }],
    ['result', 'result', 'Result', { x: 0, y: 480 }, {
      description: 'Finish with Implementer’s final reply. Brain consultation is optional.',
    }],
  ]
  return {
    format: 'aixand.workflow-canvas', version: 1, name: 'Brain and Implementer',
    description: 'Implementer completes the task and optionally consults Brain through Carrier.',
    nodes: steps.map(([id, kind, label, position, data]) => {
      const node = makeNode(kind, position, label)
      return { ...node, id, data: { ...node.data, ...data } }
    }),
    edges: [
      { id: 'task-implementer', source: 'task', target: 'implementer', sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep' },
      { id: 'implementer-result', source: 'implementer', target: 'result', sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep' },
      { id: 'implementer-brain', source: 'implementer', target: 'brain', sourceHandle: 'tools', targetHandle: 'request', type: 'smoothstep' },
    ],
  }
}
export function migrateBrainImplementerDraft(draft: CanvasDraft): CanvasDraft {
  if (draft.mode === 'agent-tools') return draft
  const previous = legacyBrainImplementerDraft()
  if (draft.nodes.length !== previous.nodes.length ||
    !previous.nodes.every((expected) => draft.nodes.some((node) => node.id === expected.id && node.data.kind === expected.data.kind)) ||
    JSON.stringify(draft.edges.map(({ source, target }) => [source, target])) !==
      JSON.stringify(previous.edges.map(({ source, target }) => [source, target]))) return draft
  const next = brainImplementerDraft()
  next.name = draft.name
  next.description = draft.description === previous.description ? next.description : draft.description
  for (const node of next.nodes) {
    const old = draft.nodes.find((entry) => entry.id === node.id)
    const original = previous.nodes.find((entry) => entry.id === node.id)
    if (!old || !original) continue
    for (const key of ['label', 'description', 'prompt', 'profile', 'provider', 'cwd', 'address'] as const) {
      if (old.data[key] !== original.data[key] && old.data[key] !== undefined)
        node.data[key] = old.data[key]!
    }
  }
  return next
}
export const isAgentToolGraph = (nodes: WorkflowNode[]) =>
  nodes.some((node) => agentToolKinds.includes(node.data.kind as typeof agentToolKinds[number]))
export const suggestedConnection = (from: WorkflowNode, to: WorkflowNode): Connection => ({
  source: from.id, target: to.id,
  sourceHandle: from.data.kind === 'agent' && to.data.kind === 'tool' ? 'tools' : 'out',
  targetHandle: from.data.kind === 'agent' && to.data.kind === 'tool' ? 'request' : 'in',
})
export const hasAgentTerminal = (kind: NodeKind) =>
  ['spawn', 'send', 'wait', 'message', 'reply', 'ack', 'agent', 'tool', 'task', 'result'].includes(kind)
export function connectionAllowed(
  connection: Connection | Edge,
  nodes: WorkflowNode[],
  edges: Edge[],
): boolean {
  return graphConnectionAllowed(connection, nodes, edges)
}
export function checkGraph(nodes: WorkflowNode[], edges: Edge[]): string[] {
  return graphIssues(nodes, edges)
}
export function arrangeNodes(
  nodes: WorkflowNode[],
  edges: Edge[],
  options?: { mode: 'dag' | 'agent-tools' },
): WorkflowNode[] {
  if (options?.mode === 'agent-tools') {
    let toolIndex = 0
    return nodes.map((node) => ({ ...node, position: node.data.kind === 'tool'
      ? { x: 420, y: 220 + toolIndex++ * 190 }
      : { x: 0, y: node.data.kind === 'task' ? 0 : node.data.kind === 'agent' ? 220 : 480 } }))
  }
  const ranks = new Map<string, number>()
  const remaining = new Set(nodes.map((node) => node.id))
  while (remaining.size) {
    let progressed = false
    for (const id of remaining) {
      const parents = edges.filter((edge) => edge.sourceHandle !== 'tools')
        .filter((edge) => edge.target === id)
        .map((edge) => edge.source)
      if (parents.every((parent) => ranks.has(parent))) {
        ranks.set(
          id,
          parents.length
            ? Math.max(...parents.map((parent) => ranks.get(parent)!)) + 1
            : 0,
        )
        remaining.delete(id)
        progressed = true
      }
    }
    if (!progressed) break
  }
  const layers = new Map<number, string[]>()
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0
    layers.set(rank, [...(layers.get(rank) ?? []), node.id])
  }
  return nodes.map((node) => {
    const rank = ranks.get(node.id) ?? 0
    const layer = layers.get(rank)!
    return {
      ...node,
      position: {
        x: (layer.indexOf(node.id) - (layer.length - 1) / 2) * 300,
        y: rank * (nodes.some((node) => isNativeNode(node.data.kind)) ? 220 : 170),
      },
    }
  })
}
export function serializeDraft(draft: CanvasDraft): string {
  return JSON.stringify(
    {
      ...draft,
      nodes: draft.nodes.map(({ id, type, position, data }) => ({
        id,
        type,
        position,
        data,
      })),
      edges: draft.edges.map(
        ({ id, source, target, sourceHandle, targetHandle, label }) => ({
          id,
          source,
          target,
          sourceHandle,
          targetHandle,
          type: 'smoothstep',
          ...(label ? { label } : {}),
        }),
      ),
    },
    null,
    2,
  )
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function shortText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 20000
}
export function parseDraft(source: string): CanvasDraft {
  const value: unknown = JSON.parse(source)
  if (
    !record(value) ||
    value.format !== 'aixand.workflow-canvas' ||
    value.version !== 1 ||
    (value.mode !== undefined && value.mode !== 'agent-tools' && value.mode !== 'project-audit' && value.mode !== 'native-chat') ||
    !shortText(value.name) ||
    !shortText(value.description) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    value.nodes.length > 100 ||
    value.edges.length > 500
  )
    throw new Error('Choose an Aixand canvas workflow (.canvas.json).')
  const ids = new Set<string>()
  const nodes = value.nodes.map((node): WorkflowNode => {
    if (
      record(node) &&
      record(node.data) &&
      typeof node.data.kind === 'string' &&
      !nodeKinds.includes(node.data.kind as NodeKind) &&
      node.data.kind !== 'output'
    )
      throw new UnsupportedNodesError()
    if (
      !record(node) ||
      !shortText(node.id) ||
      !node.id ||
      ids.has(node.id) ||
      !record(node.position) ||
      typeof node.position.x !== 'number' ||
      typeof node.position.y !== 'number' ||
      !Number.isFinite(node.position.x) ||
      !Number.isFinite(node.position.y) ||
      !record(node.data) ||
      !(
        nodeKinds.includes(node.data.kind as NodeKind) ||
        node.data.kind === 'output'
      ) ||
      !['label', 'description', 'prompt', 'agent'].every((key) =>
        shortText((node.data as Record<string, unknown>)[key]),
      )
    )
      throw new Error('This workflow contains an invalid or duplicate node.')
    ids.add(node.id)
    const data = node.data as StepData
    const settings = node.data as Record<string, unknown>
    if (data.sdkApprovalPolicy !== undefined && !['ask', 'deny'].includes(data.sdkApprovalPolicy)) throw new Error('Invalid SDK stage approval policy.')
    if (
      !['provider', 'profile', 'cwd', 'address', 'mailbox', 'message', 'inputName', 'exportName'].every(
        (key) => settings[key] === undefined || shortText(settings[key]),
      )
    )
      throw new Error('This workflow contains invalid agent settings.')
    return {
      id: node.id,
      type: 'workflowStep',
      position: { x: node.position.x, y: node.position.y },
      data: {
        kind: settings.kind === 'output' ? 'done' : data.kind,
        label: data.label,
        description: data.description,
        prompt: data.prompt,
        agent: data.agent,
        ...(data.provider !== undefined ? { provider: data.provider } : {}),
        ...(data.sdkApprovalPolicy !== undefined ? { sdkApprovalPolicy: data.sdkApprovalPolicy } : {}),
        ...(data.profile !== undefined ? { profile: data.profile } : {}),
        ...(data.cwd !== undefined ? { cwd: data.cwd } : {}),
        ...(data.address !== undefined ? { address: data.address } : {}),
        ...(data.mailbox !== undefined ? { mailbox: data.mailbox } : {}),
        ...(data.message !== undefined ? { message: data.message } : {}),
        ...(data.mcp !== undefined ? { mcp: data.mcp } : {}),
        ...(data.inputName !== undefined ? { inputName: data.inputName } : {}),
        ...(data.exportName !== undefined ? { exportName: data.exportName } : {}),
      },
    }
  })
  const edges: Edge[] = []
  ids.clear()
  for (const edge of value.edges) {
    if (
      !record(edge) ||
      !shortText(edge.id) ||
      !edge.id ||
      ids.has(edge.id) ||
      !shortText(edge.source) ||
      !shortText(edge.target) ||
      !shortText(edge.sourceHandle) ||
      !shortText(edge.targetHandle) ||
      (edge.label !== undefined && !shortText(edge.label))
    )
      throw new Error(
        'This workflow contains an invalid or duplicate connection.',
      )
    const next: Edge = {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      type: 'smoothstep',
      ...(edge.label ? { label: edge.label as string } : {}),
    }
    if (value.mode !== 'project-audit' && !connectionAllowed(next, nodes, edges))
      throw new Error(
        'Invalid connection: check ports, duplicate links, and dependency cycles.',
      )
    ids.add(next.id)
    edges.push(next)
  }
  if (value.mode === 'project-audit' && (nodes.length !== 3 || edges.length !== 2 ||
      !['architecture', 'security', 'tasks'].every((id) => nodes.some((node) => node.id === id && node.data.kind === 'spawn')) ||
      !['architecture', 'security'].every((source) => edges.some((edge) => edge.source === source && edge.target === 'tasks' && edge.sourceHandle === 'out' && edge.targetHandle === 'in'))))
    throw new Error('Project audits require architecture and security stages joined into task planning.')
  if (value.mode === 'project-audit') {
    const collector = { ...makeNode('collector', { x: 160, y: 220 }), id: 'audit-collector' }
    const tasks = nodes.find((node) => node.id === 'tasks')!
    const migrated = projectAuditDraft()
    return { ...migrated, name: value.name, description: value.description,
      nodes: [...nodes.map((node) => ({ ...node, position: node.id === 'tasks' ? { ...node.position, y: Math.max(440, node.position.y) } : node.position,
        data: { ...node.data, kind: 'chat' as const } })), collector,
        { ...makeNode('human-inbox', { x: tasks.position.x, y: Math.max(440, tasks.position.y) + 220 }), id: 'main-inbox' }] }
  }
  if (value.native !== undefined) {
    const settings = value.native
    if (!record(settings) || Object.keys(settings).some((key) => !['projectId', 'controllerChatId', 'profile', 'permissionMode', 'sdkApprovalPolicy', 'profileSelection', 'resourceCapture'].includes(key)) ||
        ['projectId', 'controllerChatId', 'profile'].some((key) => settings[key] !== undefined && !shortText(settings[key])) ||
        settings.permissionMode !== undefined && (typeof settings.permissionMode !== 'string' || !['read-only', 'workspace-write', 'workspace-auto', 'full-access'].includes(settings.permissionMode)) ||
        settings.sdkApprovalPolicy !== undefined && !['ask', 'deny'].includes(settings.sdkApprovalPolicy as string) ||
        settings.resourceCapture !== undefined && (typeof settings.resourceCapture !== 'string' || !['stage', 'workflow'].includes(settings.resourceCapture))) throw new Error('Invalid project workflow settings.')
    if (settings.profileSelection !== undefined) {
      const selection = settings.profileSelection
      if (!record(selection) || typeof selection.mode !== 'string' || !['controller', 'auto', 'specific'].includes(selection.mode) ||
          Object.keys(selection).some((key) => !['mode', ...(selection.mode === 'specific' ? ['profile'] : selection.mode === 'auto' ? ['eligibleProfiles'] : [])].includes(key)) ||
          selection.mode === 'specific' && !shortText(selection.profile) ||
          selection.eligibleProfiles !== undefined && (!Array.isArray(selection.eligibleProfiles) || !selection.eligibleProfiles.every(shortText))) throw new Error('Invalid workflow profile selection.')
    }
  }
  return {
    format: 'aixand.workflow-canvas',
    version: 1,
    name: value.name,
    description: value.description,
    ...(value.native !== undefined ? { native: value.native as CanvasDraft['native'] } : {}),
    nodes,
    edges,
  }
}
