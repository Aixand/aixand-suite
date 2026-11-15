import type { Expression, OperationStep, Reference, Workflow } from '../ir'
import type { CanvasDraft, WorkflowNode } from './model'
import { isAgentToolGraph } from './model'
import { compileAgentTools } from './agentTools'

export type CompiledCanvas<T = Workflow> = {
  workflow: T
  invocations: Record<string, string>
  order: string[]
  namespace?: string
  terminalAgents?: Record<string, string>
  agentGraph?: { task: string; agent: string; result: string; tools: string[] }
}
const literal = (value: import('../ir').Json): Expression => ({
  kind: 'literal',
  value,
})
const ref = (step: string, output: string): Reference => ({
  kind: 'ref',
  source: 'step',
  step,
  output,
})

// Edges determine execution order. Layout and the nodes array do not.
export function compileSequence(draft: CanvasDraft, namespace?: string): CompiledCanvas {
  if (draft.mode === 'project-audit' || draft.mode === 'native-chat') throw new Error('Project chat workflows use native Runner execution from the builder.')
  if (draft.mode === 'agent-tools' || isAgentToolGraph(draft.nodes)) return compileAgentTools(draft, namespace)
  const fail = (message: string): never => {
    throw new Error(message)
  }
  if (!draft.nodes.length)
    fail('Add spawn, send, and wait nodes, followed by Done.')
  const nodes = new Map(draft.nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, number>()
  const next = new Map<string, string>()
  for (const edge of draft.edges) {
    if (
      !nodes.has(edge.source) ||
      !nodes.has(edge.target) ||
      edge.sourceHandle !== 'out' ||
      edge.targetHandle !== 'in'
    )
      fail(
        'Run currently supports a single sequential path with ordinary input and output ports.',
      )
    if (next.has(edge.source) || incoming.has(edge.target))
      fail(
        'Run currently supports one sequential path. Remove branches and merges before running.',
      )
    next.set(edge.source, edge.target)
    incoming.set(edge.target, 1)
  }
  const roots = draft.nodes.filter((node) => !incoming.has(node.id))
  if (roots.length !== 1)
    fail('Connect every node into one sequence with a single starting point.')
  const ordered: WorkflowNode[] = []
  const visited = new Set<string>()
  let current: WorkflowNode | undefined = roots[0]
  while (current) {
    if (visited.has(current.id)) fail('The sequence contains a cycle.')
    visited.add(current.id)
    ordered.push(current)
    current = nodes.get(next.get(current.id) ?? '')
  }
  if (ordered.length !== nodes.size)
    fail('Every node must belong to the same connected sequence.')
  if (ordered.at(-1)?.data.kind !== 'done')
    fail('Finish the sequence with a Done node.')
  if (ordered[0].data.kind !== 'spawn')
    fail('Start the sequence with a Spawn agent node.')
  const steps: OperationStep[] = []
  const invocations: Record<string, string> = {}
  const counts = { spawn: 0, send: 0, wait: 0, mailbox: 0, message: 0, reply: 0, ack: 0 }
  const agents = new Map<string, string>()
  const receipts = new Map<string, string>()
  const pending = new Set<string>()
  let latestAgent = ''
  const outputs: Workflow['outputs'] = {}
  const terminalAgents: Record<string, string> = {}
  const addresses = new Map<string, string>()
  const aliases = new Map<string, string>()
  const mailboxes = new Map<string, string>()
  const requests = new Map<string, { invocation: string; mailbox: string; agent: string }>()
  const replies = new Map<string, { invocation: string; request: string }>()
  const pendingReplies = new Set<string>()
  for (const node of ordered) {
    if (node.data.kind !== 'spawn' && node.data.kind !== 'mailbox') continue
    const alias = node.data.address?.trim() ?? ''
    if (node.data.kind === 'mailbox' && !alias) fail(`${node.data.label}: enter an inbox name.`)
    if (!alias) continue
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(alias))
      fail(`${node.data.label}: use an inbox name starting with a letter, followed by letters, numbers, underscores, or hyphens.`)
    if (aliases.has(alias)) fail(`${node.data.label}: each inbox needs a unique name.`)
    const address = `workflow/${namespace ?? 'preview'}/${alias}`
    addresses.set(node.id, address)
    aliases.set(alias, address)
  }
  const instruction = (text: string) => !addresses.size ? text : text.replace(/\{\{([^}]+)\}\}/g, (_match, name: string) => {
    const address = aliases.get(name.trim())
    if (!address) fail(`Unknown inbox placeholder: {{${name}}}.`)
    return address!
  })
  for (const [index, node] of ordered.entries()) {
    const { data } = node
    if (data.kind === 'done' && index === ordered.length - 1) continue
    if (data.kind === 'done') fail('Use one Done node at the end of the workflow.')
    const kind = data.kind as keyof typeof counts
    const id = `${kind}_${++counts[kind]}`
    const inputs: Record<string, Expression> = {}
    let operation = ''
    if (kind === 'spawn') {
      if (pending.size)
        fail(
          `${data.label}: wait for the previous instruction before spawning the next agent.`,
        )
      const provider = data.provider ?? 'codex'
      if (!['codex', 'opencode'].includes(provider))
        fail(`${data.label}: choose Codex or OpenCode.`)
      inputs.provider = literal(provider)
      inputs.profile = literal(data.profile?.trim() || 'default')
      if (data.mcp) inputs.mcp = literal({ inherit: data.mcp.inherit ?? true, add: data.mcp.add ?? [], exclude: data.mcp.exclude ?? [] })
      inputs.timeout = literal(300)
      if (data.cwd?.trim()) inputs.cwd = literal(data.cwd.trim())
      if (addresses.has(node.id)) {
        if (provider !== 'codex') fail(`${data.label}: Carrier inboxes currently support Codex.`)
        inputs.address = literal(addresses.get(node.id)!)
      }
      if (data.prompt.trim()) inputs.instructions = literal(instruction(data.prompt))
      agents.set(node.id, id)
      terminalAgents[node.id] = id
      latestAgent = node.id
      outputs[`${id}_run_id`] = {
        type: { kind: 'string' },
        value: ref(id, 'run_id'),
      }
      operation = 'aixand.agents.spawn'
    } else if (kind === 'send' || kind === 'wait') {
      const agentId = data.agent || latestAgent
      const spawn = agents.get(agentId)
      if (!spawn)
        fail(`${data.label}: select an agent spawned earlier in this sequence.`)
      inputs.agent = ref(spawn!, 'agent')
      inputs.timeout = literal(300)
      terminalAgents[node.id] = spawn!
      if (kind === 'send') {
        if (pending.has(agentId))
          fail(
            `${data.label}: wait for this agent’s previous instruction first.`,
          )
        if (!data.prompt.trim())
          fail(`${data.label}: enter an instruction to send.`)
        inputs.text = literal(instruction(data.prompt))
        receipts.set(agentId, id)
        pending.add(agentId)
      } else {
        const receipt = receipts.get(agentId)
        if ((!receipt || !pending.has(agentId)) && !addresses.has(agentId))
          fail(
            `${data.label}: send an instruction to this agent before waiting.`,
          )
        if (receipt && pending.has(agentId)) inputs.after = ref(receipt, 'receipt')
        inputs.stable_for = literal(2)
        pending.delete(agentId)
        outputs[`${id}_observation`] = {
          type: { kind: 'json' },
          value: ref(id, 'observation'),
        }
      }
      operation = `aixand.agent.${kind}`
    } else if (kind === 'mailbox') {
      inputs.address = literal(addresses.get(node.id)!)
      mailboxes.set(node.id, id)
      operation = 'aixand.messaging.mailbox'
    } else if (kind === 'message') {
      const mailbox = mailboxes.get(data.mailbox ?? '')
      const agent = data.agent || latestAgent
      if (!mailbox) fail(`${data.label}: select an inbox opened earlier in this sequence.`)
      if (!agents.has(agent) || !addresses.has(agent))
        fail(`${data.label}: select an earlier agent with a Carrier inbox.`)
      if (!data.prompt.trim()) fail(`${data.label}: enter a message to send.`)
      inputs.mailbox = ref(mailbox!, 'mailbox')
      inputs.to = literal(addresses.get(agent)!)
      inputs.content = literal(instruction(data.prompt))
      inputs.idempotency_key = literal(`task:${node.id}`)
      requests.set(node.id, { invocation: id, mailbox: mailbox!, agent })
      outputs[`${id}_request`] = { type: { kind: 'json' }, value: ref(id, 'snapshot') }
      pendingReplies.add(node.id)
      terminalAgents[node.id] = agents.get(agent)!
      operation = 'carrier.message.send'
    } else if (kind === 'reply') {
      const request = requests.get(data.message ?? '')
      if (!request) fail(`${data.label}: select a Carrier message sent earlier in this sequence.`)
      if ([...replies.values()].some((reply) => reply.request === data.message))
        fail(`${data.label}: this task already has a reply wait.`)
      inputs.mailbox = ref(request!.mailbox, 'mailbox')
      inputs.message = ref(request!.invocation, 'message')
      inputs.sender = literal(addresses.get(request!.agent)!)
      inputs.timeout = literal(600)
      replies.set(node.id, { invocation: id, request: data.message! })
      terminalAgents[node.id] = agents.get(request!.agent)!
      outputs.final_reply = { type: { kind: 'json' }, value: ref(id, 'snapshot') }
      outputs.final_reply_text = {
        type: { kind: 'string' }, value: { ...ref(id, 'snapshot'), path: ['content'] },
      }
      operation = 'carrier.message.wait_for_reply'
    } else if (kind === 'ack') {
      const reply = replies.get(data.message ?? '')
      if (!reply) fail(`${data.label}: select a reply received earlier in this sequence.`)
      if (!pendingReplies.has(reply!.request)) fail(`${data.label}: this reply was already acknowledged.`)
      inputs.message = ref(reply!.invocation, 'message')
      pendingReplies.delete(reply!.request)
      terminalAgents[node.id] = agents.get(requests.get(reply!.request)!.agent)!
      operation = 'carrier.message.ack'
    }
    invocations[id] = node.id
    steps.push({
      kind: 'operation',
      id,
      operation: {
        id: operation,
        version: operation === 'aixand.agents.spawn' && data.mcp ? '1.1.0' : '1.0.0',
      },
      inputs,
    })
  }
  if (!steps.length) fail('Add at least one agent sequence before running.')
  if (pending.size)
    fail('Wait for every sent instruction before finishing the workflow.')
  if (pendingReplies.size)
    fail('Wait for and acknowledge every Carrier task’s reply before finishing the workflow.')
  return {
    workflow: {
      ir_version: '0.1',
      name: draft.name,
      description: draft.description,
      inputs: {},
      body: { kind: 'sequence', steps },
      outputs,
    },
    invocations,
    order: ordered.map((node) => node.id),
    ...(namespace ? { namespace } : {}),
    terminalAgents,
  }
}
