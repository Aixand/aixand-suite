import { useEffect, useRef, useState } from 'react'
import { AgentsConnection } from './client'
import { useConnectionRecovery } from '../auth/useConnectionRecovery'
import type { AgentJob, Budget, Catalog, Provider, Sessions } from './client'
import { reportRecovery } from '../recovery/events'

export function useAgents() {
  const [status, setStatus] = useState<'offline' | 'connecting' | 'connected'>(
    'connecting',
  )
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [sessions, setSessions] = useState<Sessions | null>(null)
  const [operations, setOperations] = useState<AgentJob[]>([])
  const [operationsError, setOperationsError] = useState('')
  const operationTask = useRef<Promise<void> | null>(null)
  const [budgets, setBudgets] = useState<Record<string, Budget[]>>({})
  const [budgetLoading, setBudgetLoading] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState<number | null>(null)
  const connection = useRef<AgentsConnection | null>(null)
  const readyConnection = useRef<AgentsConnection | null>(null)
  const connectionWaiters = useRef(new Set<{ resolve: () => void; reject: (error: Error) => void }>())
  const recovery = useConnectionRecovery(connect, true, 3)
  const listeners = useRef(new Set<(message: unknown) => void>())
  function subscribe(listener: (message: unknown) => void) {
    listeners.current.add(listener)
    return () => { listeners.current.delete(listener) }
  }
  const catalogTask = useRef<Promise<void> | null>(null)
  const catalogDirty = useRef(false)
  const sessionTask = useRef<Promise<void> | null>(null)
  const budgetTasks = useRef(new Map<string, Promise<void>>())
  const budgetQueues = useRef([Promise.resolve(), Promise.resolve()])
  const budgetQueueIndex = useRef(0)

  function refreshOperations(current = connection.current): Promise<void> {
    if (!current) return Promise.resolve()
    if (operationTask.current) return operationTask.current
    const task = current.request<{ operations: AgentJob[] }>('agent-operations')
      .then((value) => {
        if (connection.current === current) {
          setOperations(value.operations ?? [])
          setOperationsError('')
        }
      }).catch((cause: unknown) => {
        if (connection.current === current)
          setOperationsError(cause instanceof Error ? cause.message : 'Operation refresh failed.')
      }).finally(() => { if (operationTask.current === task) operationTask.current = null })
    operationTask.current = task
    return task
  }

  function refresh(current = connection.current): Promise<void> {
    if (!current || connection.current !== current) return Promise.resolve()
    if (catalogTask.current) {
      catalogDirty.current = true
      return catalogTask.current
    }
    setLoading(true)
    const task = (async () => {
      do {
        catalogDirty.current = false
        try {
          const value = await current.request<Catalog>('catalog')
          if (connection.current === current) {
            setCatalog(value)
            setUpdated(Date.now())
            setError('')
          }
        } catch (cause: unknown) {
          if (connection.current === current)
            setError(cause instanceof Error ? cause.message : 'Profile refresh failed.')
        }
        // An account may have changed after this request took its snapshot.
        // Coalesce notifications into one more read instead of losing them.
      } while (catalogDirty.current && connection.current === current)
    })()
      .finally(() => {
        if (catalogTask.current === task) {
          catalogTask.current = null
          setLoading(false)
        }
      })
    catalogTask.current = task
    return task
  }
  function refreshSessions(): Promise<void> {
    const current = connection.current
    if (!current) return Promise.resolve()
    if (sessionTask.current) return sessionTask.current
    setSessionsLoading(true)
    const task = current
      .request<Sessions>('sessions')
      .then((value) => {
        if (connection.current === current) setSessions(value)
      })
      .catch((cause: unknown) => {
        if (connection.current === current)
          setError(
            cause instanceof Error ? cause.message : 'Session refresh failed.',
          )
      })
      .finally(() => {
        if (sessionTask.current === task) {
          sessionTask.current = null
          setSessionsLoading(false)
        }
      })
    sessionTask.current = task
    return task
  }
  function refreshBudget(provider: Provider, auth: string): Promise<void> {
    const current = connection.current
    const key = provider + '/' + auth
    if (!current) return Promise.resolve()
    const existing = budgetTasks.current.get(key)
    if (existing) return existing
    setBudgetLoading((keys) => [...keys, key])
    const slot = budgetQueueIndex.current++ % budgetQueues.current.length
    const task = budgetQueues.current[slot]
      .then(() => {
        if (connection.current !== current) return
        return current.request<{ supported: boolean; rows: Budget[] }>(
          'budgets',
          { provider, auth },
        )
      })
      .then((value) => {
        if (value && connection.current === current)
          setBudgets((values) => ({ ...values, [key]: value.rows }))
      })
      .catch((cause: unknown) => {
        if (connection.current === current)
          setBudgets((values) => ({
            ...values,
            [key]: [
              {
                profile: auth,
                error:
                  cause instanceof Error
                    ? cause.message
                    : 'Allowance unavailable.',
              },
            ],
          }))
      })
      .finally(() => {
        if (budgetTasks.current.get(key) === task) {
          budgetTasks.current.delete(key)
          setBudgetLoading((keys) => keys.filter((item) => item !== key))
        }
      })
    budgetTasks.current.set(key, task)
    budgetQueues.current[slot] = task
    return task
  }
  function closeConnection() {
    const current = connection.current
    connection.current = null
    readyConnection.current = null
    current?.close()
    catalogTask.current = null
    catalogDirty.current = false
    sessionTask.current = null
    operationTask.current = null
    budgetTasks.current.clear()
    budgetQueues.current = [Promise.resolve(), Promise.resolve()]
    setBudgetLoading([])
    setLoading(false)
    setSessionsLoading(false)
  }
  function disconnect() {
    recovery.stop()
    closeConnection()
    setError('')
    setStatus('offline')
    for (const waiter of connectionWaiters.current) waiter.reject(new Error('Agent Manager disconnected. Your message was not sent.'))
  }
  function connect() {
    closeConnection()
    setStatus('connecting')
    const current = new AgentsConnection(
      () => {
        if (connection.current !== current) return
        recovery.ready()
        readyConnection.current = current
        setStatus('connected')
        setError('')
        for (const waiter of connectionWaiters.current) waiter.resolve()
        void refresh(current)
        void refreshOperations(current)
      },
      (message) => {
        if (connection.current !== current) return
        connection.current = null
        readyConnection.current = null
        setStatus('offline')
        setError(message)
        reportRecovery({ kind: 'failure' })
        recovery.failed()
      },
      (message) => {
        if (connection.current !== current) return
        const health = message as { type?: string; chatId?: string; event?: { kind?: string; status?: string } }
        if (health.type === 'chat-event' && !health.chatId && health.event?.kind === 'connection' && health.event.status === 'offline') reportRecovery({ kind: 'failure' })
        if (['mcps-changed', 'profiles-changed', 'resources-changed'].includes((message as { type?: string }).type ?? '')) void refresh(current)
        if ((message as { type?: string }).type === 'profiles-changed') void refreshOperations(current)
        const event = message as { type?: string; operation?: AgentJob }
        if (event.type === 'agent-operation-updated' && event.operation) {
          const operation = event.operation
          setOperations((rows) => [operation, ...rows.filter((row) => row.id !== operation.id)]
            .sort((left, right) => right.createdAt - left.createdAt))
          if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) void refresh(current)
        }
        for (const listener of listeners.current) listener(message)
      },
    )
    connection.current = current
  }
  async function request<T>(op: string, args: object = {}): Promise<T> {
    if (!connection.current) throw new Error('Connect to Agent Manager first.')
    return connection.current.request<T>(op, args)
  }
  function ensureConnected(): Promise<void> {
    if (connection.current && connection.current === readyConnection.current) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        connectionWaiters.current.delete(waiter)
        if (error) reject(error)
        else resolve()
      }
      const waiter = { resolve: () => finish(), reject: (error: Error) => finish(error) }
      const timer = setTimeout(() => finish(new Error('Could not reconnect to Agent Manager. Your message was not sent.')), 30_000)
      connectionWaiters.current.add(waiter)
      if (!connection.current) recovery.reconnect()
    })
  }
  useEffect(() => {
    const focus = () => {
      if (connection.current && connection.current === readyConnection.current) {
        void refresh()
        void refreshOperations()
      }
    }
    window.addEventListener('focus', focus)
    return () => {
      window.removeEventListener('focus', focus)
      const current = connection.current
      connection.current = null
      current?.close()
      for (const waiter of connectionWaiters.current) waiter.reject(new Error('Agent Manager disconnected. Your message was not sent.'))
    }
  }, [])
  useEffect(() => {
    if (status !== 'connected' || !operations.some((row) => ['queued', 'starting', 'running', 'uncertain'].includes(row.status))) return
    const interval = setInterval(() => void refreshOperations(), 3000)
    return () => clearInterval(interval)
  }, [status, operations])
  return {
    status,
    catalog,
    sessions,
    operations,
    operationsError,
    refreshOperations,
    budgets,
    budgetLoading,
    loading,
    sessionsLoading,
    error,
    updated,
    connect: recovery.reconnect, ensureConnected,
    connectionRecovery: { attempt: recovery.attempt, exhausted: recovery.exhausted },
    disconnect,
    refresh,
    refreshSessions,
    refreshBudget,
    request,
    subscribe,
  }
}
export type AgentsModel = ReturnType<typeof useAgents>
