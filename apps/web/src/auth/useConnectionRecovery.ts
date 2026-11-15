import { useCallback, useEffect, useRef, useState } from 'react'

// Retry the transport only. Each service refreshes its saved state after ready;
// pending commands remain rejected and are never replayed by this hook.
export function useConnectionRecovery(connect: () => void, active = true, maxRetries = Infinity) {
  const latest = useRef(connect)
  latest.current = connect
  const enabled = useRef(false)
  const attempts = useRef(0)
  const limit = useRef(maxRetries); limit.current = maxRetries
  const [progress, setProgress] = useState({ attempt: 0, exhausted: false })
  const exhausted = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const stableTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const clear = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    clearTimeout(stableTimer.current)
    stableTimer.current = undefined
  }, [])
  const stop = useCallback(() => {
    enabled.current = false
    clear()
  }, [clear])
  const reconnect = useCallback(() => {
    enabled.current = true
    attempts.current = 0
    exhausted.current = false
    setProgress({ attempt: 0, exhausted: false })
    clear()
    latest.current()
  }, [clear])
  const ready = useCallback(() => {
    exhausted.current = false
    setProgress({ attempt: attempts.current, exhausted: false })
    clear()
    if (attempts.current === 0) return
    // A ready frame followed by an immediate close must still spend a retry.
    // Reset the budget only after the connection stays ready for ten seconds.
    stableTimer.current = setTimeout(() => {
      stableTimer.current = undefined
      if (!enabled.current) return
      attempts.current = 0
      setProgress({ attempt: 0, exhausted: false })
    }, 10_000)
  }, [clear])
  const failed = useCallback(() => {
    clearTimeout(stableTimer.current)
    stableTimer.current = undefined
    if (!enabled.current || timer.current !== undefined) return
    if (attempts.current >= limit.current) {
      exhausted.current = true
      setProgress({ attempt: attempts.current, exhausted: true })
      return
    }
    const delay = Math.min(1000 * 2 ** attempts.current, 30_000)
    attempts.current++
    setProgress({ attempt: attempts.current, exhausted: false })
    timer.current = setTimeout(() => {
      timer.current = undefined
      if (enabled.current) latest.current()
    }, delay)
  }, [])

  useEffect(() => {
    if (!active) return
    reconnect()
    const recover = () => {
      if (!enabled.current || timer.current === undefined && !exhausted.current) return
      clear()
      if (exhausted.current) {
        attempts.current = 0
        exhausted.current = false
        setProgress({ attempt: 0, exhausted: false })
      }
      latest.current()
    }
    const visible = () => {
      if (document.visibilityState === 'visible') recover()
    }
    window.addEventListener('online', recover)
    window.addEventListener('focus', recover)
    document.addEventListener('visibilitychange', visible)
    return () => {
      stop()
      window.removeEventListener('online', recover)
      window.removeEventListener('focus', recover)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [active, clear, reconnect, stop])

  return { reconnect, ready, failed, stop, ...progress }
}
