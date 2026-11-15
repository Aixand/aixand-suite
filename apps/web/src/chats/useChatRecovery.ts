import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatSnapshot } from './model'

const delays = [1000, 2000, 4000]
type Progress = { id?: string; attempt: number; exhausted: boolean; error: string }

// Opening may restore the saved conversation on another runtime; input is never replayed.
export function useChatRecovery({ id, enabled, needed, open, recovered }: {
  id?: string; enabled: boolean; needed: boolean
  open: (id: string) => Promise<ChatSnapshot>; recovered: () => void
}) {
  const latest = useRef({ open, recovered }); latest.current = { open, recovered }
  const [generation, setGeneration] = useState(0)
  const [progress, setProgress] = useState<Progress>({ attempt: 0, exhausted: false, error: '' })
  const retry = useCallback(() => setGeneration(value => value + 1), [])
  useEffect(() => {
    setProgress({ id, attempt: 0, exhausted: false, error: '' })
    if (!id || !enabled || !needed) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    function schedule(index: number) {
      if (cancelled) return
      setProgress(previous => ({ ...previous, id, attempt: index + 1, exhausted: false }))
      timer = setTimeout(() => { void run(index) }, delays[index])
    }
    async function run(index: number) {
      try {
        const snapshot = await latest.current.open(id!)
        if (cancelled) return
        if (!snapshot.syncing && !snapshot.sessionRecovery && !['offline', 'uncertain'].includes(snapshot.status)) {
          latest.current.recovered()
          setProgress({ id, attempt: 0, exhausted: false, error: '' })
          return
        }
        throw new Error(snapshot.error || 'The conversation could not be reconnected.')
      } catch (error) {
        if (cancelled) return
        setProgress({ id, attempt: index + 1, exhausted: index === delays.length - 1,
          error: error instanceof Error ? error.message : 'The conversation could not be reconnected.' })
        if (index < delays.length - 1) schedule(index + 1)
      }
    }
    schedule(0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [id, enabled, needed, generation])
  return { ...(progress.id === id ? progress : { attempt: 0, exhausted: false, error: '' }), retry }
}
