import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, DropdownMenu, Icon, SearchField, Tooltip } from 'bbb-design'
import { ChatStatus, type ChatActivity } from './ChatStatus'
import type { Labels } from '../terminals/context'
import './ChatHistory.css'
import type { Monitor } from '../command/model'
import { supervisionLabel } from '../command/supervision'

export const recentHistoryLimit = 20

export type Preview = {
  id: string
  mode: 'chat' | 'work'
  prompt: string
  agent: string
  model?: string
  project?: string
  chat?: boolean
  parentId?: string | null
  createdAt?: number
  labels?: Labels
  activity?: ChatActivity
  supervision?: Monitor
}
type HistoryEntry = { item: Preview; children: HistoryEntry[] }
function HistoryItem({ item, activeId, childCount = 0, onSelect, onDelete }: {
  item: Preview
  activeId?: string
  childCount?: number
  onSelect: (item: Preview) => void
  onDelete: (item: Preview) => void
}) {
  const title = item.prompt.split('\n')[0]
  const [menuOpen, setMenuOpen] = useState(false)
  const itemRef = useRef<HTMLButtonElement>(null)
  const contextOpened = useRef(false)
  return <>
    <Button ref={itemRef} variant="ghost" className="command-history-item"
      aria-current={activeId === item.id ? 'true' : undefined}
      onPress={() => onSelect(item)}
      onContextMenu={(event) => { event.preventDefault(); contextOpened.current = true; setMenuOpen(true) }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); contextOpened.current = true; setMenuOpen(true)
        }
      }}>
      <span className="command-history-copy">
        <span className="chat-history-title" title={title}>{title}</span>
      </span>
      <ChatStatus activity={item.activity ?? 'draft'} compact />
      {item.supervision && <span className="bbb-visually-hidden">{supervisionLabel(item.supervision)}</span>}
      {childCount > 0 && <span className="bbb-visually-hidden">{childCount} {childCount === 1 ? 'session' : 'sessions'} in this group</span>}
    </Button>
    <DropdownMenu label="Conversation actions" open={menuOpen} onOpenChange={(open) => {
      setMenuOpen(open)
      if (!open && contextOpened.current) {
        contextOpened.current = false
        requestAnimationFrame(() => itemRef.current?.focus())
      }
    }}
      trigger={<Button variant="ghost" size="sm" iconOnly className="chat-history-more" aria-label={`Conversation actions for ${title}`}><Icon name="ellipsis" /></Button>}
      items={[{ id: 'delete', label: 'Delete conversation', danger: true, leading: <Icon name="trash-2" /> }]}
      onAction={() => { setMenuOpen(false); onDelete(item) }} />
  </>
}

export function groupHistory(items: Preview[], allItems: Preview[], includeChildren: boolean): HistoryEntry[] {
  const available = new Map(allItems.map((item) => [item.id, item]))
  const selected = new Map<string, Preview>()
  const parents = new Map<string, string>()
  function include(item: Preview, ancestors = new Set<string>()) {
    if (selected.has(item.id)) return
    ancestors.add(item.id)
    const parent = item.parentId ? available.get(item.parentId) : undefined
    if (parent && !ancestors.has(parent.id)) {
      include(parent, ancestors)
      parents.set(item.id, parent.id)
    }
    selected.set(item.id, item)
    ancestors.delete(item.id)
  }
  // Keep the parent visible when a recent or project filter includes its child.
  for (const item of items) include(item)
  if (includeChildren) {
    const children = new Map<string, Preview[]>()
    for (const item of allItems) {
      if (item.parentId) children.set(item.parentId, [...(children.get(item.parentId) ?? []), item])
    }
    // An expanded Recent/Chats group exposes all its attached sessions.
    for (const item of selected.values()) {
      for (const child of children.get(item.id) ?? []) include(child)
    }
  }
  const entries = new Map([...selected].map(([id, item]) => [id, { item, children: [] } as HistoryEntry]))
  const roots: HistoryEntry[] = []
  for (const [id, entry] of entries) {
    const parent = entries.get(parents.get(id) ?? '')
    if (parent) parent.children.push(entry)
    else roots.push(entry)
  }
  return roots
}

function HistoryList({ label, items, allItems, activeId, emptyText, expandedParents, includeChildren = true, onToggleParent, onSelect, onDelete }: {
  label: string
  items: Preview[]
  allItems: Preview[]
  activeId?: string
  emptyText: string
  expandedParents: string[]
  includeChildren?: boolean
  onToggleParent: (id: string) => void
  onSelect: (item: Preview) => void
  onDelete: (item: Preview) => void
}) {
  const listId = useId()
  function renderEntry({ item, children }: HistoryEntry): ReactNode {
    const expanded = expandedParents.includes(item.id)
    const childrenId = `${listId}-children-${item.id}`
    const title = item.prompt.split('\n')[0]
    return <li key={item.id}>
      <div className={`command-history-row${children.length ? ' command-history-row--group' : ''}`}>
        {!!children.length && <Button variant="ghost" size="sm" iconOnly className="command-history-toggle"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} sessions spawned from ${title}`}
          aria-expanded={expanded} aria-controls={childrenId} onPress={() => onToggleParent(item.id)}>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
        </Button>}
        <HistoryItem item={item} activeId={activeId} childCount={children.length} onSelect={onSelect} onDelete={onDelete} />
      </div>
      {!!children.length && <ul id={childrenId} className="command-history-children" hidden={!expanded} aria-label={`Sessions spawned from ${title}`}>
        {children.map(renderEntry)}
      </ul>}
    </li>
  }
  return (
    <section className="command-history-list" aria-label={label}>
      {items.length ? (
        <ul aria-label={label}>
          {groupHistory(items, allItems, includeChildren).map(renderEntry)}
        </ul>
      ) : <p className="command-history-empty">{emptyText}</p>}
    </section>
  )
}

export function ChatHistory({ selectedProject, recent, projectHistory, history, activeId, expandedParents, supervisingOnly, onSupervisingOnlyChange, onToggleParent, onProjectChange, onStartProject, onNewProject, canCreateProject, onSelect, onDelete }: {
  selectedProject: string | null
  recent: Preview[]
  projectHistory: Map<string, Preview[]>
  history: Preview[]
  activeId?: string
  expandedParents: string[]
  supervisingOnly: boolean
  onSupervisingOnlyChange: (value: boolean) => void
  onToggleParent: (id: string) => void
  onProjectChange: (project: string | null) => void
  onStartProject: (project: string) => void
  onNewProject: () => void
  canCreateProject: boolean
  onSelect: (item: Preview) => void
  onDelete: (item: Preview) => void
}) {
  const id = useId()
  const [searchOpen, setSearchOpen] = useState(false)
  const [projectQuery, setProjectQuery] = useState('')
  const searchToggle = useRef<HTMLButtonElement>(null)
  const projectListId = `${id}-projects`
  const projects = useMemo(() => [...projectHistory].sort(([a], [b]) => a.localeCompare(b)), [projectHistory])
  const matches = projects.filter(([project]) => project.toLocaleLowerCase().includes(projectQuery.trim().toLocaleLowerCase()))
  function closeSearch() {
    setSearchOpen(false)
    setProjectQuery('')
    searchToggle.current?.focus()
  }
  return <nav className="command-history-browser" aria-label="Chat history">
    <section className="chat-history-section" aria-label="Projects">
      <div className="chat-history-section-heading">
        <h2>Projects</h2>
        {!!projectHistory.size && <Tooltip content={searchOpen ? 'Close project search' : 'Search projects'}>
          <Button ref={searchToggle} variant="ghost" size="sm" iconOnly aria-label={searchOpen ? 'Close project search' : 'Search projects'}
            aria-expanded={searchOpen} aria-controls={`${id}-project-search`}
            onPress={() => { if (searchOpen) closeSearch(); else setSearchOpen(true) }}><Icon name={searchOpen ? 'x' : 'search'} /></Button>
        </Tooltip>}
        <Tooltip content="New project"><Button variant="ghost" size="sm" iconOnly aria-label="New project"
          disabled={!canCreateProject} onPress={onNewProject}><Icon name="folder-plus" /></Button></Tooltip>
      </div>
      {searchOpen && <div id={`${id}-project-search`} className="chat-project-search">
        <SearchField label="Search projects" placeholder="Find a project…" value={projectQuery} onChange={setProjectQuery}
          autoFocus aria-controls={projectListId} onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              if (projectQuery) setProjectQuery(''); else closeSearch()
            }
          }} />
      </div>}
      {projectHistory.size ? <ul id={projectListId} className="chat-project-list" aria-label="Project folders">
        {matches.map(([project, items], index) => {
          const expanded = selectedProject === project
          const regionId = `${id}-project-${index}`
          return <li key={project}>
            <Button variant="ghost" className="command-history-project-item" aria-label={`${project}, ${items.length} ${items.length === 1 ? 'conversation' : 'conversations'}`}
              aria-expanded={expanded} aria-controls={regionId} onPress={() => onProjectChange(expanded ? null : project)}>
              <Icon name="folder" /><span className="command-history-project-name">{project}</span>
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
            </Button>
            {expanded && <div id={regionId} className="chat-project-conversations">
              <Button variant="ghost" size="sm" className="chat-project-new" onPress={() => onStartProject(project)}><Icon name="plus" />Start conversation</Button>
              <HistoryList label={`${project} conversations`} items={items} allItems={history} activeId={activeId}
                expandedParents={expandedParents} onToggleParent={onToggleParent}
                emptyText="No conversations yet." onSelect={onSelect} onDelete={onDelete} />
            </div>}
          </li>
        })}
      </ul> : <p className="chat-history-helper">Keep related conversations together.</p>}
      {!!projectHistory.size && !matches.length && <p className="chat-history-helper" role="status">No matching projects.</p>}
    </section>
    <section className="chat-history-section">
      <div className="chat-history-section-heading">
        <h2>Recent</h2>
        <Tooltip content="Show supervising chats">
          <Button variant="ghost" size="sm" iconOnly className="chat-history-supervision-filter"
            aria-label="Show supervising chats" aria-pressed={supervisingOnly}
            onPress={() => onSupervisingOnlyChange(!supervisingOnly)}><Icon name="eye" /></Button>
        </Tooltip>
      </div>
      <HistoryList label="Recent conversations" items={recent.slice(0, recentHistoryLimit)} allItems={recent} activeId={activeId}
        expandedParents={expandedParents} onToggleParent={onToggleParent}
        emptyText={supervisingOnly ? 'No chats with ongoing supervision.' : 'Your conversations will appear here.'} onSelect={onSelect} onDelete={onDelete} />
    </section>
  </nav>
}
