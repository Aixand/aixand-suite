import { useEffect, useRef, useState } from 'react'
import type { CarrierModel } from '../../carrier/model'
import type { CarrierMessage, Snapshot } from '../../carrier/client'

export function usePendingMessages(carrier: CarrierModel) {
  const api = useRef(carrier)
  api.current = carrier
  const [messages, setMessages] = useState<CarrierMessage[]>([])
  const [status, setStatus] = useState<'checking' | 'ready' | 'unavailable'>('checking')
  const [more, setMore] = useState(false)
  const [attempt, retry] = useState(0)
  useEffect(() => {
    if (carrier.status !== 'connected' || !carrier.service?.connected) {
      setStatus(carrier.status === 'connecting' || carrier.status === 'connected' && !carrier.service && !carrier.error ? 'checking' : 'unavailable')
      return
    }
    let alive = true
    let busy = false
    async function refresh() {
      if (busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const page = await api.current.request<Snapshot>('snapshot', { mailbox: 'user', view: 'Pending', limit: 50, offset: 0 })
        if (alive) {
          setMessages(page.messages)
          setMore(page.next_offset !== null)
          setStatus(!page.status.connected ? 'unavailable' : page.status.syncing ? 'checking' : 'ready')
        }
      } catch { if (alive) setStatus('unavailable') }
      finally { busy = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 15000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [carrier.status, carrier.service?.connected, carrier.homeMessages, carrier.error, attempt])
  return { messages, status, more, retry: () => retry(value => value + 1) }
}
