import type { Expression, OperationStep, Reference } from '../ir'
import type { CompiledCanvas } from './compile'
import { checkGraph } from './model'
import type { CanvasDraft } from './model'

const literal = (value: import('../ir').Json): Expression => ({ kind: 'literal', value })
const ref = (step: string, output: string, path?: string[]): Reference => ({
  kind: 'ref', source: 'step', step, output, ...(path ? { path } : {}),
})

// Tool links grant an optional messaging capability; they do not prescribe calls.
export function compileAgentTools(draft: CanvasDraft, namespace?: string): CompiledCanvas {
  const issues = checkGraph(draft.nodes, draft.edges)
  if (issues.length) throw new Error(issues[0])
  const task = draft.nodes.find((node) => node.data.kind === 'task')!
  const agent = draft.nodes.find((node) => node.data.kind === 'agent')!
  const result = draft.nodes.find((node) => node.data.kind === 'result')!
  const tools = draft.nodes.filter((node) => node.data.kind === 'tool' &&
    draft.edges.some((edge) => edge.source === agent.id && edge.target === node.id && edge.sourceHandle === 'tools'))
    .sort((a, b) => a.id.localeCompare(b.id))
  if (!task.data.prompt.trim()) throw new Error('Enter a task for the main agent.')
  const prefix = `workflow/${namespace ?? 'preview'}/`
  const addresses = new Map<string, string>([['coordinator', prefix + 'coordinator']])
  for (const node of [...tools, agent]) {
    const alias = node.data.address?.trim() || node.id
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(alias)) throw new Error(`${node.data.label}: enter a valid inbox name.`)
    if (addresses.has(alias)) throw new Error(`${node.data.label}: each inbox needs a unique name.`)
    if ((node.data.provider ?? 'codex') !== 'codex') throw new Error(`${node.data.label}: Carrier inboxes currently support Codex.`)
    addresses.set(alias, prefix + alias)
  }
  const addressOf = (node: typeof agent) => addresses.get(node.data.address?.trim() || node.id)!
  const resolve = (text: string) => text.replace(/\{\{([^}]+)\}\}/g, (_match, name: string) => {
    const address = addresses.get(name.trim())
    if (!address) throw new Error(`Unknown inbox placeholder: {{${name}}}.`)
    return address
  })
  const steps: OperationStep[] = []
  const invocations: Record<string, string> = {}
  const terminalAgents: Record<string, string> = {}
  const outputs: CompiledCanvas['workflow']['outputs'] = {}
  const push = (id: string, operation: string, nodeId: string, inputs: Record<string, Expression>) => {
    steps.push({ kind: 'operation', id, operation: { id: operation, version: operation === 'aixand.agents.spawn' && inputs.mcp ? '1.1.0' : '1.0.0' }, inputs })
    invocations[id] = nodeId
  }
  for (const [index, node] of [...tools, agent].entries()) {
    const id = `spawn_${index + 1}`
    const toolList = tools.map((tool) => `- ${tool.data.label} at ${addressOf(tool)}: ${tool.data.description}`).join('\n')
    const instructions = node.data.kind === 'agent'
      ? `${node.data.prompt}\nAvailable optional tools:\n${toolList || 'None. Complete the task independently.'}\nTool consultation is your decision; no tool call is required. Send your final result to {{coordinator}} as a reply to the original job.`
      : node.data.prompt
    push(id, 'aixand.agents.spawn', node.id, {
      provider: literal('codex'), profile: literal(node.data.profile?.trim() || 'default'),
      ...(node.data.mcp ? { mcp: literal({ inherit: node.data.mcp.inherit ?? true, add: node.data.mcp.add ?? [], exclude: node.data.mcp.exclude ?? [] }) } : {}),
      address: literal(addressOf(node)), instructions: literal(resolve(instructions)), timeout: literal(300),
      ...(node.data.cwd?.trim() ? { cwd: literal(node.data.cwd.trim()) } : {}),
    })
    terminalAgents[node.id] = id
    outputs[`${id}_run_id`] = { type: { kind: 'string' }, value: ref(id, 'run_id') }
  }
  terminalAgents[task.id] = terminalAgents[agent.id]
  terminalAgents[result.id] = terminalAgents[agent.id]
  push('mailbox_1', 'aixand.messaging.mailbox', task.id, { address: literal(prefix + 'coordinator') })
  push('message_1', 'carrier.message.send', task.id, {
    mailbox: ref('mailbox_1', 'mailbox'), to: literal(addressOf(agent)),
    content: literal(resolve(task.data.prompt)), idempotency_key: literal(`task:${task.id}`),
  })
  push('reply_1', 'carrier.message.wait_for_reply', result.id, {
    mailbox: ref('mailbox_1', 'mailbox'), message: ref('message_1', 'message'),
    sender: literal(addressOf(agent)), timeout: literal(600),
  })
  push('ack_1', 'carrier.message.ack', result.id, { message: ref('reply_1', 'message') })
  push('wait_1', 'aixand.agent.wait', agent.id, {
    agent: ref(terminalAgents[agent.id], 'agent'), timeout: literal(300), stable_for: literal(2),
  })
  outputs.message_1_request = { type: { kind: 'json' }, value: ref('message_1', 'snapshot') }
  outputs.final_reply = { type: { kind: 'json' }, value: ref('reply_1', 'snapshot') }
  outputs.final_reply_text = { type: { kind: 'string' }, value: ref('reply_1', 'snapshot', ['content']) }
  outputs.wait_1_observation = { type: { kind: 'json' }, value: ref('wait_1', 'observation') }
  return {
    workflow: { ir_version: '0.1', name: draft.name, description: draft.description, inputs: {}, body: { kind: 'sequence', steps }, outputs },
    invocations, terminalAgents, order: [task.id, agent.id, result.id],
    agentGraph: { task: task.id, agent: agent.id, result: result.id, tools: tools.map((tool) => tool.id) },
    ...(namespace ? { namespace } : {}),
  }
}
