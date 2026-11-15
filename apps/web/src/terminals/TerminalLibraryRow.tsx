import type { Session, SessionMutation } from './connection'
import type { GroupMutation, GroupPage, LibraryTerminal } from './groups'
import { SessionMenu } from './SessionMenu'
import { sessionTitle } from './context'
import { terminalStatus } from './status'

export function TerminalLibraryRow({ terminal, data, selected, isOpen, hidden, connected, pending, mutateGroup, mutateSession, openSession, drag }: {
  terminal: LibraryTerminal
  data: GroupPage
  selected: boolean
  isOpen: boolean
  hidden: boolean
  connected: boolean
  pending: boolean
  mutateGroup: GroupMutation
  mutateSession: SessionMutation
  openSession: (session: Session, add: boolean) => void
  drag: (session: Session | null) => void
}) {
  const { session, member, group } = terminal
  const displayName = session ? sessionTitle(session) : terminal.name
  const state = session?.lifecycle.state ?? 'unavailable'
  const status = terminalStatus(session)
  const app = session?.labels?.app?.trim()
  const profile = session?.profile?.trim()
  const project = session?.labels?.['project.name']?.trim()
  const appName = app === 'aixand-suite' ? 'Suite' : app === 'pathspec' ? 'Pathspec' : app
  const context = project || group?.name || (app !== 'pathspec' ? appName : undefined)
  const metadata = [...new Set([context, profile && !displayName.includes(profile) ? profile : undefined].filter(Boolean))].join(' · ')
  const failed = status.state === 'failed'
  const statusLabel = `${state}${session?.lifecycle.code != null ? ` · exit ${session.lifecycle.code}` : ''}${!session && member?.restorable ? ' · saved shell' : ''}`
  return <div className="tw-library-row" hidden={hidden} data-status={state} data-selected={selected || undefined}>
    <button className={`terminal-session${selected ? ' is-selected' : ''}`}
      aria-label={[displayName, statusLabel, app && `App: ${app}`, profile && `Profile: ${profile}`].filter(Boolean).join(' ')}
      aria-description={status.label}
      aria-pressed={selected} disabled={!connected || !session}
      title={[displayName, state === 'running' ? status.label : statusLabel, state !== 'running' && status.state !== state && status.label, metadata, session ? 'Click to open · Shift-click to auto-tile' : 'Saved terminal unavailable. Open its menu for restoration options.'].filter(Boolean).join(' · ')}
      draggable={connected && Boolean(session)}
      onDragStart={(event) => {
        if (!session) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-aixand-terminal', session.id)
        drag(session)
      }} onDragEnd={() => drag(null)}
      onClick={(event) => { if (session) openSession(session, event.shiftKey) }}>
      <i className="tw-session-status" data-status={status.state} data-failed={failed || undefined} title={status.label} aria-hidden="true" />
      <strong>{displayName}</strong>
      {isOpen && <i aria-hidden="true" className="tw-open-dot" title="Open in a workspace" />}
    </button>
    <SessionMenu terminal={terminal} data={data} disabled={!connected} mutateGroup={mutateGroup}
      mutateSession={mutateSession} pending={pending} />
  </div>
}
