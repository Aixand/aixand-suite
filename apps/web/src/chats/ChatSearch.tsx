import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, Icon, Tooltip } from 'bbb-design'

export type ChatSearchResult = { chatId: string; itemId: string | null; title: string; project?: string; profile?: string; excerpt: string }
export type ChatSearchPage = { results: ChatSearchResult[]; cursor: string | null; indexing: boolean; partial: boolean; bounded?: boolean; indexError?: string | null }
export type ChatSearchArgs = { query: string; includeTools?: boolean; project?: string; cursor?: string; limit?: number }

// Render FTS match markers as React text and elements, never injected HTML.
function excerpt(text: string) {
  return text.split('\u0001').map((part, index) => {
    if (!index) return part
    const end = part.indexOf('\u0002')
    return <span key={index}><mark>{end < 0 ? part : part.slice(0, end)}</mark>{end < 0 ? '' : part.slice(end + 1)}</span>
  })
}

export function ChatSearch({ search, onSelect, localItems = [] }: {
  localItems?: ChatSearchResult[]
  search: (args: ChatSearchArgs) => Promise<ChatSearchPage>
  onSelect: (result: ChatSearchResult) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [includeTools, setIncludeTools] = useState(false)
  const [page, setPage] = useState<ChatSearchPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)
  const generation = useRef(0)
  const searchRef = useRef(search)
  searchRef.current = search
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect

  useEffect(() => {
    const current = ++generation.current
    setPage(null)
    setError('')
    setLoading(open && Boolean(query.trim()))
    if (!open || !query.trim()) return
    const timer = window.setTimeout(() => {
      void searchRef.current({ query, includeTools, project: project.trim() || undefined, limit: 25 }).then(result => {
        if (current === generation.current) setPage({ ...result, results: result.results ?? [] })
      }).catch((cause: unknown) => {
        if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Could not search conversations.')
      }).finally(() => { if (current === generation.current) setLoading(false) })
    }, 200)
    return () => { window.clearTimeout(timer); generation.current++ }
  }, [open, query, project, includeTools])

  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [open])

  const localMatches = query.trim() ? localItems.filter(item =>
    (!project.trim() || item.project === project.trim()) && query.toLocaleLowerCase().split(/\s+/).every(term =>
      `${item.title} ${item.excerpt} ${item.project ?? ''} ${item.profile ?? ''}`.toLocaleLowerCase().includes(term))) : localItems.slice(0, 25)
  const results = [...(page?.results ?? []), ...localMatches.filter(item => !page?.results?.some(row => row.chatId === item.chatId))]

  async function more() {
    if (!page?.cursor || loading) return
    const current = generation.current
    setLoading(true)
    setError('')
    try {
      const next = await searchRef.current({ query, includeTools, project: project.trim() || undefined, cursor: page.cursor, limit: 25 })
      if (current === generation.current) setPage({ ...next, results: [...page.results, ...next.results.filter(row => !page.results.some(old => old.chatId === row.chatId))] })
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Could not load more results.')
    } finally { if (current === generation.current) setLoading(false) }
  }

  async function select(result: ChatSearchResult) {
    setOpening(true)
    setError('')
    try {
      await selectRef.current(result)
      setOpen(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open this match.') }
    finally { setOpening(false) }
  }

  return <Dialog title="Search history" className="chat-content-search" open={open}
    onOpenChange={value => { setOpen(value); if (value) { setQuery(''); setProject(''); setIncludeTools(false) } }}
    trigger={<Tooltip content="Search chats"><Button variant="ghost" size="sm" iconOnly className="chat-search-conversations" aria-label="Search history"><Icon name="search" /></Button></Tooltip>}>
    <label className="chat-search-field">Search conversations and messages
      <input aria-label="Search history" autoFocus type="search" value={query} maxLength={256} placeholder="Search all conversations…" onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'ArrowDown') {
          event.currentTarget.closest('[role=dialog]')?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
          event.preventDefault()
        }
      }} />
    </label>
    <div className="chat-search-options">
      <label>Project <input value={project} maxLength={512} placeholder="All projects" onChange={event => setProject(event.target.value)} /></label>
      <label><input type="checkbox" checked={includeTools} onChange={event => setIncludeTools(event.target.checked)} /> Include tool activity</label>
    </div>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">Searching…</p>}
    {page?.indexError && <p role="status">Some history could not be indexed. Available matches are shown.</p>}
    {page?.indexing && <p role="status">Older conversations are still indexing. Results may be incomplete.</p>}
    {page?.partial && !page.indexing && <p className="chat-search-coverage">Searching locally indexed history. Earlier provider history may be unavailable.</p>}
    {page?.bounded && <p>Showing the best available matches. Add another word to narrow your search.</p>}
    {page && !loading && !results.length && <p>No matching conversations.</p>}
    <ul className="chat-search-results" role="menu" aria-label="Search results" onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])')]
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
      event.preventDefault()
    }}>
      {results.map(result => <li role="none" key={result.chatId}>
        <button type="button" role="menuitem" className="bbb-button bbb-button--ghost bbb-button--md" disabled={opening} onClick={() => { void select(result) }}>
          <strong>{result.title}</strong>
          <span className="chat-search-meta">{[result.project, result.profile].filter(Boolean).join(' · ')}</span>
          <span>{excerpt(result.excerpt.slice(0, 400))}</span>
        </button>
      </li>)}
    </ul>
    {page?.cursor && <Button variant="ghost" disabled={loading || opening} onPress={() => { void more() }}>Load more</Button>}
  </Dialog>
}
