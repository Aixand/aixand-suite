import { useContentFieldVariant } from '../branding/ContentTheme'
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Icon, SearchField, Select, Tooltip } from 'bbb-design'
import { PageLoading } from '../components/PageLoading'
import { recoveryOperation, recoveryRequest } from './client'
import type { Availability, RecoveryCatalog, RecoverySession, TerminalRecovery } from './client'
import './recovery.css'

const availabilityLabel: Record<Availability, string> = {
  unchecked: 'Check availability', checking: 'Checking availability', ready: 'Ready to open', busy: 'Turn in progress',
  terminal: 'Already in terminal', saved: 'Saved history only', unsupported: 'Terminal attachment unavailable',
  unknown: 'Availability unknown', blocked: 'Another activity owns input',
}

function sessionDate(timestamp: number) {
  const date = new Date(timestamp)
  if (!timestamp || !Number.isFinite(date.getTime())) return null
  const today = new Date()
  const label = date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) })
  return { label, full: date.toLocaleString(), iso: date.toISOString() }
}

export function RecoveryPicker({ initialChatId, onOpenTerminal, onRetryChat, showIndependentLink = false }: {
  initialChatId?: string; onOpenTerminal: (sessionId: string) => void; onRetryChat?: () => void; showIndependentLink?: boolean
}) {
  const fieldVariant = useContentFieldVariant()
  const [query, setQuery] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersId = useId()
  const [profile, setProfile] = useState('')
  const [project, setProject] = useState('')
  const [cursor, setCursor] = useState('')
  const [providerHistory, setProviderHistory] = useState(false)
  const [catalog, setCatalog] = useState<RecoveryCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState(initialChatId ?? '')
  const [status, setStatus] = useState<TerminalRecovery | null>(null)
  const [statusError, setStatusError] = useState('')
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [inspect, setInspect] = useState(0)
  const current = useRef(selected)
  current.current = selected
  const hasSessions = useRef(false)
  const [notice, setNotice] = useState('')
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    const timer = setTimeout(() => {
      const parameters = new URLSearchParams({ q: query, profile, project, cursor, history: String(providerHistory) })
      void recoveryRequest<RecoveryCatalog>(`recovery/sessions?${parameters}`, undefined, controller.signal).then((value) => {
        setCatalog(value)
        hasSessions.current = value.sessions.length > 0
      }).catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message)
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 150)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, profile, project, cursor, providerHistory, refresh])

  useEffect(() => {
    setStatus(null)
    setStatusError('')
    setChecking(false)
    if (!selected || selected.startsWith('saved-')) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    setChecking(true)
    async function check() {
      try {
        const value = await recoveryRequest<TerminalRecovery>(`chats/${encodeURIComponent(selected)}/terminal`, undefined, controller.signal)
        if (controller.signal.aborted) return
        setStatus(value)
        setStatusError('')
        setChecking(false)
        if (value.terminal && ['queued', 'launching', 'running', 'releasing', 'uncertain', 'unavailable'].includes(value.terminal.status)) {
          if (opening && value.terminal.status === 'running' && value.terminal.sessionId) {
            recoveryOperation(selected, 'open').done()
            setOpening(false)
            onOpenTerminal(value.terminal.sessionId)
            return
          }
          timer = setTimeout(() => { void check() }, 1500)
        } else if (value.terminal && ['released', 'exited', 'failed'].includes(value.terminal.status)) { recoveryOperation(selected, 'open').done(); setOpening(false) }
      } catch (cause) {
        if (!controller.signal.aborted) { setStatusError(cause instanceof Error ? cause.message : 'Availability could not be checked.'); setChecking(false) }
      }
    }
    void check()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [selected, inspect, opening, onOpenTerminal])

  const listed = catalog?.sessions.find(row => row.id === selected)
  const conversation = listed ?? status?.conversation
  const terminal = status?.terminal
  const terminalActive = Boolean(terminal && ['queued', 'launching', 'running', 'releasing', 'uncertain', 'unavailable'].includes(terminal.status))
  const availability = status?.availability ?? listed?.availability
  const filterCount = Number(Boolean(profile)) + Number(Boolean(project))

  async function act(release = false) {
    if (!selected || busy) return
    if (!release && terminal?.status === 'running' && terminal.sessionId) { onOpenTerminal(terminal.sessionId); return }
    const target = selected
    const operation = recoveryOperation(target, release ? 'release' : 'open')
    setBusy(true)
    setStatusError('')
    try {
      const result = await recoveryRequest<TerminalRecovery>(`chats/${encodeURIComponent(target)}/terminal${release ? '/release' : ''}`, { key: operation.key })
      if (current.current !== target) return
      setStatus(result)
      if (release) { operation.done(); setOpening(false); setNotice('Returning control when the terminal client has stopped.') }
      else {
        setOpening(true)
        setNotice('Starting your terminal. It will open here when ready.')
      }
      setInspect(value => value + 1)
    } catch (cause) {
      if (current.current === target) setStatusError(cause instanceof Error ? cause.message : 'Terminal recovery failed.')
    } finally { setBusy(false) }
  }

  function choose(row: RecoverySession) {
    setSelected(row.id)
    setOpening(false)
    setNotice('')
    setStatusError('')
    setInspect(value => value + 1)
  }

  return <div className="recovery-picker">
    <div className="recovery-toolbar">
      <SearchField autoFocus label="Search conversations" value={query} placeholder="Search conversations…"
        onChange={value => { setQuery(value); setCursor('') }} />
      <Tooltip content={filterCount ? `Filter conversations (${filterCount} active)` : 'Filter conversations'}>
        <Button variant="ghost" iconOnly aria-label="Filter conversations" aria-expanded={filtersOpen} aria-controls={filtersId}
          className={`recovery-filter-toggle${filterCount ? ' recovery-filter-toggle--active' : ''}`} onPress={() => setFiltersOpen(value => !value)}>
          <Icon name="layers" />{filterCount > 0 && <span className="recovery-filter-dot" aria-hidden="true" />}
        </Button>
      </Tooltip>
      <Tooltip content="Refresh conversations"><Button variant="ghost" iconOnly aria-label="Refresh conversations"
        onPress={() => setRefresh(value => value + 1)} disabled={loading}><Icon name="refresh-cw" /></Button></Tooltip>
    </div>
    <div id={filtersId} className="recovery-filters" hidden={!filtersOpen}>
      <Select label="Profile" variant={fieldVariant} value={profile} onChange={value => { setProfile(value); setCursor('') }} options={[{ id: '', label: 'All profiles' }, ...(catalog?.profiles ?? []).map(id => ({ id, label: id }))]} />
      <Select label="Project" variant={fieldVariant} value={project} onChange={value => { setProject(value); setCursor('') }} options={[{ id: '', label: 'All projects' }, ...(catalog?.projects ?? []).map(id => ({ id, label: id }))]} />
      {filterCount > 0 && <Button variant="ghost" size="sm" onPress={() => { setProfile(''); setProject(''); setCursor('') }}>Clear filters</Button>}
    </div>
    {error && <div className="recovery-message" role="alert"><strong>Session list unavailable</strong><p>{error}</p>{hasSessions.current && <p>The sessions below are from the last successful check.</p>}<Button variant="secondary" onPress={() => setRefresh(value => value + 1)}>Retry session list</Button></div>}
    {catalog?.partial && <p className="recovery-message" role="status">{catalog.errors.join(' ') || 'Some session information is unavailable.'}</p>}
    <section className="recovery-results" aria-label="Conversations" aria-busy={loading}>
      <div className="recovery-results-heading">
        <h2>{providerHistory ? 'Saved provider sessions' : query || profile || project ? 'Matching conversations' : 'Recent conversations'}</h2>
        {loading && catalog && <span role="status">Updating…</span>}
      </div>
      {loading && !catalog ? <PageLoading label="Loading recovery sessions…" size="panel" /> : <>
        <div className="recovery-session-list" aria-label="Recovery sessions">
          {(catalog?.sessions ?? []).map(row => {
            const date = sessionDate(row.updatedAt)
            return <button type="button" key={row.id} className="recovery-session" aria-pressed={selected === row.id} onClick={() => choose(row)}>
              <Icon name="message-square-reply" className="recovery-session-icon" />
              <span className="recovery-session-copy"><strong>{row.title}</strong><span className="recovery-session-meta">{row.project || row.cwd || 'General conversation'}<span aria-hidden="true"> · </span>{row.profile}</span></span>
              <span className="recovery-session-trailing">{date && <time dateTime={date.iso} title={date.full}>{date.label}</time>}
                {selected === row.id && <Icon name="check" />}</span>
            </button>
          })}
        </div>
        {!error && !loading && !catalog?.sessions.length && <div className="recovery-empty" role="status"><Icon name="search" />
          <strong>{query || profile || project ? 'No matching conversations.' : 'No saved conversations were found in this view.'}</strong>
          <p>{query || profile || project ? 'Try another search or clear your filters.' : 'You can also look through saved provider history.'}</p>
        </div>}
        {(cursor || catalog?.nextCursor) && <div className="recovery-pagination"><Button variant="ghost" size="sm" disabled={!cursor || loading} onPress={() => setCursor('')}><Icon name="arrow-left" />Most recent</Button>
          <Button variant="ghost" size="sm" disabled={!catalog?.nextCursor || loading} onPress={() => setCursor(catalog!.nextCursor!)}>More sessions<Icon name="arrow-right" /></Button></div>}
      </>}
    </section>
    {selected && <section className="recovery-selection" aria-label="Selected recovery conversation">
      <div className="recovery-selection-summary"><div><h2>{conversation?.title ?? 'Selected conversation'}</h2>
        <p role="status"><Icon name={checking ? 'refresh-cw' : availability === 'ready' || availability === 'terminal' ? 'circle-check' : 'info'} />{checking ? 'Checking the original conversation…' : availability ? availabilityLabel[availability] : 'Choose a session to check its availability.'}</p>
        </div><Tooltip content="Check availability"><Button variant="ghost" iconOnly aria-label="Check availability" disabled={busy || checking || selected.startsWith('saved-')} onPress={() => setInspect(value => value + 1)}><Icon name="refresh-cw" /></Button></Tooltip>
      </div>
      {selected.startsWith('saved-') && <p>This saved history has no verified original live process for terminal attachment.</p>}
      {status?.reason && <p>{status.reason}</p>}
      {terminal?.error && <p role="status">{terminal.error}</p>}
      {statusError && <p role="alert">{statusError}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="recovery-actions">
        {conversation?.source === 'suite' && <a className="recovery-chat-link" href={`/#/chat/${encodeURIComponent(selected)}`}
          onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) onRetryChat?.() }}><Icon name="message-square-reply" />Retry opening this chat</a>}
        {terminalActive && <Button variant="secondary" disabled={busy || terminal?.status === 'releasing'} onPress={() => { void act(true) }}>{terminal?.status === 'queued' ? 'Cancel terminal request' : 'Stop terminal client'}</Button>}
        <Button onPress={() => { void act() }} disabled={busy || checking || !status?.supported || !['ready', 'busy', 'terminal'].includes(status.availability)}>
          <Icon name="square-terminal" />{terminal?.status === 'running' ? 'Open terminal' : 'Open in terminal'}
        </Button>
      </div>
    </section>}
    <div className="recovery-footer"><Button variant="ghost" size="sm" aria-label={providerHistory ? 'Show Suite conversations' : 'Find saved provider history'}
      onPress={() => { setProviderHistory(value => !value); setCursor(''); setSelected(''); setOpening(false); setNotice('') }}>
      <Icon name={providerHistory ? 'messages-square' : 'rotate-ccw-clock'} />{providerHistory ? 'Suite conversations' : 'Saved provider history'}
    </Button>
      {showIndependentLink && <a href="/recovery.html">Open recovery page<Icon name="external-link" /></a>}
    </div>
  </div>
}
