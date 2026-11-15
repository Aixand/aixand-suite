import type { ChatWorkflow } from '../chats/model'

export function workflowGuidance(run: ChatWorkflow, connected: boolean) {
  if (!connected) return 'Showing the last known progress. Reconnect to check for updates.'
  if (run.state === 'offline') return 'Showing the last known progress. This workflow is waiting for its connection to recover.'
  if (run.delivery) return run.state === 'failed' ? 'The workflow stopped. Its failure report is ready in your main inbox.' : 'A report is ready in your main inbox.'
  if (run.state === 'uncertain') return 'The latest status has not been confirmed. Review this run before choosing whether to resume it.'
  if (run.state === 'waiting') return run.steps.some(step => step.state === 'waiting' && step.chat_id && !step.conversationDeleted)
    ? 'A step needs your response. Open its chat to continue.' : 'A step is waiting for input. Open workflow details to review it.'
  if (run.state === 'completed') return 'The workflow finished. Report delivery has not been confirmed yet.'
  if (run.state === 'failed' || run.state === 'blocked') return 'Review the steps that need attention before starting another run.'
  if (run.state === 'cancelled') return 'The workflow was cancelled. Open its details to review the outcome.'
  if (['queued', 'running', 'prepared', 'creating', 'created', 'starting', 'submitting'].includes(run.state))
    return 'Work continues when you leave this page. You can check its progress from Workflows.'
  return 'Open workflow details to review its current progress.'
}

export const workflowActionFeedback = {
  status: 'Checking workflow status…', resume: 'Resuming the existing run…', cancel: 'Requesting cancellation…',
  hold: 'Pausing upcoming steps…', release: 'Resuming upcoming steps…',
}
