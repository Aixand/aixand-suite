import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from 'bbb-design'
import { TerminalLibrary } from '../terminals/TerminalLibrary'
import type { GroupMutation, GroupPage } from '../terminals/groups'
import { Mark } from '../components/Mark'
import '@xterm/xterm/css/xterm.css'
import { TerminalConnection, requestId } from '../terminals/connection'
import { useConnectionRecovery } from '../auth/useConnectionRecovery'
import type { CleanupResult, Session, SessionMutation, SessionPage } from '../terminals/connection'
import {
  MAX_PANES,
  MAX_TABS,
  workspace,
  splitTile,
  removeTile,
  resizeTile,
  tileLayout,
  autoPlacement,
  dockTile,
} from '../terminals/layout'
import type { Workspace, Direction, DropZone } from '../terminals/layout'
import { TerminalPane } from '../terminals/TerminalPane'
import { SessionInspector } from '../terminals/SessionInspector'
import { TileDivider } from '../terminals/TileDivider'
import { TerminalIcon } from '../terminals/icons'
import { TerminalAction } from '../terminals/TerminalAction'
import { rememberWork } from '../workspace/home/history'

function WorkspaceTiles({
  tab,
  active,
  zoomed,
  client,
  sessions,
  groups,
  loading,
  pendingSessions,
  mutateSession,
  mutateGroup,
  onFocus,
  onClose,
  onMaximize,
  onResize,
  onChoose,
  dragged,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  tab: Workspace
  active: boolean
  zoomed: string | null
  client: TerminalConnection | null
  sessions: Session[]
  groups: GroupPage
  loading: boolean
  pendingSessions: Set<string>
  mutateSession: SessionMutation
  mutateGroup: GroupMutation
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMaximize: (id: string) => void
  onResize: (id: string, ratio: number) => void
  onChoose: () => void
  dragged: Session | null
  onDragStart: (session: Session) => void
  onDragEnd: () => void
  onDrop: (paneId: string, zone: DropZone) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  // Let the browser capture its drag image before hiding the source pane.
  const [previewSession, setPreviewSession] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setPreviewSession(dragged?.id ?? null), 0)
    return () => clearTimeout(timer)
  }, [dragged])
  const lifted = Object.keys(tab.panes).find(
    (id) =>
      dragged &&
      previewSession === dragged.id &&
      tab.panes[id]?.id === dragged.id
  )
  const preview = lifted ? removeTile(tab.root, lifted) : tab.root
  const original = tileLayout(tab.root)
  const layout = preview ? tileLayout(preview) : { panes: {}, dividers: [] }
  const previewZoom = dragged ? null : zoomed
  return (
    <div
      ref={container}
      className="terminal-tiling"
      role="tabpanel"
      id={`workspace-${tab.id}`}
      aria-labelledby={`tab-${tab.id}`}
      hidden={!active}
    >
      {Object.entries(tab.panes).map(([id, stored]) => {
        const bounds =
          previewZoom === id
            ? { x: 0, y: 0, width: 1, height: 1 }
            : (layout.panes[id] ?? original.panes[id])
        const session =
          sessions.find((item) => item.id === stored?.id) ?? stored
        return (
          <TerminalPane
            key={id}
            id={id}
            session={session}
            client={client}
            loading={loading}
            pending={Boolean(session && pendingSessions.has(session.id))}
            mutateSession={mutateSession}
            groups={groups}
            mutateGroup={mutateGroup}
            savedShell={groups.groups.some((group) =>
              group.members.some((member) => member.session_id === session?.id && member.restorable)
            )}
            group={
              groups.groups.find((group) =>
                group.members.some(
                  (member) => member.session_id === session?.id
                )
              )?.name
            }
            focused={active && tab.focused === id}
            visible={active && (!previewZoom || previewZoom === id)}
            lifted={lifted === id}
            maximized={zoomed === id}
            style={{
              left: `calc(${bounds.x * 100}% + 3px)`,
              top: `calc(${bounds.y * 100}% + 3px)`,
              width: `calc(${bounds.width * 100}% - 6px)`,
              height: `calc(${bounds.height * 100}% - 6px)`,
            }}
            onFocus={() => onFocus(id)}
            onClose={() => onClose(id)}
            onMaximize={() => onMaximize(id)}
            onChoose={onChoose}
            dragging={Boolean(dragged)}
            onDragStart={() => {
              if (session) onDragStart(session)
            }}
            onDragEnd={onDragEnd}
            onDrop={(zone) => onDrop(id, zone)}
          />
        )
      })}
      {!preview && (
        <div
          className="tile-empty tile-drag-empty"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            onDragEnd()
          }}
        >
          Drop here to keep this terminal in place.
        </div>
      )}
      {!dragged &&
        !zoomed &&
        layout.dividers.map((divider) => (
          <TileDivider
            key={divider.id}
            divider={divider}
            container={container}
            onResize={(ratio) => onResize(divider.id, ratio)}
          />
        ))}
    </div>
  )
}

export function Terminals({ sessionId }: { sessionId?: string } = {}) {
  const [tabs, setTabs] = useState<Workspace[]>(() => [
    workspace('Workspace 1'),
  ])
  const [activeId, setActiveId] = useState('')
  const [dragged, setDragged] = useState<Session | null>(null)
  const [zoomed, setZoomed] = useState<string | null>(null)
  const [sidebar, setSidebar] = useState(false)
  const [inspector, setInspector] = useState(false)
  const [status, setStatus] = useState<'offline' | 'connecting' | 'connected'>(
    'connecting'
  )
  const [client, setClient] = useState<TerminalConnection | null>(null)
  const connection = useRef<TerminalConnection | null>(null)
  const recovery = useConnectionRecovery(connect)
  const [sessions, setSessions] = useState<Session[]>([])
  const [catalogSettled, setCatalogSettled] = useState(false)
  const [pendingSessions, setPendingSessions] = useState<Set<string>>(new Set())
  const sessionOperations = useRef(new Set<string>())
  const [cleaning, setCleaning] = useState(false)
  const cleanupOperation = useRef(false)
  const [groups, setGroups] = useState<GroupPage>({
    groups: [],
    defaults: { cwd: '', shell: '' },
  })
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [fullscreen, setFullscreen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    setSidebar(!terminalListOverlays())
  }, [])
  const newTerminalButton = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)
  const refreshTask = useRef<Promise<void> | null>(null)
  const groupsRef = useRef<GroupPage>(groups)
  const refreshAgain = useRef(false)
  const tabNumber = useRef(1)
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0]
  const paneCount = tabs.reduce(
    (total, tab) => total + Object.keys(tab.panes).length,
    0
  )
  const activeSession = activeTab.panes[activeTab.focused]
  useEffect(() => {
    if (!activeSession) return
    const key = `terminal:${activeSession.id}`
    rememberWork(key)
    return () => rememberWork(key)
  }, [activeSession?.id])
  const initialLoading = !catalogSettled && !error && status !== 'offline'

  function terminalListOverlays() {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
    return (root.current?.clientWidth ?? 0) <= 34 * rem
  }

  useEffect(() => {
    if (!client) return
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    const start = () => {
      void client.request('watch').catch(() => {
        /* Polling remains available. */
      })
    }
    const unsubscribe = client.subscribe((event) => {
      if (!alive || event.kind !== 'sessions') return
      if (event.type === 'metadata') void refresh()
      if (event.type === 'metadata-gap') {
        void refresh()
        clearTimeout(retry)
        retry = setTimeout(start, 1000)
      }
    })
    start()
    return () => {
      alive = false
      unsubscribe()
      clearTimeout(retry)
      void client.request('unwatch', { kind: 'sessions' }).catch(() => {})
    }
  }, [client])

  const report = (cause: unknown) => {
    if (mounted.current)
      setError(
        cause instanceof Error ? cause.message : 'Terminal operation failed.'
      )
  }
  const updateTab = (id: string, change: (tab: Workspace) => Workspace) =>
    setTabs((current) =>
      current.map((tab) => (tab.id === id ? change(tab) : tab))
    )
  function chooseTab(id: string) {
    setActiveId(id)
    setZoomed(null)
  }
  function newTab() {
    if (tabs.length >= MAX_TABS || paneCount >= MAX_PANES) return
    const next = workspace(`Workspace ${++tabNumber.current}`)
    setTabs((current) => [...current, next])
    chooseTab(next.id)
  }
  function closeTab(id: string) {
    if (tabs.length === 1) {
      const next = workspace(`Workspace ${++tabNumber.current}`)
      setTabs([next])
      chooseTab(next.id)
      return
    }
    const index = tabs.findIndex((tab) => tab.id === id)
    setTabs((current) => current.filter((tab) => tab.id !== id))
    if (activeTab.id === id) chooseTab(tabs[index === 0 ? 1 : index - 1].id)
  }
  function split(direction: Direction) {
    if (paneCount >= MAX_PANES) return
    const pane = requestId()
    setZoomed(null)
    updateTab(activeTab.id, (tab) => ({
      ...tab,
      root: splitTile(tab.root, tab.focused, direction, pane),
      panes: { ...tab.panes, [pane]: null },
      focused: pane,
    }))
  }
  function closePane(tabId: string, id: string) {
    setZoomed(null)
    updateTab(tabId, (tab) => {
      const next = removeTile(tab.root, id)
      if (!next) {
        const fresh = workspace(tab.name)
        return { ...fresh, id: tab.id }
      }
      const panes = { ...tab.panes }
      delete panes[id]
      return {
        ...tab,
        root: next,
        panes,
        focused: tab.focused === id ? Object.keys(panes)[0] : tab.focused,
      }
    })
  }
  function openSession(
    session: Session,
    addToLayout = false,
    tabId = activeTab.id,
    paneId = activeTab.focused
  ) {
    rememberWork(`terminal:${session.id}`)
    for (const tab of tabs) {
      const existing = Object.entries(tab.panes).find(
        ([, value]) => value?.id === session.id
      )
      if (existing) {
        chooseTab(tab.id)
        updateTab(tab.id, (item) => ({ ...item, focused: existing[0] }))
        return
      }
    }
    const bounds = document
      .getElementById(`workspace-${tabId}`)
      ?.getBoundingClientRect()
    const placement = addToLayout
      ? autoPlacement(activeTab, bounds?.width || 1, bounds?.height || 1)
      : null
    if (placement) {
      paneId = placement.paneId
      setZoomed(null)
    }
    if (placement && !placement.reuse) {
      if (paneCount >= MAX_PANES) {
        setError(
          `This workspace supports up to ${MAX_PANES} panes across all tabs.`
        )
        return
      }
      const nextPane = requestId()
      setZoomed(null)
      updateTab(tabId, (tab) => ({
        ...tab,
        root: splitTile(tab.root, paneId, placement.direction, nextPane),
        panes: { ...tab.panes, [nextPane]: session },
        focused: nextPane,
      }))
    } else {
      updateTab(tabId, (tab) => ({
        ...tab,
        panes: { ...tab.panes, [paneId]: session },
        focused: paneId,
      }))
    }
    if (terminalListOverlays()) setSidebar(false)
  }
  function dropTerminal(tabId: string, target: string, zone: DropZone) {
    const session = dragged
    setDragged(null)
    if (!session || zone === 'center') return
    const origin = tabs.find((tab) =>
      Object.values(tab.panes).some((value) => value?.id === session.id)
    )
    const source =
      origin &&
      Object.keys(origin.panes).find(
        (id) => origin.panes[id]?.id === session.id
      )
    if (source === target) return
    const addsPane =
      !source ||
      (origin?.id !== tabId && Object.keys(origin!.panes).length === 1)
    if (addsPane && paneCount >= MAX_PANES) {
      setError(
        `This workspace supports up to ${MAX_PANES} panes across all tabs.`
      )
      return
    }
    const nextPane = source ?? requestId()
    setZoomed(null)
    setTabs((current) =>
      current.map((tab) => {
        let next = tab
        if (origin?.id === tab.id && source) {
          const remaining = removeTile(tab.root, source)
          const panes = { ...tab.panes }
          delete panes[source]
          next = remaining
            ? {
                ...tab,
                root: remaining,
                panes,
                focused:
                  tab.focused === source ? Object.keys(panes)[0] : tab.focused,
              }
            : { ...workspace(tab.name), id: tab.id }
        }
        if (tab.id === tabId) {
          return {
            ...next,
            root: dockTile(next.root, target, nextPane, zone),
            panes: { ...next.panes, [nextPane]: session },
            focused: nextPane,
          }
        }
        return next
      })
    )
    if (terminalListOverlays()) setSidebar(false)
  }
  function chooseTerminal() {
    if (!client) {
      document.getElementById('terminal-key')?.focus()
      return
    }
    setSidebar(true)
    setTimeout(() => newTerminalButton.current?.focus(), 0)
  }

  function refresh(): Promise<void> {
    refreshAgain.current = true
    if (refreshTask.current) return refreshTask.current
    const task = (async () => {
      do {
        refreshAgain.current = false
        await loadCatalog()
      } while (refreshAgain.current && mounted.current && connection.current)
    })().finally(() => {
      refreshTask.current = null
    })
    refreshTask.current = task
    return task
  }
  async function loadCatalog() {
    const current = connection.current
    if (!current) return
    try {
      const [first, groupPage] = await Promise.all([
        current.request<SessionPage>('list', { cursor: null }),
        current.request<GroupPage>('groups'),
      ])
      let page = first
      const items = [...page.items]
      const seen = new Set<string>()
      while (page.next_cursor) {
        if (seen.has(page.next_cursor) || seen.size >= 256)
          throw new Error(
            'Terminal catalog could not finish loading. Refresh to retry.'
          )
        seen.add(page.next_cursor)
        page = await current.request<SessionPage>('list', {
          cursor: page.next_cursor,
        })
        items.push(...page.items)
      }
      if (!mounted.current || current !== connection.current) return
      const nextGroups = groupPage ?? {
        groups: [],
        defaults: { cwd: '', shell: '' },
      }
      setSessions([...new Map(items.map((item) => [item.id, item])).values()])
      {
        const previous = new Map(
          groupsRef.current.groups.flatMap((group) =>
            group.members.map((member) => [member.key, member] as const)
          )
        )
        const liveSessions = new Map(
          items.map((session) => [session.id, session])
        )
        // Follow a restored slot to its replacement session without rearranging panes.
        const replacements = new Map<string, Session>()
        for (const group of nextGroups.groups)
          for (const member of group.members) {
            const old = previous.get(member.key)
            const session = liveSessions.get(member.session_id)
            if (old && session && old.session_id !== member.session_id)
              replacements.set(old.session_id, session)
          }
        setTabs((currentTabs) =>
          currentTabs.map((tab) => ({
            ...tab,
            panes: Object.fromEntries(
              Object.entries(tab.panes).map(([id, session]) => [
                id,
                session
                  ? (replacements.get(session.id) ?? liveSessions.get(session.id) ?? session)
                  : null,
              ])
            ),
          }))
        )
        groupsRef.current = nextGroups
        setGroups(nextGroups)
      }
    } catch (cause) {
      if (current === connection.current) report(cause)
    } finally {
      if (mounted.current && current === connection.current)
        setCatalogSettled(true)
    }
  }
  async function mutateGroup(op: string, args: Record<string, unknown>) {
    const current = connection.current
    if (!current || !client)
      throw new Error('Reconnect before changing groups.')
    const result = await current.request<{ notices?: string[] } | null>(
      op,
      args
    )
    if (current !== connection.current) return
    await refresh()
    if (result?.notices?.length) throw new Error(result.notices.join(' '))
  }
  function forgetSessions(removed: Set<string>) {
    setSessions(items => items.filter(item => !removed.has(item.id)))
    setTabs(currentTabs => currentTabs.map(tab => ({
      ...tab,
      panes: Object.fromEntries(Object.entries(tab.panes).map(([id, session]) => [
        id, session && removed.has(session.id) ? null : session,
      ])),
    })))
  }
  async function cleanTerminals(): Promise<CleanupResult> {
    const current = connection.current
    if (!current || current !== client) throw new Error('Reconnect before cleaning up terminals.')
    if (cleanupOperation.current || sessionOperations.current.size || creating)
      throw new Error('Wait for the current terminal operation to finish.')
    cleanupOperation.current = true
    setCleaning(true)
    try {
      const result = await current.request<CleanupResult>('clean', { confirmed: true })
      if (mounted.current && current === connection.current)
        forgetSessions(new Set(result.succeeded.map(item => item.session_id)))
      return result
    } finally {
      if (mounted.current && current === connection.current) await refresh()
      cleanupOperation.current = false
      if (mounted.current) setCleaning(false)
    }
  }
  const mutateSession: SessionMutation = async (op, args) => {
    const current = connection.current
    if (!current || current !== client)
      throw new Error('Reconnect before changing a session.')
    if (cleanupOperation.current) throw new Error('Wait for terminal cleanup to finish.')
    if (sessionOperations.current.has(args.sessionId))
      throw new Error('An operation is already pending for this session.')
    sessionOperations.current.add(args.sessionId)
    setPendingSessions(new Set(sessionOperations.current))
    try {
      const result = await current.request<{ session?: Session }>(op, args)
      if (!mounted.current || current !== connection.current) return
      if (op === 'remove') {
        forgetSessions(new Set([args.sessionId]))
      } else if (result?.session) {
        const next = result.session
        setSessions((items) => [...items.filter((item) => item.id !== next.id), next])
        setTabs((currentTabs) =>
          currentTabs.map((tab) => ({
            ...tab,
            panes: Object.fromEntries(
              Object.entries(tab.panes).map(([id, session]) => [
                id,
                session?.id === next.id ? next : session,
              ])
            ),
          }))
        )
      }
    } finally {
      // Reconcile both successes and uncertain failures without retrying effects.
      if (mounted.current && current === connection.current) await refresh()
      sessionOperations.current.delete(args.sessionId)
      if (mounted.current) setPendingSessions(new Set(sessionOperations.current))
    }
  }
  function connect() {
    const current = connection.current
    connection.current = null
    current?.close()
    setClient(null)
    setStatus('connecting')
    const next = new TerminalConnection(
      () => {
        if (connection.current !== next) return
        recovery.ready()
        setStatus('connected')
        setError('')
        setClient(next)
        void refresh()
      },
      (event) => {
        if (connection.current === next && event.type === 'fatal')
          setError(event.message ?? 'Undercurrent is unavailable.')
      },
      (message) => {
        if (connection.current !== next) return
        connection.current = null
        setClient(null)
        setStatus('offline')
        setError((current) => current || message)
        recovery.failed()
      }
    )
    connection.current = next
  }
  async function create(name: string, group?: string): Promise<boolean> {
    if (!client || creating) return false
    const tabId = activeTab.id,
      paneId = activeTab.focused
    setCreating(true)
    setError('')
    try {
      const result = await client.request<{ session: Session }>('create', {
        name: name.trim(),
        ...(group ? { group } : {}),
        columns: 100,
        rows: 30,
      })
      if (!mounted.current || client !== connection.current) return false
      setSessions((current) => [
        ...current.filter((item) => item.id !== result.session.id),
        result.session,
      ])
      // If its destination was closed while creating, keep the shell in the list.
      setTabs((current) =>
        current.map((tab) =>
          tab.id === tabId && paneId in tab.panes
            ? {
                ...tab,
                panes: { ...tab.panes, [paneId]: result.session },
                focused: paneId,
              }
            : tab
        )
      )
      if (terminalListOverlays()) setSidebar(false)
      await refresh()
      return true
    } catch (cause) {
      report(cause)
      void refresh()
      return false
    } finally {
      if (mounted.current) setCreating(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    const listener = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', listener)
    return () => {
      mounted.current = false
      const current = connection.current
      connection.current = null
      current?.close()
      document.removeEventListener('fullscreenchange', listener)
    }
  }, [])
  useEffect(() => {
    if (!client) return
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [client])

  useEffect(() => {
    if (!sessionId || !client) return
    let alive = true
    void client.request<{ summary: Session }>('inspect', { sessionId }).then((detail) => {
      if (alive && connection.current === client) openSession(detail.summary)
    }).catch((cause: unknown) => { if (alive) report(cause) })
    return () => { alive = false }
  }, [client, sessionId])

  return (
    <div className="terminal-workspace" ref={root}>
      <TerminalLibrary
        visible={sidebar}
        onClose={() => {
          setSidebar(false)
          root.current
            ?.querySelector<HTMLElement>('[aria-controls="terminal-session-sidebar"]')
            ?.focus()
        }}
        sessions={sessions}
        data={groups}
        connected={Boolean(client)}
        loading={initialLoading}
        creating={creating}
        cleaning={cleaning}
        clean={cleanTerminals}
        activeId={activeSession?.id}
        openIds={
          new Set(
            tabs.flatMap((tab) =>
              Object.values(tab.panes).flatMap((session) =>
                session ? [session.id] : []
              )
            )
          )
        }
        newTerminalButton={newTerminalButton}
        refresh={() => void refresh()}
        fullscreen={fullscreen}
        toggleFullscreen={() => {
          void (
            fullscreen
              ? document.exitFullscreen()
              : root.current?.requestFullscreen()
          )?.catch(report)
        }}
        create={create}
        mutate={mutateGroup}
        mutateSession={mutateSession}
        pendingSessions={pendingSessions}
        openSession={openSession}
        drag={setDragged}
      />
      <div className="tw-main">
        <h1 className="tw-sr-only" tabIndex={-1}>Terminals</h1>
        <div className="tw-tabbar">
          <TerminalAction
            label={sidebar ? 'Hide terminal list' : 'Show terminal list'}
            aria-expanded={sidebar}
            aria-controls="terminal-session-sidebar"
            onPress={() => setSidebar(!sidebar)}
            hint="Toggle terminal list"
            icon="sidebar"
          />
          <div
            role="tablist"
            aria-label="Terminal workspaces"
            className="tw-tabs"
            onKeyDown={(event) => {
              if (event.key === 'Delete') {
                event.preventDefault()
                closeTab(activeTab.id)
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLElement>('.tw-tab [aria-selected=true]')
                    ?.focus()
                )
                return
              }
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) ||
                (event.target as HTMLElement).getAttribute('role') !== 'tab'
              )
                return
              event.preventDefault()
              const index = tabs.findIndex((tab) => tab.id === activeTab.id)
              const next =
                tabs[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : (index +
                          (event.key === 'ArrowRight' ? 1 : -1) +
                          tabs.length) %
                        tabs.length
                ]
              chooseTab(next.id)
              document.getElementById(`tab-${next.id}`)?.focus()
            }}
          >
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`tw-tab${activeTab.id === tab.id ? ' is-active' : ''}`}
                role="presentation"
              >
                <button
                  role="tab"
                  id={`tab-${tab.id}`}
                  aria-selected={activeTab.id === tab.id}
                  aria-controls={`workspace-${tab.id}`}
                  tabIndex={activeTab.id === tab.id ? 0 : -1}
                  onClick={() => chooseTab(tab.id)}
                >
                  <TerminalIcon name="terminal" />
                  <span>{tab.name}</span>
                  <small>{Object.keys(tab.panes).length}</small>
                  <span
                    className="tw-tab-close"
                    aria-hidden="true"
                    title="Close workspace (shells keep running)"
                    onClick={(event) => {
                      event.stopPropagation()
                      closeTab(tab.id)
                    }}
                  >
                    <TerminalIcon name="close" />
                  </span>
                </button>
              </div>
            ))}
          </div>
          <TerminalAction
            label="New workspace tab"
            hint="New workspace tab"
            disabled={tabs.length >= MAX_TABS || paneCount >= MAX_PANES}
            onPress={newTab}
            icon="plus"
          />
          <div className="tw-layout-actions">
            <TerminalAction
              label="Toggle terminal inspector"
              aria-expanded={inspector}
              hint="Terminal inspector"
              onPress={() => setInspector(!inspector)}
              icon="inspector"
            />
            <TerminalAction
              label="Close workspace"
              hint="Close current workspace (Delete when a tab is focused)"
              onPress={() => closeTab(activeTab.id)}
              icon="close"
            />
            <TerminalAction
              label="Split right"
              hint="Split right"
              disabled={paneCount >= MAX_PANES}
              onPress={() => split('right')}
              icon="right"
            />
            <TerminalAction
              label="Split down"
              hint="Split down"
              disabled={paneCount >= MAX_PANES}
              onPress={() => split('down')}
              icon="down"
            />
          </div>
        </div>
        {status === 'offline' && (
          <form
            className="tw-connect"
            onSubmit={(event) => {
              event.preventDefault()
              recovery.reconnect()
            }}
          >
            <Button
              type="submit"
              size="sm"
            >
              Retry connection
            </Button>
            <span>Reconnecting automatically…</span>
          </form>
        )}
        {error && (
          <div className="tw-error" role="alert">
            <span>{error}</span>
            <TerminalAction
              label="Dismiss error"
              onPress={() => setError('')}
              icon="close"
            />
          </div>
        )}
        <div className="tw-body">
          <div className="tw-center">
            {tabs.map((tab) => (
              <WorkspaceTiles
                key={tab.id}
                tab={tab}
                active={activeTab.id === tab.id}
                zoomed={activeTab.id === tab.id ? zoomed : null}
                client={client}
                sessions={sessions}
                groups={groups}
                loading={initialLoading}
                pendingSessions={pendingSessions}
                mutateSession={mutateSession}
                mutateGroup={mutateGroup}
                onFocus={(id) =>
                  updateTab(tab.id, (current) =>
                    current.focused === id ? current : { ...current, focused: id }
                  )
                }
                onClose={(id) => closePane(tab.id, id)}
                onMaximize={(id) => {
                  updateTab(tab.id, (current) => ({ ...current, focused: id }))
                  setZoomed((current) => (current === id ? null : id))
                }}
                onResize={(id, ratio) =>
                  updateTab(tab.id, (current) => ({
                    ...current,
                    root: resizeTile(current.root, id, ratio),
                  }))
                }
                onChoose={chooseTerminal}
                dragged={dragged}
                onDragStart={setDragged}
                onDragEnd={() => setDragged(null)}
                onDrop={(id, zone) => dropTerminal(tab.id, id, zone)}
              />
            ))}
          </div>
          {inspector && (
            <SessionInspector
              client={client}
              session={activeSession ?? null}
              onClose={() => setInspector(false)}
            />
          )}
        </div>
        <footer className="tw-statusbar">
          <span className="tw-status-brand">
            <Mark small />
            Aixand
          </span>
          <span>
            {Object.keys(activeTab.panes).length}{' '}
            {Object.keys(activeTab.panes).length === 1 ? 'pane' : 'panes'}
            <span className="tw-status-detail">
              {' '}
              · Drag dividers to resize · Double-click to balance
            </span>
          </span>
          <span className="tw-status-detail">
            Closing a pane keeps its shell running.
          </span>
          <span
            className="tw-connection"
            data-status={status}
            aria-live="polite"
            aria-atomic="true"
          >
            <i aria-hidden="true" />
            {status === 'connected'
              ? 'Connected'
              : status === 'connecting'
                ? 'Connecting…'
                : 'Disconnected'}
          </span>
        </footer>
      </div>
    </div>
  )
}
