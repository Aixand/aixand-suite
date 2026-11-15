import { permissionModes } from '../../agents/permissions'
import type { PermissionMode } from '../../agents/permissions'
import { ProfilePicker, ProfileResolution } from '../../agents/profileSelection'
import { permissionLabel } from '../../agents/permissions'
import type { RunNodeDetails } from './RunNodeContext'
import { Button, Icon, Select, TextField, Textarea } from 'bbb-design'
import { useState } from 'react'
import type { Connection, Edge } from '@xyflow/react'
import { BuilderIcon } from './StepNode'
import { connectionAllowed, suggestedConnection } from './model'
import type { CanvasDraft, StepData, WorkflowNode } from './model'
import type { AgentsModel } from '../../agents/model'
import { McpPicker } from '../../agents/mcp'

export function Inspector({
  runtime,
  draft,
  agents,
  node,
  edge,
  updateDraft,
  updateNode,
  updateEdge,
  connect,
  remove,
  duplicate,
  close,
  readOnly = false,
  addAfter,
}: {
  draft: CanvasDraft
  agents?: AgentsModel
  node?: WorkflowNode
  edge?: Edge
  updateDraft: (
    data: Partial<Pick<CanvasDraft, 'name' | 'description'>>,
  ) => void
  updateNode: (data: Partial<StepData>) => void
  updateEdge: (label: string) => void
  connect: (connection: Connection) => void
  remove: () => void
  duplicate: () => void
  close: () => void
  readOnly?: boolean
  runtime?: RunNodeDetails
  addAfter?: (insert: boolean) => void
}) {
  const data = node?.data
  const incoming = draft.edges.filter((link) => link.target === node?.id)
  return (
    <aside className="wb-inspector" aria-label="Workflow settings">
      <header className="wb-panel-heading">
        <h2>
          {node ? 'Step settings' : edge ? 'Connection' : 'Workflow settings'}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Close settings"
          onPress={close}
        >
          <Icon name="x" />
        </Button>
      </header>
      <div className="wb-inspector-body">
        {readOnly && <p role="status">This step has started. Its assigned instructions and inputs are fixed.</p>}
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {data ? (
          <>
            <div className="wb-inspector-summary">
              <span className={`wb-step-icon wb-step-icon--${data.kind}`}>
                <BuilderIcon kind={data.kind} />
              </span>
              <div>
                <strong>{data.label || 'Untitled step'}</strong>
                <span>{data.kind}</span>
              </div>
            </div>
            <TextField
              label="Step name"
              value={data.label}
              maxLength={120}
              onChange={(event) => updateNode({ label: event.target.value })}
            />
            <Textarea
              label="Description"
              value={data.description}
              rows={2}
              maxLength={500}
              onChange={(event) =>
                updateNode({ description: event.target.value })
              }
            />
            {['spawn', 'agent', 'tool'].includes(data.kind) && (
              <>
                <Select
                  label="Provider"
                  value={data.provider ?? 'codex'}
                  options={[
                    { id: 'codex', label: 'Codex' },
                    ...(data.kind === 'spawn' ? [{ id: 'opencode', label: 'OpenCode' }] : []),
                  ]}
                  onChange={(provider) => updateNode({ provider })}
                />
                <TextField
                  label="Agent profile"
                  value={data.profile ?? 'default'}
                  maxLength={120}
                  onChange={(event) =>
                    updateNode({ profile: event.target.value })
                  }
                  hint="Use a configured Agent Manager profile."
                />
                <TextField
                  label="Working directory"
                  value={data.cwd ?? ''}
                  maxLength={2000}
                  placeholder="Runner’s working directory"
                  onChange={(event) => updateNode({ cwd: event.target.value })}
                />
                <TextField label="Carrier inbox name" value={data.address ?? ''} maxLength={64}
                  placeholder="Optional, e.g. brain"
                  hint="Each run gets a fresh address for this inbox."
                  onChange={(event) => updateNode({ address: event.target.value })} />
                {agents && <McpPicker agents={agents} provider={(data.provider ?? 'codex') as 'codex' | 'opencode'}
                  profile={data.profile || 'default'} cwd={data.cwd} value={data.mcp}
                  onChange={(mcp) => updateNode({ mcp })} />}
                <Textarea label="Role instructions" value={data.prompt} rows={6} maxLength={10000}
                  placeholder="Describe this agent’s role."
                  hint="Use {{brain}}, {{implementer}}, or another inbox name to reference its address."
                  onChange={(event) => updateNode({ prompt: event.target.value })} />
                {data.kind === 'tool' ? <p className="wb-muted">This tool stays idle until the main agent asks for help. Its side connection allows questions and replies; no call is required.</p>
                  : data.address?.trim() && <p className="wb-muted">Carrier messages are delivered to this agent’s terminal. The agent sends replies through its Carrier tools.</p>}
              </>
            )}
            {data.kind === 'input' && <TextField label="Workflow input name" value={data.inputName ?? 'previous_result'}
              maxLength={64} onChange={(event) => updateNode({ inputName: event.target.value })}
              hint="A follow-up workflow can receive the previous workflow’s result here." />}
            {data.kind !== 'tool' && <TextField label="Result export name" value={data.exportName ?? ''}
              maxLength={64} onChange={(event) => updateNode({ exportName: event.target.value })}
              hint="Optional name for passing this step’s result to another workflow." />}
            {data.kind === 'chat' && <>
              {runtime?.selection && <>
                <p>{runtime.selection.sdkApprovalPolicy ? 'Tool approvals: ' + runtime.selection.sdkApprovalPolicy : 'Access: ' + permissionLabel(runtime.selection.permissionMode ?? 'read-only')} · {runtime.selection.permissionSource ?? 'legacy'}</p>
                <ProfileResolution requested={runtime.selection.requested} decision={runtime.selection.decision} />
              </>}
              <Textarea label="Role instructions" value={data.prompt} rows={7} maxLength={20000}
                placeholder="Describe what this chat should do."
                onChange={(event) => updateNode({ prompt: event.target.value })} />
              {runtime?.selection?.sdkApprovalPolicy ? <Select label="Stage tool approvals" value={data.sdkApprovalPolicy ?? 'inherit'}
                options={[{ id: 'inherit', label: 'Inherit workflow policy' }, { id: 'ask', label: 'Ask for approval' }, { id: 'deny', label: 'Deny approval prompts' }]}
                onChange={value => updateNode({ permissionMode: undefined, sdkApprovalPolicy: value === 'inherit' ? undefined : value as 'ask' | 'deny' })} /> : <Select label="Stage access" value={data.permissionMode ?? 'inherit'} options={[{ id: 'inherit', label: 'Inherit workflow / saved default' }, ...permissionModes]}
                onChange={(mode) => updateNode({ permissionMode: mode === 'inherit' ? undefined : mode as PermissionMode })} />}
              <ProfilePicker label="Stage profile" inherit allowAuto={!runtime?.selection?.sdkApprovalPolicy} value={data.profileSelection} onChange={(profileSelection) => updateNode({ profileSelection })} />
              <p className="wb-muted">Uses the workflow's project. All connected prerequisite reports are received and acknowledged before this chat starts.</p>
            </>}
            {data.kind === 'collector' && <p className="wb-muted">Collects every connected node’s completed output. All prerequisites must succeed before downstream work starts. Native chat reports are acknowledged through Carrier before becoming available.</p>}
            {data.kind === 'human-inbox' && <p className="wb-muted">Delivers the connected nodes’ completed output to your human Main inbox. This inbox is kept for you to review.</p>}
            {data.kind === 'task' && <Textarea label="Task" value={data.prompt} rows={6} maxLength={10000}
              onChange={(event) => updateNode({ prompt: event.target.value })} />}
            {data.kind === 'agent' && <p className="wb-muted">This agent owns the task and decides whether to use connected tools. It can finish without consulting them.</p>}
            {data.kind === 'result' && <p className="wb-muted">Collects completed prerequisite outputs. Connect it to another task, a Collector, or Main inbox to continue; an unconnected output finishes this path.</p>}
            {(data.kind === 'send' || data.kind === 'wait') && (
              <>
                <Select
                  label="Agent session"
                  value={data.agent}
                  options={[
                    { id: '', label: 'Most recently spawned agent' },
                    ...draft.nodes
                      .filter((step) => step.data.kind === 'spawn')
                      .map((step) => ({ id: step.id, label: step.data.label })),
                  ]}
                  onChange={(agent) => updateNode({ agent })}
                />
                {data.kind === 'send' ? (
                  <Textarea
                    label="Instructions"
                    value={data.prompt}
                    rows={5}
                    maxLength={10000}
                    placeholder="Say hi."
                    onChange={(event) =>
                      updateNode({ prompt: event.target.value })
                    }
                  />
                ) : (
                  <p className="wb-muted">
                    {draft.nodes.find((step) => step.id === data.agent)?.data.address
                      ? 'Waits for this agent’s terminal to become ready after its current response. Final task completion is established by the Carrier reply.'
                      : 'Waits for this agent’s preceding instruction to finish, using its send receipt. The next step starts afterward.'}
                  </p>
                )}
              </>
            )}
            {data.kind === 'mailbox' && <>
              <TextField label="Inbox name" value={data.address ?? ''} maxLength={64}
                placeholder="coordinator" onChange={(event) => updateNode({ address: event.target.value })} />
              <p className="wb-muted">The workflow owns this inbox. Agent inboxes are configured on Spawn agent nodes.</p>
            </>}
            {data.kind === 'message' && <>
              <Select label="Sender inbox" value={data.mailbox ?? ''}
                options={draft.nodes.filter((step) => step.data.kind === 'mailbox').map((step) => ({ id: step.id, label: step.data.label }))}
                onChange={(mailbox) => updateNode({ mailbox })} />
              <Select label="Recipient agent" value={data.agent}
                options={draft.nodes.filter((step) => step.data.kind === 'spawn' && step.data.address?.trim()).map((step) => ({ id: step.id, label: step.data.label }))}
                onChange={(agent) => updateNode({ agent })} />
              <Textarea label="Message" value={data.prompt} rows={6} maxLength={10000}
                onChange={(event) => updateNode({ prompt: event.target.value })} />
              <p className="wb-muted">Sending stores the task. Connect a reply wait to collect the recipient’s final answer.</p>
            </>}
            {(data.kind === 'reply' || data.kind === 'ack') && <>
              <Select label={data.kind === 'reply' ? 'Original task' : 'Received reply'} value={data.message ?? ''}
                options={draft.nodes.filter((step) => step.data.kind === (data.kind === 'reply' ? 'message' : 'reply')).map((step) => ({ id: step.id, label: step.data.label }))}
                onChange={(message) => updateNode({ message })} />
              <p className="wb-muted">{data.kind === 'reply'
                ? 'Waits up to 10 minutes for the original recipient’s reply to this exact task. A delivery receipt or terminal readiness does not complete this step.'
                : 'Acknowledges the received reply after the workflow has collected it. Message history is retained.'}</p>
            </>}
            {data.kind === 'done' && (
              <p className="wb-muted">
                The workflow finishes after all instructions complete and its
                agent sessions close. Carrier workflows also return the final reply.
              </p>
            )}
            <div className="wb-field-divider">
              <h3>Connected from</h3>
              <span>{incoming.length}</span>
            </div>
            {incoming.length ? (
              <ul className="wb-incoming">
                {incoming.map((link) => (
                  <li key={link.id}>
                    <Icon name="arrow-down" />
                    <span>
                      {
                        draft.nodes.find((step) => step.id === link.source)
                          ?.data.label
                      }
                    </span>
                    {link.label && <small>{String(link.label)}</small>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="wb-muted">
                {data.kind === 'spawn' || data.kind === 'task' || data.kind === 'chat'
                  ? 'This is a starting point.'
                  : data.kind === 'tool' ? 'Connect the main agent’s side port to this tool’s left port.'
                  : 'Connect a step to this node’s top port.'}
              </p>
            )}
            {!['done', 'tool', 'human-inbox'].includes(data.kind) && node && (
              <NextStep
                key={node.id}
                node={node}
                draft={draft}
                connect={connect}
              />
            )}
            <div className="wb-inspector-actions">
              <Button variant="secondary" size="sm" onPress={duplicate}>
                <Icon name="layers" />
                Duplicate
              </Button>
              <Button variant="ghost" size="sm" onPress={remove}>
                <Icon name="trash-2" />
                Delete step
              </Button>
            </div>
          </>
        ) : edge ? (
          <>
            {edge.sourceHandle === 'tools' && <p className="wb-muted">Optional tool connection. The main agent decides whether to ask questions; replies return on the same route.</p>}
            <div className="wb-connection-summary">
              <strong>
                {
                  draft.nodes.find((step) => step.id === edge.source)?.data
                    .label
                }
              </strong>
              <Icon name="arrow-down" />
              <strong>
                {
                  draft.nodes.find((step) => step.id === edge.target)?.data
                    .label
                }
              </strong>
            </div>
            <TextField
              label="Connection label"
              value={typeof edge.label === 'string' ? edge.label : ''}
              maxLength={80}
              onChange={(event) => updateEdge(event.target.value)}
            />
            <Button variant="secondary" onPress={remove}>
              <Icon name="trash-2" />
              Delete connection
            </Button>
          </>
        ) : (
          <>
            <div className="wb-inspector-summary">
              <span className="wb-step-icon wb-step-icon--spawn">
                <BuilderIcon kind="workflow" />
              </span>
              <div>
                <strong>Your workflow</strong>
                <span>{'Workflow graph'}</span>
              </div>
            </div>
            <TextField
              label="Workflow name"
              value={draft.name}
              maxLength={120}
              onChange={(event) => updateDraft({ name: event.target.value })}
            />
            <Textarea
              label="Workflow description"
              value={draft.description}
              rows={4}
              maxLength={1000}
              placeholder="What should this workflow do?"
              onChange={(event) =>
                updateDraft({ description: event.target.value })
              }
            />
            <div className="wb-field-divider">
              <h3>At a glance</h3>
            </div>
            <dl className="wb-facts">
              <div>
                <dt>Steps</dt>
                <dd>{draft.nodes.length}</dd>
              </div>
              <div>
                <dt>Connections</dt>
                <dd>{draft.edges.length}</dd>
              </div>
              <div>
                <dt>Shape</dt>
                <dd>{'Dependencies and optional advisers'}</dd>
              </div>
            </dl>
            <div className="wb-info">
              <Icon name="info" />
              <p>
                Select a step to edit its settings. Drag between ports to
                connect steps.
              </p>
            </div>
          </>
        )}
        <p className="wb-inspector-footnote">
          Required connections consume completed outputs. Independent nodes run together. Side connections make advisers available when an agent needs them. Sessions close when the whole workflow ends.
        </p>
        </fieldset>
        {addAfter && <>
          <Button variant="secondary" onPress={() => addAfter(false)}>Add dependent task</Button>
          <Button variant="secondary" onPress={() => addAfter(true)}>Insert next task</Button>
        </>}
      </div>
    </aside>
  )
}

function NextStep({
  node,
  draft,
  connect,
}: {
  node: WorkflowNode
  draft: CanvasDraft
  connect: (connection: Connection) => void
}) {
  const [target, setTarget] = useState<string | null>(null)
  const connection = (id: string): Connection => suggestedConnection(node, draft.nodes.find((step) => step.id === id)!)
  const options = draft.nodes
    .filter((step) =>
      connectionAllowed(connection(step.id), draft.nodes, draft.edges),
    )
    .map((step) => ({ id: step.id, label: step.data.label || 'Untitled step' }))
  const validTarget = options.some((option) => option.id === target)
    ? target
    : null
  return (
    <>
      <div className="wb-field-divider">
        <h3>Connect a next step</h3>
      </div>
      <Select
        label="Next step"
        value={validTarget}
        options={options}
        placeholder="Choose a step"
        onChange={setTarget}
        disabled={!options.length}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={!validTarget}
        onPress={() => {
          if (validTarget) {
            connect(connection(validTarget))
            setTarget(null)
          }
        }}
      >
        <Icon name="plus" />
        Connect step
      </Button>
    </>
  )
}
