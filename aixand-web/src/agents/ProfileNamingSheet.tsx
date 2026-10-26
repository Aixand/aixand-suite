import { useContentFieldVariant } from '../branding/ContentTheme'
import { useEffect, useId, useRef, useState } from 'react'
import { Button, TextField } from 'bbb-design'
import { PaneForm } from './AgentWorkspace'
import { nameError } from './names'
import { AgentError, type Profile } from './client'
import type { AgentsModel } from './model'

export function ProfileNamingSheet({ agents: a, profile, mode, onClose, onSaved, inline }: {
  agents: AgentsModel; profile: Profile; mode: 'rename' | 'duplicate'; onClose: () => void; onSaved: (name: string) => void; inline?: boolean
}) {
  const fieldVariant = useContentFieldVariant()
  const [name, setName] = useState(mode === 'rename' ? profile.profile : `${profile.profile.slice(0, 123)}-copy`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)
  useEffect(() => {
    if (waiting && profile.profile_id && a.catalog?.profiles.some((row) => row.profile_id === profile.profile_id && row.profile === name.trim())) {
      onSaved(name.trim()); onClose()
    }
  }, [waiting, profile.profile_id, a.catalog, name, onSaved, onClose])
  const formId = useId()
  const pending = useRef(false)
  const rename = mode === 'rename'
  const blocked = rename && (profile.profile === 'default' || profile.active_runs > 0 && !profile.rename_can_drain)
  const validation = nameError(name, (a.catalog?.profiles ?? []).filter((item) => item.provider === profile.provider).map((item) => item.profile), rename ? profile.profile : undefined, true)
  async function submit() {
    if (pending.current || blocked || validation || a.status !== 'connected' || rename && name === profile.profile) return
    pending.current = true
    setBusy(true); setError('')
    try {
      await a.request(rename ? 'rename-profile' : 'duplicate-profile', { provider: profile.provider, profile: profile.profile, profileId: profile.profile_id, newName: name.trim() })
      await a.refresh(); onSaved(name.trim()); onClose()
    } catch (cause) {
      if (cause instanceof AgentError && cause.code === 'identity_change_pending') setWaiting(true)
      setError(cause instanceof Error ? cause.message : 'Profile operation failed.')
    }
    finally { pending.current = false; setBusy(false) }
  }
  return <PaneForm inline={inline} open trigger={<Button hidden>Open profile action</Button>} title={`${rename ? 'Rename' : 'Duplicate'} ${profile.profile}`} className="agents-sheet"
    onOpenChange={(next) => { if (!next && !busy) onClose() }} footer={<>
      <Button variant="ghost" disabled={busy} onPress={onClose}>{waiting ? 'Close' : 'Cancel'}</Button>
      <Button form={formId} type="submit" loading={busy} disabled={busy || blocked || waiting || !!validation || a.status !== 'connected'
        || rename && name.trim() === profile.profile}>{rename ? 'Save name' : 'Duplicate profile'}</Button>
    </>}>
    <form id={formId} className="agents-sheet-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {error && <p role="alert" className="agents-error">{error}</p>}
      <TextField variant={fieldVariant} label="Profile name" required autoFocus value={name} disabled={busy || blocked || waiting}
        pattern="[A-Za-z0-9][A-Za-z0-9_-]*" maxLength={128} onChange={(event) => { setName(event.target.value); setError('') }}
        hint={validation || 'Letters, numbers, hyphens and underscores. default is reserved.'} />
      <p className="ws-note">{rename ? 'Keep this profile’s settings and conversation history under a new name. A running server will wait for active work to finish before the rename.'
        : 'Copy its saved login assignment, model, instructions and tools. The new profile starts with empty conversation history.'}</p>
      {blocked && <p className="agents-error">{profile.profile === 'default' ? 'The native default profile cannot be renamed.' : 'Stop this profile’s agents in Terminals before renaming it.'}</p>}
    </form>
  </PaneForm>
}
