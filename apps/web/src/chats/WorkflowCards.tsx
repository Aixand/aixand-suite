import { useState } from 'react'
import { Button } from 'bbb-design'
import type { ChatWorkflow } from './model'
import { permissionLabel } from '../agents/permissions'
import { workflowActionFeedback, workflowGuidance } from '../workflows/feedback'

export const workflowLabels: Record<string, string> = {
  report_pending: 'Work finished · report delivery pending',
  pending: 'Waiting for prerequisites', prepared: 'Preparing', creating: 'Creating chat', created: 'Chat created', starting: 'Starting',
  queued: 'Queued', submitting: 'Submitting', running: 'Running', waiting: 'Needs your response', completed: 'Completed',
  cancelled: 'Cancelled', failed: 'Failed', uncertain: 'Needs reconciliation', offline: 'Reconnecting', blocked: 'Blocked',
  'waiting-for-reports': 'Waiting for reports', 'pending-delivery': 'Awaiting delivery', delivered: 'Delivered', 'failure-delivered': 'Failure delivered',
}

export function WorkflowCards({ workflows, connected, onOpen, onInbox, onAction, onView }: {
  workflows: ChatWorkflow[]; connected: boolean; onOpen: (chatId: string) => void; onInbox: (messageId?: number) => void;
  onAction: (workflow: ChatWorkflow, action: 'status' | 'cancel' | 'resume') => Promise<unknown>;
  onView?: (key: string) => void;
}) {
  const [pending, setPending] = useState<{ key: string; action: keyof typeof workflowActionFeedback } | null>(null)
  const [feedback, setFeedback] = useState<{ key: string; error?: string; message?: string } | null>(null)
  if (!workflows.length) return null
  async function act(workflow: ChatWorkflow, action: 'status' | 'cancel' | 'resume') {
    if (pending) return
    setPending({ key: workflow.key, action }); setFeedback(null)
    try { await onAction(workflow, action); setFeedback({ key: workflow.key, message: action === 'cancel' ? 'Cancellation requested. Check progress for confirmation.' : action === 'resume' ? 'Resume requested. Check progress for confirmation.' : 'Workflow status checked.' }) }
    catch (cause) { setFeedback({ key: workflow.key, error: cause instanceof Error ? cause.message : 'The request could not be confirmed. Check the workflow status before trying again.' }) }
    finally { setPending(null) }
  }
  return <section className="command-launches" aria-label="Chat workflows">
    <h2>Chat workflows</h2>
    {workflows.map((workflow) => <article className="command-launch-card" key={workflow.key} aria-label={workflow.title}>
      <strong>{workflow.title}</strong>
      <p className="command-launch-context">{workflow.project} · Project chats</p>
      <p role="status">{workflowLabels[workflow.state] ?? workflow.state}{!connected && ' · Reconnect to refresh progress'}</p>
      <p className="command-launch-context">{workflowGuidance(workflow, connected)}</p>
      <ol className="native-workflow-stages">
        {workflow.steps.map((step) => <li key={step.id}>
          <strong>{step.title}</strong> · {['completed', 'failed', 'interrupted', 'cancelled'].includes(step.executionState ?? '') && step.reportState === 'pending' ? 'Work finished · report delivery pending' : workflowLabels[step.state] ?? step.state}
          <p>{permissionLabel(step.permissionMode ?? 'read-only')}</p>
          {step.dependsOn.length > 0 && <p>Starts after successful reports from {step.dependsOn.join(' and ')} reach the collector inbox.</p>}
          {step.conversationDeleted && <p>Conversation deleted</p>}
          {step.error && <p className="command-launch-error">{step.error}</p>}
          {step.chat_id && !step.conversationDeleted && <Button variant="ghost" size="sm" onPress={() => onOpen(step.chat_id!)}>{step.state === 'waiting' ? 'Open chat to respond' : `Open ${step.title.toLowerCase()}`}</Button>}
        </li>)}
      </ol>
      {workflow.error && <p className="command-launch-error">{workflow.error}</p>}
      {workflow.delivery && <p>Delivered to main inbox · Message {workflow.delivery.message_id}</p>}
      <div className="command-answer-options">
        {onView && <Button variant="ghost" size="sm" onPress={() => onView(workflow.key)}>View workflow</Button>}
        <Button variant={workflow.delivery ? 'secondary' : 'ghost'} size="sm" onPress={() => onInbox(workflow.delivery?.message_id)}>{workflow.delivery ? 'Read report in Carrier' : 'Open main inbox'}</Button>
        {(['queued', 'running', 'uncertain', 'submitting'].includes(workflow.state) || (!workflow.id && workflow.state === 'failed')) && <Button variant="ghost" size="sm" disabled={!connected || !!pending}
          loading={pending?.key === workflow.key && pending.action !== 'cancel'}
          onPress={() => { void act(workflow, workflow.id && workflow.state === 'uncertain' ? 'resume' : 'status') }}>{workflow.id && workflow.state === 'uncertain' ? 'Resume existing run' : 'Check status'}</Button>}
        {['queued', 'running', 'uncertain', 'submitting'].includes(workflow.state) && <Button variant="ghost" size="sm" disabled={!connected || !!pending}
          loading={pending?.key === workflow.key && pending.action === 'cancel'}
          onPress={() => { void act(workflow, 'cancel') }}>Cancel workflow</Button>}
      </div>
      <p role="status" className="workflow-action-feedback">{pending?.key === workflow.key ? workflowActionFeedback[pending.action] : feedback?.key === workflow.key ? feedback.message : ''}</p>
      {feedback?.key === workflow.key && feedback.error && <p role="alert">{feedback.error}</p>}
    </article>)}
  </section>
}
