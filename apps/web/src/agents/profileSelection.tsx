import { Select, TextField } from 'bbb-design'
import { useEffect, useState } from 'react'

export type ProfileSelection = { mode: 'controller' | 'direct' } | { mode: 'auto'; eligibleProfiles?: string[] } | { mode: 'specific'; profile: string }
export type ProfileDecision = {
  profile: string; auth: string | null; reason: string;
  quota?: { weekly_left: number | null; short_left: number | null; remaining_percent?: number; checked_at: number; account_load: number } | null;
}

export function profileSelectionLabel(policy?: ProfileSelection) {
  return !policy || policy.mode === 'controller' ? 'Controller profile' : policy.mode === 'direct' ? 'Direct Codex' : policy.mode === 'auto' ? 'Auto' : 'profile' in policy ? policy.profile : 'Controller profile'
}

export function ProfilePicker({ label = 'Profile selection', value, onChange, inherit = false, disabled = false, allowAuto = true }: {
  label?: string; value?: ProfileSelection; onChange: (value?: ProfileSelection) => void; inherit?: boolean; disabled?: boolean; allowAuto?: boolean;
}) {
  const pool = value?.mode === 'auto' ? value.eligibleProfiles?.join(', ') ?? '' : ''
  const [poolText, setPoolText] = useState(pool)
  useEffect(() => setPoolText(pool), [pool])
  return <>
    <Select label={label} disabled={disabled} value={value?.mode ?? (inherit ? 'inherit' : 'controller')}
      options={[...(inherit ? [{ id: 'inherit', label: 'Inherit workflow' }] : []),
        { id: 'controller', label: 'Controller profile' }, ...(allowAuto ? [{ id: 'auto', label: 'Auto · highest remaining quota' }] : []), { id: 'specific', label: 'Specific profile' }]}
      onChange={(mode) => onChange(mode === 'inherit' ? undefined : mode === 'specific' ? { mode, profile: '' } : { mode: mode as 'auto' | 'controller' })} />
    {value?.mode === 'specific' && <TextField label="Profile name" value={value.profile} disabled={disabled}
      onChange={(event) => onChange({ mode: 'specific', profile: event.target.value })} />}
    {value?.mode === 'auto' && <>
      <TextField label="Eligible profiles" value={poolText} disabled={disabled}
        hint="Optional comma-separated pool. Empty uses all compatible local Codex profiles."
        onChange={(event) => { setPoolText(event.target.value); const profiles = event.target.value.split(',').map((item) => item.trim()).filter(Boolean); onChange({ mode: 'auto', ...(profiles.length ? { eligibleProfiles: [...new Set(profiles)] } : {}) }) }} />
      <p className="wb-muted">Selects when each stage is ready. Uses remaining weekly percentage, checks short-term limits, and preserves prompt, skill and MCP assignments.</p>
    </>}
  </>
}

export function ProfileResolution({ requested, decision }: { requested?: ProfileSelection; decision?: ProfileDecision | null }) {
  return <div className="wb-muted">
    <p>Requested: {profileSelectionLabel(requested)}{decision ? ` · Selected: ${decision.profile}${decision.auth ? ` (${decision.auth})` : ''}` : ''}</p>
    {decision && <p>{decision.reason}{decision.quota ? ` · ${decision.quota.remaining_percent != null ? `Allowance ${decision.quota.remaining_percent}%` : `Weekly ${decision.quota.weekly_left}%`}${decision.quota.short_left == null ? '' : ` · Short-term ${decision.quota.short_left}%`} · Quota checked ${new Date(decision.quota.checked_at * 1000).toLocaleString()}` : ''}</p>}
  </div>
}
