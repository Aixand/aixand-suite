import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, LoadingIndicator, SearchField, TreeView } from 'bbb-design'
import type { Pack } from './model'
import { packGroups, preferredRevision } from './presentation'
import type { PromptSelection } from './presentation'

export function PromptLibrary({
  packs,
  search,
  onSearch,
  revisions,
  selection,
  loading,
  onView,
  managed,
  managedCount = 0,
}: {
  packs: Pack[]
  search: string
  onSearch: (value: string) => void
  revisions: Record<string, string>
  selection: PromptSelection | null
  loading: boolean
  onView: (pack: Pack, name?: string) => void
  managed?: ReactNode
  managedCount?: number
}) {
  const [collapsed, setCollapsed] = useState<string[]>([])
  const pressed = useRef<{ key: string; selected: boolean } | null>(null)
  const [searchExpansion, setSearchExpansion] = useState({
    query: '',
    collapsed: [] as string[],
  })
  const query = search.trim().toLowerCase()
  const groups = packGroups(packs).flatMap((group) => {
    const pack =
      group.revisions.find((row) => row.id === revisions[group.name]) ??
      preferredRevision(group.revisions)
    const prompts = (
      pack.prompts.length
        ? pack.prompts
        : [{ name: undefined, description: 'Shared sections and documents' }]
    ).filter((prompt) =>
      [
        pack.name,
        pack.source,
        pack.description,
        prompt.name,
        prompt.description,
      ]
        .join(' ')
        .toLowerCase()
        .includes(query),
    )
    return prompts.length ? [{ ...group, pack, prompts }] : []
  })
  const count = groups.reduce((total, group) => total + group.prompts.length, 0)
  const leaves = new Map<string, { pack: Pack; name?: string }>()
  const items = groups.map(({ name, pack, prompts }) => ({
    id: `pack:${name}`,
    label: name,
    children: prompts.map((prompt) => {
      const id = `prompt:${pack.id}:${prompt.name ?? ''}`
      leaves.set(id, { pack, name: prompt.name })
      return { id, label: prompt.name ?? 'Shared content' }
    }),
  }))
  const folderIds = items.map((item) => item.id)
  // Search reveals matching children without changing the saved folder state.
  const closed = query
    ? searchExpansion.query === query
      ? searchExpansion.collapsed
      : []
    : collapsed
  const selectedId = selection
    ? `prompt:${selection.packId}:${selection.prompt ?? ''}`
    : undefined

  function expand(expanded: string[]) {
    const next = folderIds.filter((id) => !expanded.includes(id))
    if (query) setSearchExpansion({ query, collapsed: next })
    else
      setCollapsed((current) => [
        ...current.filter((id) => !folderIds.includes(id)),
        ...next,
      ])
  }

  function toggleFolder(id: string) {
    expand(
      folderIds.filter((key) =>
        key === id ? closed.includes(key) : !closed.includes(key),
      ),
    )
  }

  return (
    <nav className="prompts-library" aria-label="Prompt library">
      <div className="prompts-library-toolbar">
        <SearchField
          label="Search prompts"
          placeholder="Search prompts"
          value={search}
          onChange={onSearch}
        />
        {(!loading || packs.length > 0) && <span className="prompts-note" role="status">
          {count + managedCount} {managedCount ? 'library items' : count === 1 ? 'prompt' : 'prompts'}
        </span>}
      </div>
      {managed}
      {items.length > 0 && (
        <div
          onPointerDownCapture={(event) => {
            const row =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>('.bbb-tree-view__item')
                : null
            pressed.current = row?.dataset.key
              ? {
                  key: row.dataset.key,
                  selected: row.getAttribute('aria-selected') === 'true',
                }
              : null
          }}
          onClickCapture={(event) => {
            const previous = pressed.current
            pressed.current = null
            if (
              !(event.target instanceof Element) ||
              event.target.closest('button')
            )
              return
            const key = event.target.closest<HTMLElement>(
              '.bbb-tree-view__item',
            )?.dataset.key
            if (!key) return
            if (folderIds.includes(key)) toggleFolder(key)
            else if (previous?.key === key && previous.selected) {
              // Selection remains unchanged when clicking an already-selected file.
              const leaf = leaves.get(key)
              if (leaf) onView(leaf.pack, leaf.name)
            }
          }}
          onKeyDownCapture={(event) => {
            if (
              !['Enter', ' '].includes(event.key) ||
              !(event.target instanceof Element) ||
              event.target.closest('button')
            )
              return
            const key = event.target.closest<HTMLElement>(
              '.bbb-tree-view__item',
            )?.dataset.key
            if (!key) return
            if (folderIds.includes(key) || key === selectedId) {
              event.preventDefault()
              event.stopPropagation()
              if (folderIds.includes(key)) toggleFolder(key)
              else {
                const leaf = leaves.get(key)
                if (leaf) onView(leaf.pack, leaf.name)
              }
            }
          }}
        >
          <TreeView
            label="Prompt tree"
            className="prompts-tree"
            items={items}
            selectedId={
              selectedId && leaves.has(selectedId) ? selectedId : undefined
            }
            expandedIds={folderIds.filter((id) => !closed.includes(id))}
            onExpandedChange={expand}
            onSelectionChange={(id) => {
              const leaf = leaves.get(id)
              if (leaf) onView(leaf.pack, leaf.name)
            }}
          />
        </div>
      )}
      {groups
        .filter((group) => group.pack.error)
        .map(({ name, pack }) => (
          <p key={name} className="prompts-source-error">
            {name}: {pack.error}
          </p>
        ))}
      {!groups.length && !managedCount && (
        <div className="prompts-library-empty">
          {loading ? (
            <LoadingIndicator label="Loading prompts…" />
          ) : (
            <>
              <p>{query ? 'No matching prompts.' : 'No prompts yet.'}</p>
              {query ? (
                <Button size="sm" variant="ghost" onPress={() => onSearch('')}>
                  Clear search
                </Button>
              ) : (
                <p className="prompts-note">
                  Register a source with Prompt Manager to add prompts.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </nav>
  )
}
