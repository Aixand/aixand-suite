import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Dialog } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { Profile } from '../agents/client'
import { providerLabel } from '../agents/presentation'
import { ProfileSelect } from '../agents/ProfileSelect'
import { resourceKey, validDefaults } from '../agents/ResourcePicker'
import type { Defaults, Target } from '../agents/ResourcePicker'
import { useContentFieldVariant } from '../branding/ContentTheme'
import '../resources/dialog.css'

function sameSkill(a: Target, b: Target) {
  if (resourceKey(a) === resourceKey(b)) return true
  if (typeof a === 'string' || typeof b === 'string' || a.store !== b.store || a.kind !== b.kind) return false
  return a.kind === 'managed' ? a.publisher_id === b.publisher_id && a.skill_id === b.skill_id
    : a.reference?.split('@')[0] === b.reference?.split('@')[0]
}

export function AssignSkillButton({ agents, target, label, disabled, onAssigned }: {
  agents: AgentsModel; target: Target; label: string; disabled?: boolean; onAssigned: () => void
}) {
  const variant = useContentFieldVariant()
  const [open, setOpen] = useState(false)
  const [profileId, setProfileId] = useState('')
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const profile = agents.catalog?.profiles.find(row => row.id === profileId)
  const online = agents.status === 'connected'
  const request = agents.request
  useEffect(() => {
    setDefaults(null); setError('')
    if (!open || !profile || !online) return
    let active = true
    void request<Defaults>('profile-resources-get', { provider: profile.provider, profile: profile.profile }).then(validDefaults)
      .then(value => { if (active) setDefaults(value) }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Profile defaults could not be loaded.') })
    return () => { active = false }
  }, [open, profile?.provider, profile?.profile, online, request])
  function close() { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()) }
  async function assign() {
    if (!profile || !defaults) return
    setBusy(true); setError('')
    const previous = defaults.skills.find(row => sameSkill(row.target, target))
    try {
      await request('profile-resources-set', { provider: profile.provider, profile: profile.profile, expectedRevision: defaults.revision,
        resources: { instructions: defaults.instructions, mcp: defaults.mcp,
          skills: [...defaults.skills.filter(row => !sameSkill(row.target, target)), { ...(previous ?? { required: false }), target }] } })
      onAssigned(); close()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Skill could not be assigned.') }
    finally { setBusy(false) }
  }
  return <Dialog title="Assign skill to profile" description={label} className="resource-compact-dialog" bodyClassName="resource-dialog-fields" open={open}
    onOpenChange={value => { if (!busy) { if (value) { setProfileId(''); setOpen(true) } else close() } }}
    trigger={<Button ref={trigger} size="sm" disabled={disabled || !online || !agents.catalog?.profiles.length}>Assign to profile</Button>}
    footer={<><Button variant="ghost" disabled={busy} onPress={close}>Cancel</Button><Button disabled={!profile || !defaults || !online || disabled} loading={busy} onPress={() => { void assign() }}>Assign skill</Button></>}>
    <ProfileSelect label="Profile" variant={variant} value={profileId} onChange={setProfileId} disabled={busy}
      options={[{ id: '', label: 'Choose a profile' }, ...(agents.catalog?.profiles.map(row => ({ id: row.id, label: `${row.profile} · ${providerLabel(row.provider)}` })) ?? [])]} />
    <p className="carrier-muted">Used for future sessions in this profile.</p>
    {profile && !defaults && !error && <p role="status">Loading profile defaults…</p>}
    {error && <Alert role="alert" tone="danger" title="Could not assign skill">{error}</Alert>}
  </Dialog>
}

export function SkillProfileUsage({ agents, target, refresh = 0 }: { agents: AgentsModel; target: Target; refresh?: number }) {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(false)
  const [failures, setFailures] = useState(0)
  const request = agents.request
  const identity = resourceKey(target)
  useEffect(() => {
    let active = true
    if (agents.status !== 'connected') return
    const queue = [...(agents.catalog?.profiles ?? [])]
    const matches: Profile[] = []
    let failed = 0
    setLoading(true); setProfiles([]); setFailures(0)
    async function worker() {
      while (active && queue.length) {
        const profile = queue.shift()!
        try {
          const value = validDefaults(await request<Defaults>('profile-resources-get', { provider: profile.provider, profile: profile.profile }))
          if (value.skills.some(row => resourceKey(row.target) === identity)) matches.push(profile)
        } catch { failed++ }
      }
    }
    void Promise.all([worker(), worker(), worker()]).then(() => { if (active) { setProfiles(matches); setFailures(failed); setLoading(false) } })
    return () => { active = false }
  }, [identity, refresh, agents.catalog?.profiles, agents.status, request])
  return <section className="agent-resource-links" aria-label="Skill usage"><h3>Used by profiles</h3>
    {loading ? <p className="carrier-muted" role="status">Checking assignments…</p> : <>
      <div className="agent-tool-assignments">{profiles.map(profile => <a key={profile.id} href={`#/agents/profiles?profile=${encodeURIComponent(profile.id)}`}>{profile.profile} · {providerLabel(profile.provider)}</a>)}</div>
      {!profiles.length && <p className="carrier-muted">{agents.status !== 'connected' ? 'Reconnect to check assignments.' : failures ? 'No assignments found in the profiles checked.' : 'No profiles use this version yet.'}</p>}
      {!!failures && <p className="carrier-muted">{failures} profiles could not be checked.</p>}
    </>}
  </section>
}
