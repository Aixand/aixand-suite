import type { Session } from './connection'

export type GroupMember = {
  key: string
  session_id: string
  name: string
  restorable: boolean
}
export type TerminalGroup = {
  id: string
  name: string
  cwd: string
  shell: string
  persistent: boolean
  deleting: boolean
  pending_name: string | null
  members: GroupMember[]
}
export type GroupPage = {
  groups: TerminalGroup[]
  defaults: { cwd: string; shell: string }
}
export type LibraryTerminal = {
  key: string
  session: Session | null
  member?: GroupMember
  group?: TerminalGroup
  name: string
}
export type GroupMutation = (
  op: string,
  args: Record<string, unknown>
) => Promise<void>

// Retained slots remain visible after their daemon session has been removed.
export function terminalLibrary(
  sessions: Session[],
  groups: TerminalGroup[]
): LibraryTerminal[] {
  const live = new Map(sessions.map((session) => [session.id, session]))
  const assigned = new Set(
    groups.flatMap((group) => group.members.map((member) => member.session_id))
  )
  return [
    ...groups.flatMap((group) =>
      group.members.map((member) => ({
        key: member.key,
        session: live.get(member.session_id) ?? null,
        member,
        group,
        name: member.name,
      }))
    ),
    ...sessions
      .filter((session) => !assigned.has(session.id))
      .map((session) => ({
        key: session.id,
        session,
        name: session.name,
      })),
  ].sort((a, b) => a.name.localeCompare(b.name))
}
