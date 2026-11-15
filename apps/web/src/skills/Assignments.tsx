import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { SkillCatalog } from './SkillsPage'
export type SkillIdentity = { store: string; reference: string }
type Binding = { skills: SkillIdentity[]; revision: string | null }
export function SkillAssignments({ agents, provider, profile, disabled }: { agents: AgentsModel; provider: string; profile: string; disabled: boolean }) {
  const api = useRef(agents); api.current = agents
  const [binding, setBinding] = useState<Binding | null>(null)
  const [selected, setSelected] = useState<SkillIdentity[]>([])
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true; setBinding(null); setError('')
    void Promise.all([api.current.request<Binding>('skills-profile-get', { provider, profile }), api.current.request<SkillCatalog>('skills-catalog')]).then(([value, library]) => {
      if (!Array.isArray(value.skills) || !Array.isArray(library.releases)) throw new Error('Skill assignments are unavailable; check the manager installation.')
      if (active) { setBinding(value); setSelected(value.skills); setCatalog(library) }
    }).catch((e: Error) => { if (active) setError(e.message) })
    return () => { active = false }
  }, [provider, profile])
  const values = [...(catalog?.releases.filter(row => row.reference && !row.error).map(row => ({ store: catalog.store, reference: row.reference })) ?? []),
    ...selected.filter(row => row.store !== catalog?.store || !catalog?.releases.some(release => release.reference === row.reference))]
  return <section aria-label="Profile skills"><h3>Skills</h3><p>Assignments use immutable source/release identities. Existing sessions keep their captured packages.</p>
    {values.map(row => <Checkbox key={`${row.store}:${row.reference}`} label={`${row.reference} · ${row.store}`}
      disabled={disabled || busy || !binding} isSelected={selected.some(value => value.store === row.store && value.reference === row.reference)}
      onChange={enabled => setSelected(current => enabled ? [...current, row] : current.filter(value => value.store !== row.store || value.reference !== row.reference))} />)}
    {!values.length && <p>Publish a release in <a href="#/agents/skills">Skills</a> to assign it.</p>}
    <Button variant="secondary" disabled={disabled || busy || !binding} onPress={() => {
      setBusy(true); setError(''); setNotice('')
      void agents.request<Binding>('skills-profile-set', { provider, profile, skills: selected, expectedRevision: binding!.revision }).then(value => {
        setBinding(value); setNotice('Skill assignments saved for future sessions.')
      }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
    }}>Save skill assignments</Button>
    {error && <p role="alert">{error}</p>}<p role="status">{notice}</p>
  </section>
}
