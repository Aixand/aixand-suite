import { useEffect, useRef, useState } from 'react'
import { CarrierConnection } from './client'
import { useConnectionRecovery } from '../auth/useConnectionRecovery'
import type {
  AgentProfile,
  CarrierMessage,
  CarrierRun,
  CarrierStatus,
  Mailbox,
  OutboxItem,
  Recipient,
  Snapshot,
} from './client'

export function useCarrier() {
  const [status, setStatus] = useState<'offline' | 'connecting' | 'connected'>(
    'connecting',
  )
  const [service, setService] = useState<CarrierStatus | null>(null)
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [mailbox, setMailbox] = useState('user')
  const [view, setView] = useState('Inbox')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [messages, setMessages] = useState<CarrierMessage[]>([])
  const [homeMessages, setHomeMessages] = useState<CarrierMessage[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [recipientCursor, setRecipientCursor] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [runs, setRuns] = useState<CarrierRun[]>([])
  const deletedRuns = useRef(new Set<string>())
  const [outbox, setOutbox] = useState<OutboxItem[]>([])
  const [error, setError] = useState('')
  const [retryRequired, setRetryRequired] = useState(false)
  const [loading, setLoading] = useState(false)
  const connection = useRef<CarrierConnection | null>(null)
  const readyConnection = useRef<CarrierConnection | null>(null)
  const recovery = useConnectionRecovery(connect)
  const refreshTask = useRef<Promise<void> | null>(null)
  const refreshAgain = useRef(false)
  const query = useRef({ mailbox, view, search, offset })
  query.current = { mailbox, view, search, offset }
  const changedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )

  async function request<T>(op: string, args: object = {}): Promise<T> {
    if (!connection.current) throw new Error('Connect to Carrier first.')
    return connection.current.request<T>(op, args)
  }
  function refresh(current = connection.current): Promise<void> {
    if (!current) return Promise.resolve()
    refreshAgain.current = true
    if (refreshTask.current) return refreshTask.current
    setLoading(true)
    const task = (async () => {
      do {
        refreshAgain.current = false
        const selected = { ...query.current }
        const [snapshot, home, sends, activeRuns] = await Promise.all([
          current.request<Snapshot>('snapshot', { ...selected, limit: 50 }),
          current.request<Snapshot>('snapshot', {
            mailbox: 'user',
            view: 'Unread',
            limit: 10,
          }),
          current.request<OutboxItem[]>('outbox', {
            mailbox: selected.mailbox,
            limit: 50,
          }),
          current.request<CarrierRun[]>('runs'),
        ])
        if (connection.current !== current) return
        if (JSON.stringify(query.current) !== JSON.stringify(selected)) {
          refreshAgain.current = true
          continue
        }
        setMessages(snapshot.messages)
        setTotal(snapshot.total)
        setNextOffset(snapshot.next_offset)
        setCounts(snapshot.counts)
        setService(snapshot.status)
        setHomeMessages(home.messages)
        setUnreadCount(home.counts.Unread ?? 0)
        setOutbox(sends)
        setRuns(activeRuns.filter((run) => !deletedRuns.current.has(run.key)))
      } while (refreshAgain.current && connection.current === current)
    })()
      .catch((cause: Error) => {
        if (connection.current === current) setError(cause.message)
      })
      .finally(() => {
        if (refreshTask.current === task) {
          refreshTask.current = null
          setLoading(false)
        }
      })
    refreshTask.current = task
    return task
  }
  async function directory(after = '') {
    const result = await request<{
      sessions: Recipient[]
      next_after: string | null
    }>('directory', { mailbox: query.current.mailbox, after, limit: 100 })
    setRecipients((old) =>
      after
        ? [
            ...old,
            ...result.sessions.filter(
              (item) => !old.some((value) => value.address === item.address),
            ),
          ]
        : result.sessions,
    )
    setRecipientCursor(result.next_after)
  }
  async function removeRun(key: string) {
    await request('delete_run', { key })
    deletedRuns.current.add(key)
    setRuns((previous) => previous.filter((run) => run.key !== key))
  }
  function closeConnection() {
    const current = connection.current
    connection.current = null
    readyConnection.current = null
    current?.close()
    clearTimeout(changedTimer.current)
    refreshTask.current = null
    refreshAgain.current = false
    setLoading(false)
  }
  function disconnect() {
    recovery.stop()
    closeConnection()
    setError('')
    setStatus('offline')
  }
  function connect() {
    closeConnection()
    setRetryRequired(false)
    setStatus('connecting')
    const current = new CarrierConnection(
      () => {
        if (connection.current !== current) return
        recovery.ready()
        readyConnection.current = current
        setStatus('connected')
        setError('')
        void refresh(current)
        void current
          .request<Mailbox[]>('mailboxes')
          .then(setMailboxes)
          .catch((cause: Error) => setError(cause.message))
        void directory().catch((cause: Error) => setError(cause.message))
        void current
          .request<AgentProfile[]>('agent_profiles')
          .then(setProfiles)
          .catch((cause: Error) => setError(cause.message))
      },
      () => {
        if (connection.current !== current) return
        clearTimeout(changedTimer.current)
        changedTimer.current = setTimeout(() => {
          void refresh(current)
        }, 50)
      },
      (cause, retryable) => {
        if (connection.current !== current) return
        connection.current = null
        readyConnection.current = null
        setStatus('offline')
        setError(cause.message)
        setRetryRequired(!retryable)
        if (retryable) recovery.failed()
        else recovery.stop()
      },
    )
    connection.current = current
  }
  async function setMessageState(
    id: string,
    patch: { read?: boolean; archived?: boolean },
    selectedMailbox = query.current.mailbox,
  ) {
    await request('set_message_state', {
      mailbox: selectedMailbox,
      id: Number(id),
      ...patch,
    })
    await refresh()
  }
  useEffect(() => {
    setOffset(0)
  }, [mailbox, view, search])
  useEffect(() => {
    if (connection.current && connection.current === readyConnection.current) void refresh()
  }, [mailbox, view, search, offset])
  useEffect(() => {
    const focus = () => {
      if (connection.current && connection.current === readyConnection.current) void refresh()
    }
    window.addEventListener('focus', focus)
    return () => {
      window.removeEventListener('focus', focus)
      clearTimeout(changedTimer.current)
      const current = connection.current
      connection.current = null
      current?.close()
    }
  }, [])
  return {
    status,
    service,
    mailboxes,
    mailbox,
    setMailbox,
    view,
    setView,
    search,
    setSearch,
    offset,
    setOffset,
    messages,
    homeMessages,
    unreadCount,
    counts,
    total,
    nextOffset,
    recipients,
    recipientCursor,
    profiles,
    runs,
    outbox,
    error,
    retryRequired,
    setError,
    loading,
    connect: recovery.reconnect,
    disconnect,
    refresh,
    removeRun,
    directory,
    request,
    setMessageState,
  }
}
export type CarrierModel = ReturnType<typeof useCarrier>
