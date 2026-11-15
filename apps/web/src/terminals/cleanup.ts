import type { CleanupResult, SessionPage, TerminalConnection } from './connection'
import type { GroupPage } from './groups'

// A missing entry is only confirmed after reading the complete, unfiltered catalog.
export async function cleanupTerminals(client: Pick<TerminalConnection, 'request'>): Promise<CleanupResult> {
  const [groups, first] = await Promise.all([
    client.request<GroupPage>('groups'),
    client.request<SessionPage>('list', { cursor: null }),
  ])
  const present = new Set(first.items.map(session => session.id))
  const cursors = new Set<string>()
  let page = first
  while (page.next_cursor) {
    if (cursors.has(page.next_cursor) || cursors.size >= 256)
      throw new Error('Terminal catalog could not finish loading. Refresh before cleaning up.')
    cursors.add(page.next_cursor)
    page = await client.request<SessionPage>('list', { cursor: page.next_cursor })
    for (const session of page.items) present.add(session.id)
  }

  const result = await client.request<CleanupResult>('clean', { confirmed: true })
  const succeeded = new Set(result.succeeded.map(item => item.session_id))
  const failures = new Map(result.failures.map(item => [item.session_id, item]))
  const selected = new Set([...succeeded, ...failures.keys()])
  let count = result.selected
  for (const group of groups.groups) {
    for (const member of group.members) {
      if (failures.has(member.session_id) || present.has(member.session_id) && !succeeded.has(member.session_id)) continue
      if (!selected.has(member.session_id)) {
        selected.add(member.session_id)
        count++
      }
      try {
        await client.request('group-assign', { sessionId: member.session_id, from: group.name, to: null })
        succeeded.add(member.session_id)
      } catch (cause) {
        succeeded.delete(member.session_id)
        failures.set(member.session_id, { session_id: member.session_id,
          message: `${member.name}: ${cause instanceof Error ? cause.message : 'Could not remove the unavailable saved terminal.'}` })
      }
    }
  }
  return { selected: count, succeeded: [...succeeded].map(session_id => ({ session_id })), failures: [...failures.values()] }
}
