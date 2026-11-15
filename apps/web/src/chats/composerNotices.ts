import { AgentError, type LaunchReadiness } from '../agents/client'

export type ComposerNoticeTone = 'info' | 'success' | 'warning' | 'error'
export type ComposerNotice = {
  id: string
  tone: ComposerNoticeTone
  title: string
  description?: string
  details?: string
  scope?: string
  setup?: LaunchReadiness
}
export type ComposerStatusNotice = ComposerNotice & {
  label?: string
  className?: string
  detailsLabel?: string
  blocking?: boolean
  priority?: number
  actions?: { label: string; onPress: () => void; disabled?: boolean }[]
}

// Unknown provider failures get the same presentation as known failures. Keep the
// original message available without guessing a cause or whether a request ran.
export function composerError(cause: unknown, scope?: string): ComposerNotice {
  const error = cause instanceof AgentError ? cause : undefined
  if (error?.setup) return { id: 'operation', tone: 'warning', scope, setup: error.setup,
    title: error.setup.reason || error.message }
  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined
  const details = error?.diagnosticId ? `${message}\nDiagnostic ID: ${error.diagnosticId}` : message
  const uncertain = error?.uncertain || ['launch_uncertain', 'connection_lost', 'disconnected', 'timeout'].includes(error?.code ?? '')
  const generic = !error || !['configuration', 'manager', 'validation', 'unsupported', 'busy', 'invalid_request'].includes(error.code ?? '')
  return {
    id: 'operation', tone: 'error', scope,
    title: uncertain ? 'The request outcome is unconfirmed.' : generic ? 'Couldn’t complete the request.' : details || 'Couldn’t complete the request.',
    ...(uncertain ? { description: 'Check its status before trying again. Any retry uses the original request.' } : {}),
    ...(details ? { details } : {}),
  }
}

export function orderedComposerNotices(notices: ComposerStatusNotice[]) {
  const priority = { error: 0, warning: 1, info: 2, success: 3 }
  const unique = new Map<string, ComposerStatusNotice>()
  for (const notice of notices) if (!unique.has(notice.id)) unique.set(notice.id, notice)
  return [...unique.values()].sort((a, b) => (a.priority ?? priority[a.tone]) - (b.priority ?? priority[b.tone]) || Number(Boolean(b.blocking)) - Number(Boolean(a.blocking)))
}
