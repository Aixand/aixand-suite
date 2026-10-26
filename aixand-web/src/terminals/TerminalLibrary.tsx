import { useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Button, Icon, Popover, SearchField, Select, TextField } from 'bbb-design'
import { UNSAFE_PortalProvider } from 'react-aria/PortalProvider'
import type { CleanupResult, Session, SessionMutation } from './connection'
import { GroupManager } from './GroupDialogs'
import { TerminalLibraryRow } from './TerminalLibraryRow'
import { TerminalFilter } from './TerminalFilter'
import { TerminalOptions } from './TerminalOptions'
import { terminalLibrary } from './groups'
import type { GroupMutation, GroupPage, LibraryTerminal } from './groups'
import { TerminalAction } from './TerminalAction'
import { TerminalIcon } from './icons'
import { ContentTheme } from '../branding/ContentTheme'
import { contextGroups, isMyTerminal, labelText, sessionKind, sessionTitle } from './context'
import './TerminalLibrary.css'

const sectionTitles = {
  servers: 'Servers',
  jobs: 'Jobs',
  mine: 'My terminals',
  pathspec: 'Pathspec',
  other: 'Other terminals',
}
type TerminalSection = keyof typeof sectionTitles
type AppHeading = {
  section: TerminalSection
  count: number
}

function terminalSection(terminal: LibraryTerminal): TerminalSection {
  if (isMyTerminal(terminal.session?.labels)) return 'mine'
  const kind = sessionKind(terminal.session?.labels)
  if (kind === 'server') return 'servers'
  if (kind === 'job') return 'jobs'
  const app = terminal.session?.labels?.app?.trim()
  return app === 'pathspec' ? 'pathspec' : 'other'
}

function appSections(rows: LibraryTerminal[]) {
  const grouped: Record<TerminalSection, LibraryTerminal[]> = {
    servers: [],
    jobs: [],
    mine: [],
    pathspec: [],
    other: [],
  }
  for (const row of rows) grouped[terminalSection(row)].push(row)
  const entries: (LibraryTerminal | AppHeading)[] = []
  for (const section of ['mine', 'servers', 'jobs', 'pathspec', 'other'] as const) {
    const terminals = grouped[section]
    if (terminals.length)
      entries.push({ section, count: terminals.length }, ...terminals)
  }
  return entries
}

export function TerminalLibrary({
  visible,
  onClose,
  sessions,
  data,
  connected,
  loading,
  creating,
  cleaning,
  clean,
  activeId,
  openIds,
  newTerminalButton,
  refresh,
  fullscreen,
  toggleFullscreen,
  create,
  mutate,
  mutateSession,
  pendingSessions,
  openSession,
  drag,
}: {
  visible: boolean
  onClose: () => void
  sessions: Session[]
  data: GroupPage
  connected: boolean
  loading: boolean
  creating: boolean
  cleaning: boolean
  clean: () => Promise<CleanupResult>
  activeId?: string
  openIds: Set<string>
  newTerminalButton: RefObject<HTMLButtonElement | null>
  refresh: () => void
  fullscreen: boolean
  toggleFullscreen: () => void
  create: (name: string, group?: string) => Promise<boolean>
  mutate: GroupMutation
  mutateSession: SessionMutation
  pendingSessions: Set<string>
  openSession: (session: Session, add: boolean) => void
  drag: (session: Session | null) => void
}) {
  const searchInput = useRef<HTMLInputElement>(null)
  const searchToggle = useRef<HTMLButtonElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('@all')
  const [name, setName] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [creationGroup, setCreationGroup] = useState('')
  const [inactiveExpanded, setInactiveExpanded] = useState(false)
  const [collapsedApps, setCollapsedApps] = useState<Set<TerminalSection>>(() => new Set())
  const rows = terminalLibrary(sessions, data.groups)
  const labelGroups = contextGroups(rows.map((row) => ({ labels: row.session?.labels })))
  const selectedFilter =
    filter === '@all' || filter === '@ungrouped' || labelGroups.some((group) => group.id === filter) || data.groups.some((group) => group.name === filter)
      ? filter
      : '@all'
  const selectedLabels = labelGroups.find((group) => group.id === selectedFilter)
  const newGroup = data.groups.find((group) => group.name === creationGroup)
  const displayed = rows.filter(
    (row) =>
      (selectedFilter === '@all' ||
        (selectedLabels ? row.session?.labels?.[selectedLabels.key] === selectedLabels.value : selectedFilter === '@ungrouped'
          ? !row.group
          : row.group?.name === selectedFilter)) &&
      `${row.name} ${row.session ? sessionTitle(row.session) : ''} ${row.session?.profile ?? ''} ${row.group?.name ?? ''} ${labelText(row.session?.labels)}`.toLowerCase().includes(search.trim().toLowerCase())
  )
  const isInactive = (terminal: (typeof rows)[number]) =>
    ['stopped', 'exited'].includes(terminal.session?.lifecycle.state ?? '')
  const inactive = displayed.filter(isInactive)
  // Keep all rows as siblings so live status changes preserve their open dialogs.
  const entries = [
    ...appSections(displayed.filter((terminal) => !isInactive(terminal))),
    ...(inactive.length ? [null, ...inactive] : []),
  ]
  const mutateAndKeepFocus: GroupMutation = async (op, args) => {
    const focused = document.activeElement
    await mutate(op, args)
    requestAnimationFrame(() => {
      if (
        focused &&
        !focused.isConnected &&
        document.activeElement === document.body
      )
        (searchInput.current ?? searchToggle.current)?.focus()
    })
  }
  return (
    <ContentTheme className="aixand-theme-contents"><aside
      hidden={!visible}
      className="tw-sidebar"
      id="terminal-session-sidebar"
      aria-label="Terminal sessions"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          const workspace = event.currentTarget.closest('.terminal-workspace')
          const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
          if (workspace && workspace.clientWidth <= 34 * rem) { event.preventDefault(); onClose() }
        }
      }}
    >
      <div className="tw-sidebar-heading">
        <h2>Terminals</h2>
        <div className="tw-library-actions">
          <Button ref={searchToggle} variant="ghost" size="sm" iconOnly aria-label={searchOpen ? 'Close terminal search' : 'Search terminals'}
            aria-expanded={searchOpen} aria-controls="terminal-library-search" onPress={() => {
              setSearchOpen(!searchOpen)
              if (searchOpen) setSearch('')
            }}><Icon name={searchOpen ? 'x' : 'search'} /></Button>
          <TerminalOptions connected={connected} busy={cleaning || creating || pendingSessions.size > 0}
            finishedCount={sessions.filter(session => ['stopped', 'exited', 'failed'].includes(session.lifecycle.state)).length}
            refresh={refresh} fullscreen={fullscreen} toggleFullscreen={toggleFullscreen} clean={clean} />
          <TerminalAction className="tw-sidebar-close" label="Close terminal list" onPress={onClose} icon="close" />
        </div>
      </div>
      <div className="tw-library-create">
        <UNSAFE_PortalProvider getContainer={() =>
          document.fullscreenElement instanceof HTMLElement
            ? document.fullscreenElement
            : document.body
        }>
          <Popover
            className="tw-create-popover"
            title="New terminal"
            open={createOpen && visible}
            onOpenChange={setCreateOpen}
            trigger={
              <Button ref={newTerminalButton} variant="ghost" className="tw-new-terminal" disabled={!connected || creating || cleaning}>
                <Icon name="plus" />New terminal
              </Button>
            }
          >
            <form
              className="tw-create"
              onSubmit={(event) => {
                event.preventDefault()
                void create(name.trim(), newGroup?.name).then((created) => {
                  if (created) {
                    setName('')
                    setCreateOpen(false)
                  }
                })
              }}
            >
              <TextField
                label="Session name"
                hideLabel
                autoFocus
                id="session-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Session name"
                maxLength={80}
                disabled={!connected || creating}
              />
              <Select
                label="New terminal group"
                hideLabel
                value={newGroup?.name ?? '@ungrouped'}
                disabled={!connected || creating}
                onChange={(value) =>
                  setCreationGroup(value === '@ungrouped' ? '' : value)
                }
                options={[
                  { id: '@ungrouped', label: 'Ungrouped' },
                  ...data.groups.map((group) => ({
                    id: group.name,
                    label: group.name,
                    disabled: group.deleting || Boolean(group.pending_name),
                  })),
                ]}
              />
              <p title={newGroup ? `${newGroup.shell} · ${newGroup.cwd}` : undefined}>
                {newGroup
                  ? `${newGroup.shell} · ${newGroup.cwd}`
                  : 'Opens in the focused pane.'}
              </p>
              <Button
                type="submit"
                size="sm"
                loading={creating}
                disabled={
                  !connected ||
                  creating ||
                  !/^[\w .-]+$/.test(name.trim()) ||
                  Boolean(newGroup?.deleting || newGroup?.pending_name)
                }
              >
                <TerminalIcon name="plus" />
                {creating ? 'Starting…' : 'Create terminal'}
              </Button>
            </form>
          </Popover>
        </UNSAFE_PortalProvider>
        <TerminalFilter value={selectedFilter}
          onChange={value => {
            setFilter(value)
            setCreationGroup(value.startsWith('@') ? '' : value)
          }}
          options={[
            { id: '@all', label: `All terminals · ${rows.length}` },
            { id: '@ungrouped', label: `Ungrouped · ${rows.filter(row => !row.group).length}` },
            ...labelGroups.map(group => ({ id: group.id, label: `${group.label} · ${group.count}` })),
            ...data.groups.map(group => ({ id: group.name, label: `${group.name} · ${group.members.length}` })),
          ]} />
        <GroupManager data={data} disabled={!connected || cleaning} mutate={mutateAndKeepFocus} />
      </div>
      {searchOpen && <div id="terminal-library-search" className="tw-search">
        <SearchField ref={searchInput} label="Search terminals" autoFocus value={search} onChange={setSearch}
          placeholder="Find a terminal or process…" onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              if (search) setSearch('')
              else { setSearchOpen(false); searchToggle.current?.focus() }
            }
          }} />
      </div>}
      <div className="tw-session-list" data-inactive-expanded={inactiveExpanded} aria-busy={loading}>
        {entries.map((terminal) => {
          if (!terminal) return (
            <h3 className="tw-inactive-heading" key="inactive-heading">
              <button
                type="button"
                aria-label="Stopped and exited sessions"
                aria-expanded={inactiveExpanded}
                onClick={() => setInactiveExpanded((expanded) => !expanded)}
              >
                <Icon name="chevron-right" />
                <span>Stopped &amp; exited</span>
                <span className="tw-inactive-count">{inactive.length}</span>
              </button>
            </h3>
          )
          if ('section' in terminal) {
            const sectionId = terminal.section
            const title = sectionTitles[terminal.section]
            return (
              <h3
                className="tw-app-heading"
                key={`app:${sectionId}`}
              >
                <button
                  type="button"
                  aria-label={title}
                  aria-expanded={!collapsedApps.has(sectionId)}
                  onClick={() => setCollapsedApps((current) => {
                    const next = new Set(current)
                    if (next.has(sectionId)) next.delete(sectionId)
                    else next.add(sectionId)
                    return next
                  })}
                >
                  <Icon name="chevron-right" />
                  <span>{title}</span>
                  <span className="tw-section-count">{terminal.count}</span>
                </button>
              </h3>
            )
          }
          const session = terminal.session
          const inactiveSession = isInactive(terminal)
          return <TerminalLibraryRow key={`session:${terminal.key}`} terminal={terminal} data={data}
            hidden={inactiveSession ? !inactiveExpanded : collapsedApps.has(terminalSection(terminal))}
            selected={Boolean(session && activeId === session.id)} isOpen={Boolean(session && openIds.has(session.id))}
            connected={connected} pending={Boolean(session && pendingSessions.has(session.id))}
            mutateGroup={mutateAndKeepFocus} mutateSession={mutateSession} openSession={openSession} drag={drag} />
        })}
        {!displayed.length && !loading && (
          <p className="tw-sidebar-empty">
            {!connected
              ? 'Connect to see your terminals.'
              : search
                ? 'No matching terminals in this group.'
                : selectedFilter === '@all'
                  ? 'No terminals yet. Use + to start a shell.'
                  : 'No terminals in this group yet.'}
          </p>
        )}
      </div>
    </aside></ContentTheme>
  )
}
