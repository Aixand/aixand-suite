import { useEffect, useRef, useState } from 'react'
import { Badge, Button, EmptyState } from 'bbb-design'
import type { CSSProperties } from 'react'
import type { Session, SessionMutation, TerminalConnection } from './connection'
import type { GroupMutation, GroupPage } from './groups'
import { PaneRuntime } from './pane-runtime'
import type { PaneState } from './pane-runtime'
import { dropZone } from './layout'
import type { DropZone } from './layout'
import { TerminalAction } from './TerminalAction'
import { SessionMenu } from './SessionMenu'
import { PageLoading } from '../components/PageLoading'
import { sessionTitle } from './context'

export function TerminalPane({
  id,
  session,
  group,
  client,
  loading,
  pending,
  mutateSession,
  mutateGroup,
  groups,
  savedShell,
  visible,
  lifted,
  focused,
  maximized,
  style,
  onFocus,
  onClose,
  onMaximize,
  onChoose,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  id: string
  group?: string
  session: Session | null
  client: TerminalConnection | null
  loading: boolean
  pending: boolean
  mutateSession: SessionMutation
  mutateGroup: GroupMutation
  groups: GroupPage
  savedShell: boolean
  visible: boolean
  lifted: boolean
  focused: boolean
  maximized: boolean
  style: CSSProperties
  onFocus: () => void
  onClose: () => void
  onMaximize: () => void
  onChoose: () => void
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: (zone: DropZone) => void
}) {
  const [zone, setZone] = useState<DropZone | null>(null)
  useEffect(() => {
    if (!dragging) setZone(null)
  }, [dragging])
  const host = useRef<HTMLDivElement>(null)
  const runtime = useRef<PaneRuntime | null>(null)
  const [state, setState] = useState<PaneState>({ phase: 'offline' })
  const libraryGroup = groups.groups.find((item) => item.members.some((member) => member.session_id === session?.id))
  const libraryMember = libraryGroup?.members.find((member) => member.session_id === session?.id)
  useEffect(() => {
    if (!session || !host.current) return
    const instance = new PaneRuntime(host.current, id, session, setState)
    runtime.current = instance
    return () => {
      instance.dispose()
      runtime.current = null
    }
  }, [id, session?.id])
  useEffect(() => {
    void runtime.current?.connect(client)
  }, [client, session?.id])
  useEffect(() => {
    if (session) runtime.current?.setSession(session)
  }, [session])
  useEffect(() => {
    runtime.current?.setVisible(visible && !lifted)
  }, [visible, lifted, session?.id])
  // Focusing a pane also restores its keyboard target after tab/zoom changes.
  useEffect(() => {
    if (
      focused &&
      visible &&
      !lifted &&
      document.activeElement?.getAttribute('role') !== 'tab'
    )
      runtime.current?.focus()
  }, [focused, visible, lifted, session?.id])
  return (
    <section
      id={`pane-${id}`}
      style={style}
      hidden={!visible}
      aria-hidden={lifted || undefined}
      data-lifted={lifted || undefined}
      data-pane-id={id}
      data-session-id={session?.id}
      className={`terminal-tile terminal-live${focused ? ' is-focused' : ''}`}
      aria-label={session ? `Terminal ${session.name}` : 'Empty terminal pane'}
      onDragOver={(event) => {
        if (!dragging) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const rect = event.currentTarget.getBoundingClientRect()
        setZone(
          dropZone(
            (event.clientX - rect.left) / rect.width,
            (event.clientY - rect.top) / rect.height
          )
        )
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setZone(null)
      }}
      onDrop={(event) => {
        if (!dragging) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        onDrop(
          dropZone(
            (event.clientX - rect.left) / rect.width,
            (event.clientY - rect.top) / rect.height
          )
        )
        setZone(null)
      }}
      onPointerDown={onFocus}
      onFocusCapture={onFocus}
    >
      <header
        className="tile-header"
        onDoubleClick={(event) => {
          if (event.currentTarget.contains(event.target as Node) && !(event.target as HTMLElement).closest('button')) onMaximize()
        }}
        draggable={Boolean(session)}
        title="Drag to place this terminal"
        onDragStart={(event) => {
          if (!session || !event.currentTarget.contains(event.target as Node) || (event.target as HTMLElement).closest('button')) {
            event.preventDefault()
            return
          }
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(
            'application/x-aixand-terminal',
            session.id
          )
          onDragStart()
        }}
        onDragEnd={onDragEnd}
      >
        <span
          className={`tile-indicator ${state.phase === 'live' && session?.lifecycle.state === 'running' ? 'is-live' : ''}`}
        />
        <strong>{session ? sessionTitle(session) : 'Empty pane'}</strong>
        {group && (
          <Badge className="tile-group-badge" title={group}>
            {group}
          </Badge>
        )}
        <span className="tile-state">
          {session
            ? client
              ? session.lifecycle.state
              : 'disconnected'
            : 'select a session'}
        </span>
        {session && (
          <SessionMenu
            terminal={{ key: session.id, name: session.name, session, group: libraryGroup, member: libraryMember }}
            data={groups}
            mutateGroup={mutateGroup}
            disabled={!client}
            pending={pending}
            mutateSession={mutateSession}
            savedShell={savedShell}
            onClear={() => runtime.current?.clear()}
            triggerLabel={`Terminal actions for ${session.name}`}
          />
        )}
        <TerminalAction
          label={
            maximized
              ? 'Restore pane layout'
              : `Maximize pane ${session?.name ?? 'empty'}`
          }
          hint={maximized ? 'Restore layout' : 'Maximize pane'}
          onPress={onMaximize}
          icon={maximized ? 'restore' : 'maximize'}
        />
        <TerminalAction
          label={`Close pane ${session?.name ?? 'empty'}`}
          hint="Close pane (shell keeps running)"
          onPress={onClose}
          icon="close"
        />
      </header>
      {session ? (
        <>
          {state.message && (
            <div className="tile-message" role="alert">
              <span>{state.message}</span>
              {client && (
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() =>
                    void runtime.current?.attach(state.phase === 'gap')
                  }
                >
                  {state.phase === 'gap'
                    ? 'Restore current screen'
                    : 'Retry connection'}
                </Button>
              )}
            </div>
          )}
          {state.notice && (
            <div className="tile-note" role="status">
              {state.notice}
            </div>
          )}
          <div className="terminal-canvas">
            <div className="terminal-emulator" ref={host} />
          </div>
        </>
      ) : loading ? (
        <PageLoading label="Loading terminals…" />
      ) : (
        <div className="tile-empty">
          <EmptyState
            icon="panels-top-left"
            headingLevel={2}
            title="A place for your next command."
            description={
              client
                ? 'Select a terminal from the sidebar, or create a new one.'
                : 'Your terminal sessions connect automatically.'
            }
            action={
              <Button variant="secondary" size="sm" disabled={!client} onPress={onChoose}>
                Choose a terminal{' '}
                <span aria-hidden="true">→</span>
              </Button>
            }
          />
        </div>
      )}
      {dragging && zone && (
        <div
          className="tile-drop-overlay"
          aria-hidden="true"
          data-drop-zone={zone}
        >
          {(['left', 'right', 'top', 'bottom', 'center'] as const).map(
            (option) => (
              <div
                key={option}
                className={`tile-drop-zone drop-${option}${zone === option ? ' is-active' : ''}`}
              >
                <span>
                  {option === 'center'
                    ? 'Keep layout'
                    : option === 'top'
                      ? 'Above'
                      : option === 'bottom'
                        ? 'Below'
                        : option === 'left'
                          ? 'Left'
                          : 'Right'}
                </span>
              </div>
            )
          )}
        </div>
      )}
    </section>
  )
}
