import type { PermissionMode } from '../../agents/permissions'
import type { ProfileSelection } from '../../agents/profileSelection'
import type { Expression, OperationStep, Reference, Workflow } from '../ir'
import type { CanvasDraft, WorkflowNode } from './model'
import type { CompiledCanvas } from './compile'
import { graphAncestors, graphIssues, graphOrder, dependencyEdges } from './graph'

export type GraphWorkflow = {
  format: 'aixand.workflow-graph'; version: 1 | 2; workflow: Workflow;
  dependencies: Record<string, string[]>;
  groups?: Record<string, string[]>;
  identities?: Record<string, string>;
  context: { projectId?: string; originChatId?: string; permissionMode?: PermissionMode; permissionSource?: string;
    provider?: string; backend?: string; sdkApprovalPolicy?: 'ask' | 'deny';
    requireExplicitAccess?: boolean; profileSelection?: ProfileSelection; profileRequirements?: import('../ir').Json; resourceCapture?: 'stage' | 'workflow';
    chatPolicies?: Record<string, { permissionMode?: PermissionMode; sdkApprovalPolicy?: 'ask' | 'deny'; permissionSource?: string; profileSelection?: ProfileSelection; profileRequirements?: import('../ir').Json }> };
}
export type CompiledGraph = CompiledCanvas<GraphWorkflow> & {
  completions: Record<string, string>; optionalTools: string[]; needsProject: boolean;
}
const literal = (value: import('../ir').Json): Expression => ({ kind: 'literal', value })
const ref = (step: string, output: string): Reference => ({ kind: 'ref', source: 'step', step, output })
const object = (fields: Record<string, Expression>): Expression => ({ kind: 'object', fields })
const roles: Record<string, string> = { 'workflow.value': 'value', 'workflow.text': 'render', 'aixand.agents.spawn': 'spawn',
  'aixand.messaging.mailbox': 'mailbox', 'carrier.message.send': 'message', 'carrier.message.wait_for_reply': 'reply',
  'carrier.message.ack': 'ack', 'aixand.agent.send': 'send', 'aixand.agent.wait': 'wait', 'aixand.project.chat': 'chat', 'carrier.human.deliver': 'deliver' }
export function stableOperationId(nodeId: string, operation: string) {
  const token = nodeId.replace(/-/g, '').replace(/[^A-Za-z0-9_]/g, '_')
  if (token.length > 40 || !roles[operation]) throw new Error('This step cannot compile to a stable operation identity.')
  return `n_${token}_${roles[operation]}`
}

/** Templates never select a compiler. Each node contributes operations to one graph. */
export function compileCanvas(draft: CanvasDraft, namespace = 'preview', version: 1 | 2 = 2, identities: Record<string, string> = {}, execution?: { provider?: string; backend?: string }): CompiledGraph {
  const sdk = execution ? !!execution.backend && execution.backend !== 'native-codex' : undefined
  const issues = graphIssues(draft.nodes, draft.edges)
  if (!draft.name.trim() || draft.name.length > 120) issues.unshift('Enter a workflow name of up to 120 characters.')
  if (issues.length) throw new Error(issues.join('\n'))
  const ordered = graphOrder(draft.nodes, draft.edges)
  const steps: OperationStep[] = []
  const chatPolicies: NonNullable<GraphWorkflow['context']['chatPolicies']> = {}
  const dependencies: Record<string, string[]> = {}
  const invocations: Record<string, string> = {}
  const completions: Record<string, string> = {}
  const outputs = new Map<string, Expression>()
  const last = new Map<string, string>()
  const agents = new Map<string, string>()
  const terminalAgents: Record<string, string> = {}
  const receipts = new Map<string, { invocation: string; agent: string }>()
  const requests = new Map<string, { invocation: string; mailbox: string; agent: string }>()
  const replies = new Map<string, { invocation: string; request: string }>()
  const addresses = new Map<string, string>()
  const aliases = new Map<string, string>()
  const mailboxes = new Map<string, string>()
  const workflowInputs: Workflow['inputs'] = {}
  const prefix = `workflow/${namespace}/`
  for (const node of draft.nodes.filter((entry) => ['spawn', 'agent', 'tool', 'mailbox'].includes(entry.data.kind))) {
    const alias = node.data.address?.trim() || (['agent', 'tool'].includes(node.data.kind) ? `node_${node.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 54)}` : '')
    if (!alias) continue
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(alias)) throw new Error(`${node.data.label}: enter a valid inbox name.`)
    if (aliases.has(alias)) throw new Error(`${node.data.label}: each inbox needs a unique name.`)
    addresses.set(node.id, prefix + alias); aliases.set(alias, prefix + alias)
    if (node.data.kind === 'agent') aliases.set(`coordinator_${node.id}`, prefix + alias + '/coordinator')
  }
  const managed = draft.nodes.filter((node) => node.data.kind === 'agent')
  if (managed.length === 1 && !aliases.has('coordinator')) aliases.set('coordinator', addresses.get(managed[0].id)! + '/coordinator')
  const instruction = (text: string, coordinator?: string) => text.replace(/\{\{([^}]+)\}\}/g, (_match, alias: string) => {
    const address = alias.trim() === 'coordinator' && coordinator ? coordinator : aliases.get(alias.trim())
    if (!address) throw new Error(`Unknown inbox placeholder: {{${alias}}}.`)
    return address
  })
  const push = (node: WorkflowNode, operation: string, inputs: Record<string, Expression>, parents: string[]) => {
    const stable = version === 2 ? stableOperationId(node.id, operation) : ''
    const id = version === 1 ? `op_${steps.length + 1}` : identities[stable] ?? stable
    if (invocations[id]) throw new Error('Step identities must compile to distinct operation identities.')
    steps.push({ kind: 'operation', id, operation: { id: operation, version: operation === 'aixand.agents.spawn' && inputs.mcp ? '1.1.0' : '1.0.0' }, inputs })
    dependencies[id] = [...new Set(parents)].sort(); invocations[id] = node.id
    last.set(node.id, id)
    return id
  }
  const reports = (node: WorkflowNode): Expression => object(Object.fromEntries(dependencyEdges(draft.edges)
    .filter((edge) => edge.target === node.id).map((edge) => [edge.source, outputs.get(edge.source)!])))
  const upstream = (node: WorkflowNode, kind: string) => {
    const ancestors = graphAncestors(node.id, draft.edges)
    return ordered.filter((entry) => entry.data.kind === kind && ancestors.has(entry.id))
  }
  const sourceAgent = (node: WorkflowNode) => {
    const candidates = upstream(node, 'spawn')
    const maximal = candidates.filter((candidate) => !candidates.some((other) => other.id !== candidate.id && graphAncestors(other.id, draft.edges).has(candidate.id)))
    const id = node.data.agent || (maximal.length === 1 ? maximal[0].id : '')
    if (!id || !agents.has(id) || !graphAncestors(node.id, draft.edges).has(id)) throw new Error(`${node.data.label}: select an upstream spawned agent and connect its dependency path.`)
    return id
  }
  const spawn = (node: WorkflowNode, parents: string[], extra = '', coordinator?: string) => {
    const provider = node.data.provider ?? 'codex'
    if (!['codex', 'opencode'].includes(provider)) throw new Error(`${node.data.label}: choose Codex or OpenCode.`)
    if (addresses.has(node.id) && provider !== 'codex') throw new Error(`${node.data.label}: Carrier inboxes currently support Codex.`)
    const id = push(node, 'aixand.agents.spawn', {
      provider: literal(provider), profile: literal(node.data.profile?.trim() || 'default'), timeout: literal(300),
      ...(node.data.cwd?.trim() ? { cwd: literal(node.data.cwd.trim()) } : {}),
      ...(addresses.has(node.id) ? { address: literal(addresses.get(node.id)!) } : {}),
      ...(node.data.mcp ? { mcp: literal({ inherit: node.data.mcp.inherit ?? true, add: node.data.mcp.add ?? [], exclude: node.data.mcp.exclude ?? [] }) } : {}),
      ...(node.data.prompt.trim() || extra ? { instructions: literal(instruction(node.data.prompt + extra, coordinator)) } : {}),
    }, parents)
    agents.set(node.id, id); terminalAgents[node.id] = id
    return id
  }
  let finalReply: Reference | undefined
  let finalRequest: Reference | undefined
  for (const node of ordered) {
    const { data } = node
    const parents = dependencyEdges(draft.edges).filter((edge) => edge.target === node.id).map((edge) => last.get(edge.source)!)
    let result: Expression
    if (data.kind === 'input') {
      const name = data.inputName?.trim() || 'previous_result'
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name) || workflowInputs[name]) throw new Error('Workflow inputs need distinct names of up to 64 characters.')
      workflowInputs[name] = { type: { kind: 'json' } }
      result = ref(push(node, 'workflow.value', { value: { kind: 'ref', source: 'input', name } }, parents), 'value')
    } else if (data.kind === 'task') {
      if (!data.prompt.trim()) throw new Error(`${data.label}: enter a task.`)
      const value = parents.length ? object({ instruction: literal(data.prompt), reports: reports(node) }) : literal(data.prompt)
      result = ref(push(node, 'workflow.value', { value }, parents), 'value')
    } else if (['collector', 'done', 'result'].includes(data.kind)) {
      const inputs = dependencyEdges(draft.edges).filter((edge) => edge.target === node.id)
      const value = inputs.length === 1 && data.kind !== 'collector' ? outputs.get(inputs[0].source)! : reports(node)
      result = ref(push(node, 'workflow.value', { value }, parents), 'value')
      const prior = upstream(node, 'agent').at(-1) ?? upstream(node, 'spawn').at(-1)
      if (prior) terminalAgents[node.id] = terminalAgents[prior.id]
    } else if (data.kind === 'chat') {
      if (!data.prompt.trim() || data.prompt.length > 20000) throw new Error(`${data.label}: enter role instructions of up to 20000 characters.`)
      if (!data.label.trim() || data.label.length > 120) throw new Error('Give every chat a name of up to 120 characters.')
      const id = push(node, 'aixand.project.chat', { title: literal(data.label), instruction: literal(data.prompt), reports: reports(node) }, parents)
      if (data.permissionMode || data.sdkApprovalPolicy || data.profileSelection) chatPolicies[id] = {
        ...(sdk !== false && data.sdkApprovalPolicy ? { sdkApprovalPolicy: data.sdkApprovalPolicy } : {}),
        ...(sdk !== true && data.permissionMode ? { permissionMode: data.permissionMode, permissionSource: 'stage' } : {}),
        ...(data.profileSelection ? { profileSelection: data.profileSelection } : {}),
      }
      result = ref(id, 'result')
    } else if (data.kind === 'human-inbox') {
      const inputs = dependencyEdges(draft.edges).filter((edge) => edge.target === node.id)
      result = ref(push(node, 'carrier.human.deliver', { title: literal(draft.name), value: inputs.length === 1 ? outputs.get(inputs[0].source)! : reports(node) }, parents), 'delivery')
    } else if (data.kind === 'agent') {
      const tools = draft.edges.filter((edge) => edge.source === node.id && edge.sourceHandle === 'tools').map((edge) => draft.nodes.find((entry) => entry.id === edge.target)!).sort((a, b) => a.id.localeCompare(b.id))
      const coordinator = addresses.get(node.id)! + '/coordinator'
      const toolSpawns = tools.map((tool) => spawn(tool, parents, '', coordinator))
      const available = tools.map((tool) => `- ${tool.data.label} at ${addresses.get(tool.id)}: ${tool.data.description}`).join('\n')
      const main = spawn(node, [...parents, ...toolSpawns], `\nAvailable optional advisers:\n${available || 'None.'}\nYou choose whether to consult advisers; no tool call is required. Treat prerequisite reports as evidence. Complete the original job and return your complete final result to ${coordinator}, with reply_to set to the original job's numeric message ID. End your turn after sending the result.`, coordinator)
      const mailbox = push(node, 'aixand.messaging.mailbox', { address: literal(coordinator) }, [main])
      const text = push(node, 'workflow.text', { value: reports(node) }, [mailbox])
      const message = push(node, 'carrier.message.send', { mailbox: ref(mailbox, 'mailbox'), to: literal(addresses.get(node.id)!), content: ref(text, 'text'), idempotency_key: literal(`task:${node.id}`) }, [text])
      finalRequest = ref(message, 'snapshot')
      const reply = push(node, 'carrier.message.wait_for_reply', { mailbox: ref(mailbox, 'mailbox'), message: ref(message, 'message'), sender: literal(addresses.get(node.id)!), timeout: literal(600) }, [message])
      const ack = push(node, 'carrier.message.ack', { message: ref(reply, 'message') }, [reply])
      push(node, 'aixand.agent.wait', { agent: ref(main, 'agent'), timeout: literal(300), stable_for: literal(2) }, [ack])
      result = ref(reply, 'snapshot'); finalReply = { ...ref(reply, 'snapshot'), path: ['content'] }
    } else if (data.kind === 'spawn') {
      result = object({ runId: ref(spawn(node, parents), 'run_id') })
    } else if (data.kind === 'send' || data.kind === 'wait') {
      const agent = sourceAgent(node); const id = agents.get(agent)!; terminalAgents[node.id] = id
      if (data.kind === 'send') {
        if (!data.prompt.trim()) throw new Error(`${data.label}: enter instructions.`)
        const previous = upstream(node, 'send').filter((entry) => receipts.get(entry.id)?.agent === agent)
        if (previous.some((entry) => !upstream(node, 'wait').some((wait) => graphAncestors(wait.id, draft.edges).has(entry.id) && terminalAgents[wait.id] === id))) throw new Error(`${data.label}: wait for the previous instruction before sending another.`)
        const text = push(node, 'workflow.text', { value: object({ instruction: literal(instruction(data.prompt)), reports: reports(node) }) }, parents)
        const invocation = push(node, 'aixand.agent.send', { agent: ref(id, 'agent'), text: ref(text, 'text'), timeout: literal(300) }, [text])
        receipts.set(node.id, { invocation, agent }); result = object({ sent: literal(data.prompt) })
      } else {
        const sends = upstream(node, 'send').filter((entry) => receipts.get(entry.id)?.agent === agent)
        const send = sends.at(-1)
        if (!send && !addresses.has(agent)) throw new Error(`${data.label}: send an instruction before waiting.`)
        const invocation = push(node, 'aixand.agent.wait', { agent: ref(id, 'agent'), timeout: literal(300), stable_for: literal(2), ...(send ? { after: ref(receipts.get(send.id)!.invocation, 'receipt') } : {}) }, parents)
        result = ref(invocation, 'observation')
      }
    } else if (data.kind === 'mailbox') {
      if (!data.address?.trim()) throw new Error(`${data.label}: enter an inbox name.`)
      const invocation = push(node, 'aixand.messaging.mailbox', { address: literal(addresses.get(node.id)!) }, parents)
      mailboxes.set(node.id, invocation); result = literal({ inbox: data.address })
    } else if (data.kind === 'message') {
      const agent = sourceAgent(node); const mailbox = mailboxes.get(data.mailbox ?? '')
      if (!mailbox || !graphAncestors(node.id, draft.edges).has(data.mailbox!)) throw new Error(`${data.label}: select an upstream sender inbox.`)
      if (!addresses.has(agent)) throw new Error(`${data.label}: the recipient agent needs a Carrier inbox.`)
      if (!data.prompt.trim()) throw new Error(`${data.label}: enter a message.`)
      const text = push(node, 'workflow.text', { value: object({ instruction: literal(instruction(data.prompt)), reports: reports(node) }) }, parents)
      const invocation = push(node, 'carrier.message.send', { mailbox: ref(mailbox, 'mailbox'), to: literal(addresses.get(agent)!), content: ref(text, 'text'), idempotency_key: literal(`task:${node.id}`) }, [text])
      requests.set(node.id, { invocation, mailbox, agent }); terminalAgents[node.id] = agents.get(agent)!
      result = ref(invocation, 'snapshot')
    } else if (data.kind === 'reply') {
      const request = requests.get(data.message ?? '')
      if (!request || !graphAncestors(node.id, draft.edges).has(data.message!)) throw new Error(`${data.label}: select an upstream original task.`)
      const invocation = push(node, 'carrier.message.wait_for_reply', { mailbox: ref(request.mailbox, 'mailbox'), message: ref(request.invocation, 'message'), sender: literal(addresses.get(request.agent)!), timeout: literal(600) }, parents)
      replies.set(node.id, { invocation, request: data.message! }); terminalAgents[node.id] = agents.get(request.agent)!
      result = ref(invocation, 'snapshot'); finalReply = { ...ref(invocation, 'snapshot'), path: ['content'] }; finalRequest = ref(request.invocation, 'snapshot')
    } else if (data.kind === 'ack') {
      const reply = replies.get(data.message ?? '')
      if (!reply || !graphAncestors(node.id, draft.edges).has(data.message!)) throw new Error(`${data.label}: select an upstream received reply.`)
      if (ordered.some((entry) => entry.id !== node.id && entry.data.kind === 'ack' && entry.data.message === data.message && last.has(entry.id))) throw new Error(`${data.label}: this reply was already acknowledged.`)
      push(node, 'carrier.message.ack', { message: ref(reply.invocation, 'message') }, parents)
      terminalAgents[node.id] = terminalAgents[data.message!]; result = outputs.get(data.message!)!
    } else throw new Error(`${data.label}: unsupported node.`)
    outputs.set(node.id, result)
    completions[last.get(node.id)!] = node.id
  }
  for (const [id, receipt] of receipts) {
    if ([...receipts].some(([other, value]) => other !== id && value.agent === receipt.agent && !graphAncestors(id, draft.edges).has(other) && !graphAncestors(other, draft.edges).has(id))) throw new Error('Instructions to the same session must be ordered with waits; use separate sessions for parallel tasks.')
    if (!ordered.some((node) => node.data.kind === 'wait' && graphAncestors(node.id, draft.edges).has(id) && terminalAgents[node.id] === agents.get(receipt.agent))) throw new Error('Wait for every sent instruction before finishing the workflow.')
  }
  for (const [id] of requests) {
    const matching = [...replies].filter(([, value]) => value.request === id)
    if (!matching.some(([replyId]) => ordered.some((node) => node.data.kind === 'ack' && node.data.message === replyId))) throw new Error('Wait for and acknowledge every Carrier task’s reply before finishing the workflow.')
  }
  const terminal = ordered.filter((node) => !dependencyEdges(draft.edges).some((edge) => edge.source === node.id))
  const irOutputs: Workflow['outputs'] = Object.fromEntries(terminal.map((node, index) => [`output_${index + 1}`, { type: { kind: 'json' }, value: outputs.get(node.id)! }]))
  if (version === 2) {
    const results = terminal.flatMap((node) => node.data.kind === 'human-inbox'
      ? dependencyEdges(draft.edges).filter((edge) => edge.target === node.id).map((edge) => [edge.source, outputs.get(edge.source)!] as const)
      : [[node.id, outputs.get(node.id)!] as const])
    irOutputs.result = { type: { kind: 'json' }, value: results.length === 1 ? results[0][1] : object(Object.fromEntries(results)) }
    for (const node of ordered.filter((entry) => entry.data.exportName?.trim())) {
      const name = node.data.exportName!.trim()
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name) || irOutputs[name]) throw new Error('Result export names must be distinct identifiers.')
      irOutputs[name] = { type: { kind: 'json' }, value: outputs.get(node.id)! }
    }
  }
  let spawnIndex = 0; let waitIndex = 0
  for (const step of steps) {
    if (step.operation.id === 'aixand.agents.spawn') irOutputs[`spawn_${++spawnIndex}_run_id`] = { type: { kind: 'string' }, value: ref(step.id, 'run_id') }
    if (step.operation.id === 'aixand.agent.wait') irOutputs[`wait_${++waitIndex}_observation`] = { type: { kind: 'json' }, value: ref(step.id, 'observation') }
  }
  if (finalReply?.source === 'step') irOutputs.final_reply = { type: { kind: 'json' }, value: ref(finalReply.step, finalReply.output) }
  if (finalRequest) irOutputs.message_1_request = { type: { kind: 'json' }, value: finalRequest }
  if (finalReply) irOutputs.final_reply_text = { type: { kind: 'string' }, value: finalReply }
  return {
    workflow: { format: 'aixand.workflow-graph', version, workflow: { ir_version: '0.1', name: draft.name, description: draft.description, inputs: workflowInputs, body: { kind: 'sequence', steps }, outputs: irOutputs }, dependencies, context: {
      ...(execution?.backend ? { provider: execution.provider, backend: execution.backend } : {}),
      ...(sdk !== true && draft.native?.permissionMode ? { permissionMode: draft.native.permissionMode, permissionSource: 'workflow' } : {}),
      ...(draft.native?.profileSelection ? { profileSelection: draft.native.profileSelection } : {}),
      ...(sdk !== false && draft.native?.sdkApprovalPolicy ? { sdkApprovalPolicy: draft.native.sdkApprovalPolicy } : {}),
      ...(draft.native?.resourceCapture ? { resourceCapture: draft.native.resourceCapture } : {}),
      ...(Object.keys(chatPolicies).length ? { chatPolicies } : {}),
    },
      ...(version === 2 ? { groups: Object.fromEntries(draft.nodes.map((node) => [node.id, Object.entries(invocations).filter(([, id]) => id === node.id).map(([id]) => id)] as const).filter(([, ids]) => ids.length)),
        ...(Object.keys(identities).length ? { identities } : {}) } : {}) },
    invocations, order: ordered.map((node) => node.id), namespace, terminalAgents, completions,
    optionalTools: [...new Set(draft.edges.filter((edge) => edge.sourceHandle === 'tools').map((edge) => edge.target))].sort(),
    needsProject: ordered.some((node) => node.data.kind === 'chat'),
  }
}
