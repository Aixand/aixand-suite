import { useEffect, useRef, useState } from 'react'
import { Button, Dialog } from 'bbb-design'
import type { Catalog, Profile } from './client'
import { AgentError } from './client'
import type { AgentsModel } from './model'
import { requestId } from '../terminals/connection'

// Launches wait for explicit migration consent. No launch receipt exists yet,
// so cancelling keeps the caller's draft editable and cannot start a terminal.
export function useClaudeMigration(agents: AgentsModel) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const waiting = useRef<{ profile: Profile; key: string; resolve: (profile: Profile | null) => void } | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      waiting.current?.resolve(null)
      waiting.current = null
    }
  }, [])

  function finish(profile: Profile | null) {
    waiting.current?.resolve(profile)
    waiting.current = null
    if (mounted.current) { setOpen(false); setError('') }
  }

  async function refreshProfile(previous: Profile) {
    const catalog = await agents.request<Catalog>('catalog', {})
    const profile = catalog.profiles.find(row => row.id === previous.id)
    if (!profile) throw new Error('The selected profile no longer exists. Cancel and choose another profile.')
    void agents.refresh()
    return profile
  }

  async function prepare(profile: Profile): Promise<Profile | null> {
    if (profile.provider !== 'claude') return profile
    const inventory = await agents.request<{ migrationRequired: boolean }>('claude-accounts', {})
    if (!mounted.current) return null
    if (!inventory.migrationRequired) return profile.auth || profile.readiness?.terminal?.code === 'claude_migration_required' ?
      refreshProfile(profile) : profile
    return new Promise(resolve => {
      waiting.current = { profile, key: requestId(), resolve }
      setError(''); setOpen(true)
    })
  }

  async function migrate() {
    const attempt = waiting.current
    if (!attempt || busy) return
    setBusy(true); setError('')
    try {
      const result = await agents.request<{ migrated?: boolean; status?: string }>('claude-account-migrate', { key: attempt.key, confirmed: true })
      if (result.migrated !== true) {
        const inventory = await agents.request<{ migrationRequired: boolean }>('claude-accounts', {})
        if (inventory.migrationRequired) {
          // Migration itself is resumable and serialized by the registry lock.
          // A submitted management receipt cannot be replayed after a crash.
          attempt.key = requestId()
          throw new Error('Claude login migration has not completed. Try again to finish it, or cancel to keep your draft.')
        }
      }
      // Migration clears snapshot assignments and changes profile revisions.
      // Launch with the new identity checks, never the stale catalog values.
      const profile = await refreshProfile(attempt.profile)
      if (waiting.current === attempt) finish(profile)
    } catch (cause) {
      if (cause instanceof AgentError && !cause.uncertain && ['manager', 'validation', 'busy', 'invalid_request'].includes(cause.code ?? ''))
        attempt.key = requestId()
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not migrate Claude logins. Try again.')
    } finally { if (mounted.current) setBusy(false) }
  }

  const dialog = <Dialog title="Migrate Claude logins and open terminal" open={open}
    onOpenChange={value => { if (!value && !busy) finish(null) }}
    trigger={<Button style={{ display: 'none' }}>Review Claude login migration</Button>}>
    <p>Claude needs a one-time migration of all saved logins on this backend before this terminal can open. This preserves conversation history and removes the old saved token copies. You’ll sign in again through Claude in the terminal.</p>
    <p>Your message and terminal settings will be kept. Stop any active Claude sessions before continuing.</p>
    {error && <p role="alert" className="agents-error">{error}</p>}
    <div className="agents-actions">
      <Button variant="secondary" disabled={busy} onPress={() => finish(null)}>Cancel</Button>
      <Button loading={busy} disabled={busy || agents.status !== 'connected'} onPress={() => { void migrate() }}>Migrate and open terminal</Button>
    </div>
  </Dialog>
  return { prepare, dialog }
}
