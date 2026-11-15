import type { Session, SessionPage, TerminalEvent } from './connection'

export function preserveSummary(
  previous: Session | undefined,
  next: Session
): Session {
  if (!previous) return next
  if (
    previous.revision &&
    next.revision &&
    BigInt(previous.revision) >= BigInt(next.revision)
  )
    return previous
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
}

export function reconcileSessions(
  previous: Session[],
  incoming: Session[],
  complete = true
): Session[] {
  const before = new Map(previous.map((item) => [item.id, item]))
  const result = complete ? new Map<string, Session>() : new Map(before)
  for (const item of incoming)
    result.set(item.id, preserveSummary(before.get(item.id), item))
  const values = [...result.values()]
  return values.length === previous.length &&
    values.every((item, index) => item === previous[index])
    ? previous
    : values
}

export type SessionDeltaBatch = {
  from_revision: string
  to_revision: string
  total: number | null
  order: string[]
  deltas: {
    kind: 'added' | 'updated' | 'removed'
    session_id: string
    summary?: Session | null
  }[]
}

/** Query removal means page membership removal. Only a complete query or an
 * exact-ID watch proves the session disappeared from the global catalog. */
export function applyMetadata(
  previous: Session[],
  event: TerminalEvent,
  complete: boolean
): Session[] {
  if (event.payload?.item === 'session_snapshot') {
    const page = event.payload.value as SessionPage
    return reconcileSessions(
      previous,
      page.items,
      event.scope !== 'open' && complete
    )
  }
  if (event.payload?.item !== 'session_delta_batch') return previous
  const batch = event.payload.value as SessionDeltaBatch
  const next = new Map(previous.map((item) => [item.id, item]))
  for (const delta of batch.deltas) {
    if (delta.kind === 'removed') {
      if (complete || event.scope === 'open') next.delete(delta.session_id)
    } else if (delta.summary)
      next.set(
        delta.session_id,
        preserveSummary(next.get(delta.session_id), delta.summary)
      )
  }
  const values = [...next.values()]
  return values.length === previous.length &&
    values.every((item, index) => item === previous[index])
    ? previous
    : values
}
