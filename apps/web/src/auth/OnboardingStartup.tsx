import { useEffect, useRef, useState } from 'react'
import { Button } from 'bbb-design'
import { useAuth } from './AuthGate'
import { authRequest } from './client'

export function OnboardingStartup({ connected, setupOpen, workspaceVersion }: { connected: boolean; setupOpen: boolean; workspaceVersion: string }) {
  const auth = useAuth()
  const latest = useRef(auth); latest.current = auth
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const checked = useRef('')
  useEffect(() => {
    if (!connected || setupOpen) return
    const key = `${auth.onboardingPending}:${workspaceVersion}:${attempt}`
    if (checked.current === key) return
    let cancelled = false
    void (async () => {
      if (latest.current.onboardingPending) await latest.current.reconcileOnboarding()
      else {
        const status = await authRequest<{ needed: boolean }>('onboarding/status')
        if (!cancelled && status.needed) await latest.current.startOnboarding()
      }
      if (!cancelled) { checked.current = key; setError('') }
    })().catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not check workspace setup.') })
    return () => { cancelled = true }
  }, [connected, setupOpen, auth.onboardingPending, workspaceVersion, attempt])
  return error ? <div className="app-notice" role="alert"><p>{error}</p>
    <Button variant="secondary" size="sm" onPress={() => setAttempt(value => value + 1)}>Retry setup check</Button></div> : null
}
