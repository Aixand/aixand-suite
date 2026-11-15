import { useRef, useState } from 'react'
import { Button, Dialog } from 'bbb-design'
import type { Profile } from './client'
import type { AgentsModel } from './model'
import { profileDeletionReason, providerLabel } from './presentation'

export type ProfileDeletionSummary = { deleted: number; failed: number; cleanupPending: number }

export function DeleteProfilesDialog({ agents, profiles, disabled, onBusyChange, onDeleted, onComplete, onClose }: {
  agents: AgentsModel
  profiles: Profile[]
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onDeleted: (profile: Profile) => void
  onComplete: (summary: ProfileDeletionSummary) => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [deleted, setDeleted] = useState<string[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [progress, setProgress] = useState('')
  const pending = useRef(false)
  const cleanupPending = useRef(new Set<string>())
  const latest = useRef(agents)
  latest.current = agents
  const remaining = profiles.filter(profile => !deleted.includes(profile.id))
  const blocked = (profile: Profile) => profileDeletionReason(agents.catalog?.profiles.find(row => row.id === profile.id) ?? profile, agents.sessions)

  function close() {
    if (!pending.current) onClose()
  }

  async function remove() {
    if (pending.current || disabled || remaining.some(blocked)) return
    pending.current = true
    setBusy(true); onBusyChange(true); setError(''); setErrors({})
    const completed = new Set(deleted)
    const failures: Record<string, string> = {}
    try {
      for (const [index, profile] of remaining.entries()) {
        setProgress(`Deleting ${index + 1} of ${remaining.length}: ${providerLabel(profile.provider)} ${profile.profile}`)
        try {
          const current = latest.current
          if (current.status !== 'connected') throw new Error('Reconnect to Agent Manager before deleting this profile.')
          const retained = current.catalog?.profiles.find(row => row.id === profile.id)
          const reason = profileDeletionReason(retained ?? profile, current.sessions)
          if (reason) throw new Error(reason)
          if (!current.catalog || retained) {
            const result = await current.request<{ cleanupPending?: boolean }>('delete-profile', {
              provider: profile.provider, profile: profile.profile, confirmed: true,
            })
            if (result.cleanupPending) cleanupPending.current.add(profile.id)
          }
          completed.add(profile.id)
          setDeleted([...completed])
          onDeleted(profile)
        } catch (cause) {
          failures[profile.id] = cause instanceof Error ? cause.message : 'Could not delete this profile. Try again.'
          setErrors({ ...failures })
        }
      }
      await Promise.all([latest.current.refresh(), latest.current.refreshSessions()])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not refresh profiles. Refresh the list to check the result.')
    } finally {
      pending.current = false
      setBusy(false); onBusyChange(false); setProgress('')
    }
    onComplete({ deleted: completed.size, failed: profiles.length - completed.size, cleanupPending: cleanupPending.current.size })
    if (completed.size === profiles.length) onClose()
  }

  return <Dialog title={`Delete ${profiles.length} ${profiles.length === 1 ? 'profile' : 'profiles'}?`}
    role="alertdialog" className="agents-bulk-delete-dialog" open onOpenChange={open => { if (!open) close() }}
    trigger={<Button style={{ display: 'none' }}>Delete selected profiles</Button>}
    description="Delete the selected profiles’ local configuration and agent history. Saved logins and retained terminal output stay available."
    footer={<>
      <Button variant="secondary" autoFocus disabled={busy} onPress={close}>{deleted.length ? 'Close' : 'Cancel'}</Button>
      <Button variant="danger" loading={busy} disabled={disabled || busy || !remaining.length || remaining.some(blocked)} onPress={() => { void remove() }}>
        {Object.keys(errors).length ? 'Retry remaining' : `Delete ${profiles.length === 1 ? 'profile' : 'profiles'}`}
      </Button>
    </>}>
    {error && <p className="agents-error" role="alert">{error}</p>}
    {Object.keys(errors).length > 0 && <p className="agents-error" role="alert">{deleted.length} deleted · {Object.keys(errors).length} could not be deleted. Retry only attempts the remaining profiles.</p>}
    <ul className="agents-bulk-delete-list">
      {profiles.map(profile => <li key={profile.id}>
        <div><strong>{profile.profile}</strong><span>{providerLabel(profile.provider)}</span></div>
        {deleted.includes(profile.id) ? <p>Deleted</p> : errors[profile.id] || blocked(profile) ?
          <p className="agents-error">{errors[profile.id] || blocked(profile)}</p> : null}
      </li>)}
    </ul>
    {cleanupPending.current.size > 0 && <p className="ws-note">Some deleted profiles have local files awaiting cleanup.</p>}
    {progress && <p role="status" className="ws-note">{progress}</p>}
  </Dialog>
}
