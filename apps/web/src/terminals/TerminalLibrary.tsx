import { createRef, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Button, DropdownSurface, Icon, Popover, SearchField, TextField, Tooltip } from 'bbb-design'
import type { IconName } from 'bbb-design'
import { Menu, MenuItem, MenuTrigger } from 'react-aria-components'
import { UNSAFE_PortalProvider } from 'react-aria/PortalProvider'
import type { CleanupResult, Session, SessionMutation } from './connection'
import { TerminalLibraryRow } from './TerminalLibraryRow'
import { TerminalLibrarySection, sectionHeight } from './TerminalLibrarySection'
import { TerminalLibrarySlot } from './TerminalLibrarySlot'
import { TerminalFilter } from './TerminalFilter'
import { TerminalOptions } from './TerminalOptions'
import { terminalLibrary } from './groups'
import type { GroupMutation, GroupPage, LibraryTerminal } from './groups'
import { TerminalAction } from './TerminalAction'
import { TerminalIcon } from './icons'
import { ContentTheme } from '../branding/ContentTheme'
import { WorkspaceSidebar, WorkspaceSidebarActions, WorkspaceSidebarBody, WorkspaceSidebarHeader } from '../components/WorkspaceSidebar'
import { contextGroups, isMyTerminal, labelText, sessionKind, sessionTitle } from './context'
import './TerminalLibrary.css'

const sectionTitles = {
  servers: 'Servers',
  jobs: 'Jobs',
  mine: 'My terminals',
  pathspec: 'Pathspec',
  other: 'Others',
  inactive: 'Stopped & failures',
}
type TerminalSection = keyof typeof sectionTitles
const sectionIcons = {
  mine: 'square-terminal',
  pathspec: 'workflow',
  jobs: 'scroll-text',
  other: 'layers',
  inactive: 'box',
  servers: 'monitor',
} as const satisfies Record<TerminalSection, IconName>
const sectionOrder: TerminalSection[] = ['mine', 'pathspec', 'jobs', 'other', 'servers', 'inactive']
const bottomSections = new Set<TerminalSection>(['servers', 'inactive'])
const expandedSectionsKey = 'aixand.terminals.expandedSections.v1'
const sectionHeightsKey = 'aixand.terminals.sectionHeights.v1'

function readExpandedSections(): Set<TerminalSection> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(expandedSectionsKey) ?? 'null')
    if (Array.isArray(saved)) return new Set(saved.filter((section): section is TerminalSection => sectionOrder.includes(section)))
  } catch { /* Keep sections usable when storage is unavailable. */ }
  return new Set(['mine'])
}
function readSectionHeights(): Partial<Record<TerminalSection, number>> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(sectionHeightsKey) ?? 'null')
    if (saved && typeof saved === 'object' && !Array.isArray(saved))
      return Object.fromEntries(Object.entries(saved).filter(([key, value]) =>
        sectionOrder.includes(key as TerminalSection) && typeof value === 'number' && Number.isFinite(value)
      ).map(([key, value]) => [key, sectionHeight(value as number)]))
  } catch { /* Keep resizing usable when storage is unavailable. */ }
  return {}
}

function terminalSection(terminal: LibraryTerminal): TerminalSection {
  const kind = sessionKind(terminal.session?.labels)
  if (kind === 'server') return 'servers'
  if (!terminal.session || ['stopped', 'exited', 'failed', 'unavailable'].includes(terminal.session.lifecycle.state)) return 'inactive'
  if (isMyTerminal(terminal.session?.labels)) return 'mine'
  if (kind === 'job') return 'jobs'
  const app = terminal.session?.labels?.app?.trim()
  return app === 'pathspec' ? 'pathspec' : 'other'
}

function sectionEntries(rows: LibraryTerminal[]) {
  const grouped: Record<TerminalSection, LibraryTerminal[]> = {
    servers: [],
    jobs: [],
    mine: [],
    pathspec: [],
    other: [],
    inactive: [],
  }
  for (const row of rows) grouped[terminalSection(row)].push(row)
  return sectionOrder
    .filter(section => grouped[section].length || section === 'inactive' || section === 'servers')
    .map(section => ({ section, terminals: grouped[section] }))
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
  const [expandedSections, setExpandedSections] = useState(readExpandedSections)
  const [sectionHeights, setSectionHeights] = useState(readSectionHeights)
  const [sectionContainers] = useState(() => Object.fromEntries(sectionOrder.map(section =>
    [section, createRef<HTMLDivElement>()]
  )) as Record<TerminalSection, RefObject<HTMLDivElement | null>>)
  const [collapsedMatches, setCollapsedMatches] = useState<Set<TerminalSection>>(() => new Set())
  useEffect(() => {
    try { localStorage.setItem(expandedSectionsKey, JSON.stringify([...expandedSections])) }
    catch { /* Expansion still works for this visit. */ }
  }, [expandedSections])
  useEffect(() => {
    try { localStorage.setItem(sectionHeightsKey, JSON.stringify(sectionHeights)) }
    catch { /* Resizing still works for this visit. */ }
  }, [sectionHeights])
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
  const showingMatches = Boolean(search.trim()) || selectedFilter !== '@all'
  const isExpanded = (section: TerminalSection) => showingMatches ? !collapsedMatches.has(section) : expandedSections.has(section)
  const updateSearch = (value: string) => {
    setSearch(value)
    setCollapsedMatches(new Set())
  }
  const toggleSection = (section: TerminalSection) => {
    const update = (current: Set<TerminalSection>) => {
      const next = new Set(current)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    }
    if (showingMatches) setCollapsedMatches(update)
    else setExpandedSections(update)
  }
  const entries = sectionEntries(displayed)
  const fillSection = entries.filter(({ section }) => !bottomSections.has(section) && isExpanded(section)).at(-1)?.section
  const renderSection = ({ section, terminals }: (typeof entries)[number]) => <TerminalLibrarySection key={section}
    id={section} title={sectionTitles[section]} icon={sectionIcons[section]} count={terminals.length}
    fillAvailable={section === fillSection}
    expanded={isExpanded(section)} toggle={() => toggleSection(section)} rows={sectionContainers[section]}
    height={sectionHeights[section]}
    resize={height => setSectionHeights(current => ({ ...current, [section]: height }))} />
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
    <ContentTheme className="aixand-theme-contents"><WorkspaceSidebar
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
      <WorkspaceSidebarHeader title="Terminals" actions={<>
        <Tooltip content={searchOpen ? 'Close terminal search' : 'Search terminals'} className="tw-library-tooltip">
        <Button ref={searchToggle} variant="ghost" size="sm" iconOnly aria-label={searchOpen ? 'Close terminal search' : 'Search terminals'}
          aria-expanded={searchOpen} aria-controls="terminal-library-search" onPress={() => {
            setSearchOpen(!searchOpen)
            if (searchOpen) updateSearch('')
          }}><Icon name={searchOpen ? 'x' : 'search'} /></Button></Tooltip>
        <TerminalFilter value={selectedFilter}
          onChange={value => {
            setFilter(value)
            setCollapsedMatches(new Set())
            setCreationGroup(value.startsWith('@') ? '' : value)
          }}
          options={[
            { id: '@all', label: `All terminals · ${rows.length}` },
            { id: '@ungrouped', label: `Ungrouped · ${rows.filter(row => !row.group).length}` },
            ...labelGroups.map(group => ({ id: group.id, label: `${group.label} · ${group.count}` })),
            ...data.groups.map(group => ({ id: group.name, label: `${group.name} · ${group.members.length}` })),
          ]} />
        <TerminalOptions connected={connected} busy={cleaning || creating || pendingSessions.size > 0}
          groups={data} mutateGroup={mutateAndKeepFocus}
          cleanupCount={new Set(rows.filter(row => !row.session || ['stopped', 'exited', 'failed'].includes(row.session.lifecycle.state))
            .map(row => row.session?.id ?? row.member!.session_id)).size}
          refresh={refresh} fullscreen={fullscreen} toggleFullscreen={toggleFullscreen} clean={clean} />
        <TerminalAction className="tw-sidebar-close" label="Close terminal list" onPress={onClose} icon="close" />
      </>} />
      <WorkspaceSidebarActions>
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
              <Button ref={newTerminalButton} variant="ghost" aria-label="New terminal"
                className="workspace-sidebar__action tw-new-terminal" disabled={!connected || creating || cleaning}>
                <Icon name="plus" /><span>New terminal</span>
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
                    setExpandedSections(current => new Set([...current, 'mine']))
                    setCollapsedMatches(current => {
                      const next = new Set(current)
                      next.delete('mine')
                      return next
                    })
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
              <div className="tw-create-actions">
                <MenuTrigger>
                  <Tooltip content={newGroup ? `Group: ${newGroup.name}` : 'Choose a group'}>
                    <Button variant="ghost" size="sm" iconOnly className="tw-create-group-trigger"
                      aria-label={`New terminal group: ${newGroup?.name ?? 'Ungrouped'}`}
                      data-selected={Boolean(newGroup) || undefined} disabled={!connected || creating}>
                      <Icon name="folder" />
                    </Button>
                  </Tooltip>
                  <DropdownSurface className="bbb-dropdown-menu tw-create-group-menu" placement="bottom start">
                    <Menu aria-label="New terminal group" className="bbb-option-list" selectionMode="single"
                      disallowEmptySelection selectedKeys={[newGroup?.name ?? '@ungrouped']}
                      onAction={id => setCreationGroup(id === '@ungrouped' ? '' : String(id))}>
                      <MenuItem id="@ungrouped" textValue="Ungrouped" className="bbb-option">
                        {({ isSelected }) => <><span>Ungrouped</span>{isSelected && <Icon name="check" />}</>}
                      </MenuItem>
                      {data.groups.map(group => <MenuItem key={group.name} id={group.name} textValue={group.name}
                        className="bbb-option" isDisabled={group.deleting || Boolean(group.pending_name)}>
                        {({ isSelected }) => <><span>{group.name}</span>{isSelected && <Icon name="check" />}</>}
                      </MenuItem>)}
                    </Menu>
                  </DropdownSurface>
                </MenuTrigger>
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
              </div>
            </form>
          </Popover>
        </UNSAFE_PortalProvider>
      </WorkspaceSidebarActions>
      {searchOpen && <div id="terminal-library-search" className="tw-search">
        <SearchField ref={searchInput} label="Search terminals" autoFocus value={search} onChange={updateSearch}
          placeholder="Find a terminal or process…" onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              if (search) updateSearch('')
              else { setSearchOpen(false); searchToggle.current?.focus() }
            }
          }} />
      </div>}
      <WorkspaceSidebarBody className="tw-session-list" aria-busy={loading}>
        <div className="tw-active-sections">
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
        {entries.filter(({ section }) => !bottomSections.has(section)).map(renderSection)}
        </div>
        <div className="tw-bottom-sections">
          {entries.filter(({ section }) => bottomSections.has(section)).map(renderSection)}
        </div>
        {displayed.map((terminal, order) => {
          const session = terminal.session
          return <TerminalLibrarySlot key={terminal.key} container={sectionContainers[terminalSection(terminal)]} order={order}>
            <TerminalLibraryRow terminal={terminal} data={data} hidden={!isExpanded(terminalSection(terminal))}
            selected={Boolean(session && activeId === session.id)} isOpen={Boolean(session && openIds.has(session.id))}
            connected={connected} pending={Boolean(session && pendingSessions.has(session.id))}
            mutateGroup={mutateAndKeepFocus} mutateSession={mutateSession} openSession={openSession} drag={drag} />
          </TerminalLibrarySlot>
        })}
      </WorkspaceSidebarBody>
    </WorkspaceSidebar></ContentTheme>
  )
}
