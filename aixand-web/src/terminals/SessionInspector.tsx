import { useEffect, useState } from 'react'
import type { Session, TerminalConnection } from './connection'

type Detail = {
  summary: Session
  configuration?: Record<string, unknown> | null
  work_context?: unknown
  process?: unknown
  foreground_evidence?: unknown
  health_results?: unknown
  [key: string]: unknown
}
type SessionEvent = {
  sequence: string
  session_id: string
  kind: string
  occurred_at_millis: number
  [key: string]: unknown
}
type EventPage = {
  items: SessionEvent[]
  checkpoint: string | null
  gap: unknown
}
const json = (value: unknown) => JSON.stringify(value, null, 2)
const display = (value: unknown): string =>
  value == null
    ? 'Unknown'
    : typeof value === 'object'
      ? json(value)
      : String(value)

function JsonSection({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="inspector-section">
      <summary>{title}</summary>
      <pre>{display(value)}</pre>
    </details>
  )
}

export function SessionInspector({
  client,
  session,
  onClose,
}: {
  client: TerminalConnection | null
  session: Session | null
  onClose: () => void
}) {
  const [pinned, setPinned] = useState<Session | null>(null)
  const target = pinned ?? session
  const sessionId = target?.id
  const [view, setView] = useState('Overview')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [error, setError] = useState('')
  const [eventError, setEventError] = useState('')
  const [notice, setNotice] = useState('')
  const [updated, setUpdated] = useState<number | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [width, setWidth] = useState(390)
  useEffect(() => {
    setDetail(null)
    setEvents([])
    setError('')
    setEventError('')
    setNotice('')
    setUpdated(null)
    if (!client || !sessionId) return
    let alive = true
    let loading = false
    let dirty = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const report = (cause: unknown) => {
      if (alive)
        setError(cause instanceof Error ? cause.message : String(cause))
    }
    async function loadDetail() {
      if (loading) {
        dirty = true
        return
      }
      loading = true
      try {
        const result = await client!.request<Detail>('inspect', { sessionId })
        if (alive) {
          setDetail(result)
          setUpdated(Date.now())
          setError('')
        }
      } catch (cause) {
        report(cause)
      } finally {
        loading = false
        if (dirty && alive) {
          dirty = false
          void loadDetail()
        }
      }
    }
    async function startEvents() {
      try {
        const page = await client!.request<EventPage>('events', { sessionId })
        if (!alive) return
        setEvents(page.items.slice(-100))
        if (page.gap)
          setNotice(
            'Some older events are no longer retained. Showing available history.'
          )
        await client!.request('watch-events', {
          sessionId,
          after: page.checkpoint ?? '0',
        })
        if (alive) {
          setEventError('')
          setNotice(
            page.gap
              ? 'Some older events are no longer retained. Showing available history.'
              : ''
          )
        }
      } catch (cause) {
        if (alive) {
          setEventError(
            `Events unavailable: ${cause instanceof Error ? cause.message : String(cause)}`
          )
          clearTimeout(retry)
          retry = setTimeout(() => void startEvents(), 5000)
        }
      }
    }
    const unsubscribe = client.subscribe((event) => {
      if (!alive) return
      if (
        event.type === 'metadata' &&
        event.kind === 'events' &&
        event.payload?.item === 'session_event'
      ) {
        const item = event.payload.value as SessionEvent
        if (item.session_id !== sessionId) return
        setEvents((current) =>
          [
            ...current.filter((entry) => entry.sequence !== item.sequence),
            item,
          ].slice(-100)
        )
        void loadDetail()
      }
      if (event.type === 'metadata-gap' && event.kind === 'events') {
        setNotice('Live updates interrupted. Reloading available history.')
        clearTimeout(retry)
        retry = setTimeout(() => {
          void loadDetail()
          void startEvents()
        }, 1000)
      }
    })
    void loadDetail()
    void startEvents()
    // Reconcile metadata fields that do not produce a durable event.
    const timer = setInterval(() => void loadDetail(), 5000)
    return () => {
      alive = false
      unsubscribe()
      clearInterval(timer)
      clearTimeout(retry)
      void client.request('unwatch', { kind: 'events' }).catch(() => {})
    }
  }, [client, sessionId, refresh])
  const summary = detail?.summary
  return (
    <aside
      className="session-inspector"
      style={{ width }}
      aria-label="Terminal inspector"
    >
      <div
        className="inspector-resizer"
        role="separator"
        aria-label="Resize terminal inspector"
        aria-orientation="vertical"
        aria-valuemin={280}
        aria-valuemax={720}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            setWidth((value) =>
              Math.max(
                280,
                Math.min(720, value + (event.key === 'ArrowLeft' ? 20 : -20))
              )
            )
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            setWidth(
              Math.max(
                280,
                Math.min(
                  720,
                  event.currentTarget.parentElement!.getBoundingClientRect()
                    .right - event.clientX
                )
              )
            )
        }}
        onPointerUp={(event) =>
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      />
      <header className="inspector-heading">
        <strong>Terminal inspector</strong>
        <button onClick={onClose} aria-label="Close terminal inspector">
          ×
        </button>
      </header>
      <div className="inspector-target">
        <strong>
          {summary?.name ?? target?.name ?? 'No terminal selected'}
        </strong>
        <button
          disabled={!target}
          aria-pressed={Boolean(pinned)}
          onClick={() => setPinned(pinned ? null : target)}
        >
          {pinned ? 'Unpin' : 'Pin'}
        </button>
      </div>
      <p className="inspector-freshness">
        {pinned ? 'Pinned session' : 'Following focused terminal'} ·{' '}
        {!client
          ? 'Disconnected — data unavailable'
          : updated
            ? `Updated ${new Date(updated).toLocaleTimeString()}`
            : sessionId
              ? 'Loading…'
              : 'Select a terminal to inspect'}
      </p>
      <nav className="inspector-tabs" aria-label="Inspector views">
        {['Overview', 'JSON', 'Events'].map((name) => (
          <button
            key={name}
            aria-pressed={view === name}
            onClick={() => setView(name)}
          >
            {name}
          </button>
        ))}
      </nav>
      <div className="inspector-content">
        {error && <p role="alert">{error}</p>}
        {eventError && <p role="alert">{eventError}</p>}
        {notice && <p role="status">{notice}</p>}
        {sessionId && (
          <button
            disabled={!client}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh
          </button>
        )}
        {view === 'Overview' && summary && (
          <>
            <dl className="inspector-facts">
              {Object.entries({
                'Session ID': summary.id,
                Lifecycle: summary.lifecycle.state,
                'Exit code': summary.lifecycle.code,
                Health: summary.health?.status,
                Profile: summary.profile,
                Directory:
                  summary.profile_context?.current_directory ??
                  detail?.configuration?.working_directory,
                Restarts: summary.restart_count,
              }).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{display(value)}</dd>
                </div>
              ))}
            </dl>
            {Object.entries(summary.foreground ?? {}).map(
              ([axis, observation]) => (
                <section className="inspector-observation" key={axis}>
                  <h3>{axis}</h3>
                  <p>
                    {observation.state}
                    {observation.modality ? ` · ${observation.modality}` : ''}
                    {observation.semantic ? ` · ${observation.semantic}` : ''}
                  </p>
                  {observation.basis && (
                    <small>
                      {observation.basis.disposition} ·{' '}
                      {observation.basis.confidence_basis_points / 100}%
                      confidence ·{' '}
                      {observation.basis.source ?? 'Source unavailable'}
                      <br />
                      Observed:{' '}
                      {observation.basis.evidence_observed_at_millis != null
                        ? new Date(
                            observation.basis.evidence_observed_at_millis
                          ).toLocaleString()
                        : 'Unknown'}
                    </small>
                  )}
                </section>
              )
            )}
            <JsonSection title="Labels" value={summary.labels ?? detail?.configuration?.labels} />
            <JsonSection title="Metadata" value={detail?.configuration?.metadata} />
            <JsonSection title="Configuration" value={detail?.configuration && Object.fromEntries(
              Object.entries(detail.configuration).filter(([key]) => key !== 'metadata' && key !== 'labels'))} />
            <JsonSection
              title="Profile context"
              value={summary.profile_context}
            />
            <JsonSection title="Work context" value={detail?.work_context} />
            <JsonSection title="Process" value={detail?.process} />
            <JsonSection
              title="Foreground evidence"
              value={detail?.foreground_evidence}
            />
            <JsonSection title="Health checks" value={detail?.health_results} />
          </>
        )}
        {view === 'JSON' && detail && (
          <>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(json(detail))
                  setNotice('JSON copied.')
                } catch {
                  setNotice('Copy unavailable. Select and copy the JSON below.')
                }
              }}
            >
              Copy JSON
            </button>
            <pre className="inspector-json">{json(detail)}</pre>
          </>
        )}
        {view === 'Events' && (
          <>
            <p>Latest {events.length} retained events</p>
            {[...events].reverse().map((event) => (
              <details className="inspector-section" key={event.sequence}>
                <summary>
                  {event.kind}
                  <small>
                    {new Date(event.occurred_at_millis).toLocaleString()}
                  </small>
                </summary>
                <pre>{json(event)}</pre>
              </details>
            ))}
            {!events.length && <p>No events available.</p>}
          </>
        )}
      </div>
    </aside>
  )
}
