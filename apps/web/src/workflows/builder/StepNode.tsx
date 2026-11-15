import { memo, useContext } from 'react'
import { Button, Icon } from 'bbb-design'
import type { IconName } from 'bbb-design'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { NodeKind, WorkflowNode } from './model'
import { hasAgentTerminal } from './model'
import { RunStatusContext } from './useWorkflowRun'
import { TerminalPreviewContext } from './TerminalPreview'
import { RunNodeContext } from './RunNodeContext'

const builderIcons = {
  workflow: 'workflow',
  input: 'inbox',
  spawn: 'bot',
  send: 'send',
  wait: 'clock',
  mailbox: 'inbox',
  message: 'send',
  reply: 'message-square-reply',
  ack: 'circle-check',
  done: 'square-check',
  task: 'send',
  agent: 'bot',
  tool: 'wrench',
  result: 'square-check',
  chat: 'messages-square',
  collector: 'combine',
  'human-inbox': 'inbox',
} as const satisfies Record<NodeKind | 'workflow', IconName>

export function BuilderIcon({ kind }: { kind: NodeKind | 'workflow' }) {
  return <Icon name={builderIcons[kind]} />
}

export const StepNode = memo(function StepNode({
  id,
  data,
  selected,
  isConnectable,
}: NodeProps<WorkflowNode>) {
  const execution = useContext(RunNodeContext)[id]
  const status = useContext(RunStatusContext)[id] ?? execution?.state
  const preview = useContext(TerminalPreviewContext)
  return (
    <div
      className={`wb-node wb-node--${data.kind}${selected ? ' wb-node--selected' : ''}${status ? ` wb-node--${status}` : ''}`}
    >
      {data.kind !== 'tool' && <Handle
        role="img"
        type="target"
        position={Position.Top}
        id="in"
        aria-label={`Input of ${data.label}`}
        isConnectable={isConnectable}
      />}
      {data.kind === 'tool' && <Handle role="img" type="target" position={Position.Left} id="request" aria-label={`Tool connection of ${data.label}`} />}
      <div className="wb-node-heading">
        <span className={`wb-step-icon wb-step-icon--${data.kind}`}>
          <BuilderIcon kind={data.kind} />
        </span>
        <span className="wb-node-kind">{execution?.kindLabel ?? (data.kind === 'chat' ? 'Project chat' : data.kind === 'collector' ? 'Report join' : data.kind === 'human-inbox' ? 'For you' : data.kind)}</span>
        {data.kind === 'tool' && <span className="wb-node-optional">Optional</span>}
        {status ? (
          <span className="wb-node-run-status">{execution?.statusLabel ?? status}</span>
        ) : null}
        {hasAgentTerminal(data.kind) && !execution && (
          <button type="button" className="wb-node-terminal nodrag nopan"
            aria-label={`Preview terminal for ${data.label}`}
            title="Preview terminal"
            onClick={(event) => { event.stopPropagation(); preview(id) }}>
            <Icon name="square-terminal" />
          </button>
        )}
      </div>
      <strong>{data.label || 'Untitled step'}</strong>
      <p>{execution?.detail ?? (data.description || 'Select this step to configure it.')}</p>
      {['spawn', 'agent', 'tool'].includes(data.kind) && (
        <span className="wb-node-meta">
          {execution?.meta ?? `${data.provider ?? 'codex'} · ${data.profile || 'default'}`}
        </span>
      )}
      {data.kind === 'chat' && <span className="wb-node-meta">{execution?.meta ?? `${data.permissionMode ?? 'Inherited access'} · ${data.profileSelection?.mode === 'specific' ? data.profileSelection.profile : data.profileSelection?.mode ?? 'Inherit workflow profile'}`}</span>}
      {execution?.open && <div className="wb-node-run-action nodrag nopan" onClick={(event) => event.stopPropagation()}>
        <Button variant="ghost" size="sm" onPress={execution.open}>{execution.actionLabel}</Button>
      </div>}
      {!['done', 'tool', 'human-inbox'].includes(data.kind) && (
        <Handle
          role="img"
          type="source"
          position={Position.Bottom}
          id="out"
          aria-label={`Output of ${data.label}`}
          isConnectable={isConnectable}
        />
      )}
      {data.kind === 'agent' && !execution && <Handle role="img" type="source" position={Position.Right} id="tools" aria-label={`Optional tools of ${data.label}`} />}
    </div>
  )
})
