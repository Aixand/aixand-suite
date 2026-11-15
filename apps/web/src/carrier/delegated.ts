import { useEffect, useRef, useState } from 'react'
import type { CarrierModel } from './model'
import type { DelegatedTaskDetail, DelegatedTaskPage } from './client'

// Separate requests and errors: delegated work never participates in inbox refresh.
export function useDelegatedWork(carrier: CarrierModel, visible: boolean) {
  const request = useRef(carrier.request)
  request.current = carrier.request
  const [page, setPage] = useState<DelegatedTaskPage>({ tasks: [], next_before: null })
  const [before, setBefore] = useState<number | undefined>()
  const [history, setHistory] = useState<(number | undefined)[]>([])
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<DelegatedTaskDetail | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [listRetry, setListRetry] = useState(0)
  const [detailRetry, setDetailRetry] = useState(0)

  useEffect(() => {
    if (!visible || carrier.status !== 'connected') { setListLoading(false); return }
    let alive = true, pending = false
    async function refresh() {
      if (pending || document.hidden) return
      pending = true; setListLoading(true)
      try {
        const value = await request.current<DelegatedTaskPage>('delegated_tasks', { limit: 25, ...(before === undefined ? {} : { before }) })
        if (!Array.isArray(value.tasks) || !(value.next_before === null || Number.isSafeInteger(value.next_before))) throw new Error('Invalid delegated work response.')
        if (alive) { setPage(value); setListError('') }
      } catch (error) {
        if (alive) setListError(error instanceof Error ? error.message : 'Delegated work could not be loaded.')
      } finally { pending = false; if (alive) setListLoading(false) }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [visible, carrier.status, before, listRetry])

  useEffect(() => {
    if (!visible || !selected || carrier.status !== 'connected') { setDetailLoading(false); return }
    let alive = true, pending = false
    async function refresh() {
      if (pending || document.hidden) return
      pending = true; setDetailLoading(true)
      try {
        const value = await request.current<DelegatedTaskDetail>('delegated_task', { taskId: selected })
        if (value.taskId !== selected) throw new Error('The selected task could not be loaded.')
        if (alive) { setDetail(value); setDetailError('') }
      } catch (error) {
        if (alive) setDetailError(error instanceof Error ? error.message : 'Task details could not be loaded.')
      } finally { pending = false; if (alive) setDetailLoading(false) }
    }
    setDetailError('')
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus) }
  }, [visible, carrier.status, selected, detailRetry])

  return {
    page, selected, select: setSelected, detail: detail?.taskId === selected ? detail : null,
    listLoading, detailLoading, listError, detailError,
    refresh: () => setListRetry(value => value + 1), retryDetail: () => setDetailRetry(value => value + 1),
    hasPrevious: history.length > 0,
    previous: () => { setBefore(history.at(-1)); setHistory(value => value.slice(0, -1)) },
    next: () => { if (page.next_before !== null) { setHistory(value => [...value, before]); setBefore(page.next_before) } },
  }
}
export type DelegatedWorkModel = ReturnType<typeof useDelegatedWork>
