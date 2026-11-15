import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AgentsModel } from './model'
import type { Profile } from './client'
import { providerLabel } from './presentation'
import type { Catalog, Consumer, Pack } from '../prompts/model'
import { ProfileResourceEditor } from './ResourcePicker'
import type { SkillCatalog } from '../skills/SkillsPage'
import type { SkillIdentity } from '../skills/Assignments'

type SkillBinding = { skills: SkillIdentity[]; revision: string | null }
export const profileHref = (profile: Pick<Profile, 'id'>) => `#/agents/profiles?profile=${encodeURIComponent(profile.id)}`
export function promptHref(reference: string, catalog: Catalog | null, context: Record<string, string> = {}) {
  for (const pack of catalog?.packs ?? []) {
    const prompt = pack.prompts.find(row => `${pack.reference}/${row.name}` === reference)
    if (pack.kind === 'release' && prompt) return `#/agents/prompts?${new URLSearchParams({ ...context, pack: pack.id, prompt: prompt.name })}`
  }
  return `#/agents/prompts?${new URLSearchParams({ ...context, q: reference.split('@')[0] })}`
}
function ResourceLink({ href, children }: { href: string; children: ReactNode }) { return <a href={href}>{children}</a> }

export function ProfileResources({ agents, profile }: { agents: AgentsModel; profile: Profile }) {
  return <ProfileResourceEditor agents={agents} profile={profile} />
}

export function PromptUsageLinks({ pack, prompt, consumers, profiles }: { pack: Pack; prompt?: string; consumers: Consumer[]; profiles: Profile[] }) {
  const references = new Set(pack.prompts.filter(row => !prompt || row.name === prompt).map(row => `${pack.reference}/${row.name}`))
  const usage = consumers.flatMap(consumer => consumer.profiles.filter(row => row.binding && references.has(row.binding.reference)).map(row => ({ consumer, row })))
  return <section className="agent-resource-links" aria-label="Prompt usage"><h3>Used by profiles</h3>
    {usage.map(({ consumer, row }) => {
      const profile = consumer.local && profiles.find(item => item.provider === consumer.provider && item.profile === row.profile)
      return <p key={`${consumer.id}/${row.profile}`}>{profile ? <ResourceLink href={profileHref(profile)}>{row.profile} · {providerLabel(profile.provider)}</ResourceLink> : `${row.profile} · ${consumer.label}`}</p>
    })}
    {!usage.length && <p className="prompts-note">{pack.kind === 'draft' ? 'Publish an immutable release to assign this prompt.' : consumers.some(row => row.status !== 'available') ? 'No assignments found in available consumers. Some consumers could not be checked.' : 'No profiles use this release.'}</p>}
    <ResourceLink href="#/agents/prompts?view=assignments">View assignments</ResourceLink>
  </section>
}

export function SkillUsageLinks({ agents, catalog, reference }: { agents: AgentsModel; catalog: SkillCatalog; reference: string }) {
  const [open, setOpen] = useState(false)
  const [usage, setUsage] = useState<Profile[]>([])
  const [loading, setLoading] = useState(false)
  const [failures, setFailures] = useState(0)
  const api = useRef(agents); api.current = agents
  useEffect(() => {
    if (!open || agents.status !== 'connected' || !agents.catalog) return
    let active = true
    setLoading(true); setUsage([]); setFailures(0)
    const profiles = [...agents.catalog.profiles]
    const matches: Profile[] = []
    let failed = 0
    // Check on demand with bounded concurrency, including the store in every comparison.
    const worker = async () => {
      while (active && profiles.length) {
        const profile = profiles.shift()!
        try {
          const result = await api.current.request<SkillBinding>('skills-profile-get', { provider: profile.provider, profile: profile.profile })
          if (!Array.isArray(result?.skills)) throw new Error('Assignments unavailable')
          if (result.skills.some(row => row.store === catalog.store && row.reference === reference)) matches.push(profile)
        } catch { failed++ }
      }
    }
    void Promise.all([worker(), worker(), worker()]).then(() => {
      if (active) { setUsage(matches.sort((a, b) => a.id.localeCompare(b.id))); setFailures(failed); setLoading(false) }
    })
    return () => { active = false }
  }, [open, agents.status, agents.catalog, catalog.store, reference])
  return <details className="agent-resource-links" onToggle={event => setOpen(event.currentTarget.open)}><summary>Used by profiles</summary>
    {loading ? <p role="status">Checking profile assignments…</p> : <>
      {usage.map(profile => <p key={profile.id}><ResourceLink href={profileHref(profile)}>{profile.profile} · {providerLabel(profile.provider)}</ResourceLink></p>)}
      {!usage.length && <p>{failures ? 'No assignments found in checked profiles.' : agents.status !== 'connected' ? 'Reconnect to check assignments.' : 'No profiles use this release.'}</p>}
      {!!failures && <p className="carrier-muted">{failures} profiles could not be checked.</p>}
    </>}
  </details>
}
