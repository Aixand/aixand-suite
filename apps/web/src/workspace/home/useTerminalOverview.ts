import { useEffect, useRef, useState } from 'react'
import { TerminalConnection } from '../../terminals/connection'
import type { Session, SessionPage } from '../../terminals/connection'
import { useConnectionRecovery } from '../../auth/useConnectionRecovery'

// Background monitoring reads summaries; starting or inspecting a terminal is explicit.
export function useTerminalOverview() {
  const [sessions, setSessions] = useState<Session[]>([])
  const [status, setStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const connection = useRef<TerminalConnection | null>(null)
  const task = useRef<Promise<void> | null>(null)
  const again = useRef(false)
  const alive = useRef(true)
  const recovery = useConnectionRecovery(connect)

  function refresh(): Promise<void> {
    again.current = true
    if (task.current) return task.current
    const current = connection.current
    if (!current) return Promise.resolve()
    const request = (async () => {
      do {
        again.current = false
        const rows: Session[] = []
        const cursors = new Set<string>()
        let cursor: string | null = null
        do {
          const page: SessionPage = await current.request<SessionPage>('list', { cursor })
          rows.push(...page.items)
          cursor = page.next_cursor
          if (cursor && (cursors.has(cursor) || cursors.size >= 256)) throw new Error('Terminal status could not finish loading.')
          if (cursor) cursors.add(cursor)
        } while (cursor)
        if (!alive.current || current !== connection.current) return
        setSessions([...new Map(rows.map(row => [row.id, row])).values()])
        setError('')
      } while (again.current && current === connection.current)
    })().catch((cause: Error) => {
      if (alive.current && current === connection.current) setError(cause.message)
    }).finally(() => {
      if (task.current === request) task.current = null
      if (alive.current && current === connection.current) setLoading(false)
    })
    task.current = request
    return request
  }
  function connect() {
    connection.current?.close()
    task.current = null
    setStatus('connecting')
    const next = new TerminalConnection(() => {
      if (!alive.current || connection.current !== next) return
      recovery.ready()
      setStatus('connected')
      void refresh()
      void next.request('watch').catch(() => { /* Polling also refreshes status. */ })
    }, event => {
      if (!alive.current || connection.current !== next) return
      if (event.kind === 'sessions' && ['metadata', 'metadata-gap'].includes(event.type)) {
        void refresh()
        if (event.type === 'metadata-gap') void next.request('watch').catch(() => {})
      }
      if (event.type === 'fatal') { setError(event.message ?? 'Terminal status is unavailable.'); setLoading(false) }
    }, message => {
      if (!alive.current || connection.current !== next) return
      connection.current = null
      setStatus('offline')
      setLoading(false)
      setError(message)
      recovery.failed()
    })
    connection.current = next
  }
  useEffect(() => {
    alive.current = true
    const check = () => { if (document.visibilityState === 'visible' && connection.current && status === 'connected') void refresh() }
    const timer = setInterval(check, 5000)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [status])
  useEffect(() => () => { alive.current = false; connection.current?.close(); connection.current = null }, [])
  async function create(name: string) {
    if (!connection.current || status !== 'connected') throw new Error('Reconnect to Terminals before starting a terminal.')
    const result = await connection.current.request<{ session: Session }>('create', { name, columns: 100, rows: 30 })
    if (!result.session?.id) throw new Error('The terminal could not be confirmed. Check Terminals before trying again.')
    return result.session
  }
  async function inspect(id: string) {
    if (!connection.current || status !== 'connected') throw new Error('Reconnect to Terminals to view its activity.')
    return connection.current.request<{ items: { sequence: string; kind: string; occurred_at_millis: number; [key: string]: unknown }[] }>('events', { sessionId: id })
  }
  return { sessions, status, loading, error, reconnect: recovery.reconnect, refresh, create, inspect }
}
