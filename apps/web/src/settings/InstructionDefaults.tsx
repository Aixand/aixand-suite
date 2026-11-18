import { useEffect, useState } from 'react'
import { Button, Select, Textarea, TextField } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { Profile } from '../agents/client'
import { resourceKey, resourceLabel } from '../agents/ResourcePicker'
import type { ResourceCatalog, Target } from '../agents/ResourcePicker'
import { useContentFieldVariant } from '../branding/ContentTheme'
import { useResourceDraft } from '../resources/editor/drafts'

type Policy = { mode: 'inherit' | 'off' | 'append' | 'replace'; target?: Target; inputs?: Record<string, unknown> }
type Saved = { revision: number; policy: Policy }

export function InstructionDefaults({ agents, profile, onDraftChange, guard }: {
  agents: AgentsModel; profile?: Profile; onDraftChange?: (state: { dirty: boolean; busy: boolean }) => void; guard?: (action: () => void) => void
}) {
  const variant = useContentFieldVariant()
  const [saved, setSaved] = useState<Saved>()
  const [policy, setPolicy] = useState<Policy>({ mode: profile ? 'inherit' : 'off' })
  const [inputs, setInputs] = useState('{}')
  const [catalog, setCatalog] = useState<ResourceCatalog>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const scope = profile ? { scope: 'profile', provider: profile.provider, profile: profile.profile } : { scope: 'global' }
  const dirty = !!saved && (JSON.stringify(policy) !== JSON.stringify(saved.policy) || inputs !== JSON.stringify(saved.policy.inputs ?? {}, null, 2))
  const draft = useResourceDraft(!onDraftChange && dirty, !onDraftChange && busy)
  useEffect(() => {
    onDraftChange?.({ dirty, busy })
    return () => onDraftChange?.({ dirty: false, busy: false })
  }, [dirty, busy, onDraftChange])
  const connected = agents.status === 'connected'
  useEffect(() => {
    let active = true
    setSaved(undefined); setError(''); setNotice('')
    if (!connected) return
    void Promise.all([
      agents.request<Saved>('instruction-defaults-get', scope),
      agents.request<ResourceCatalog>('resource-catalog', { provider: profile?.provider ?? 'codex' }),
    ]).then(([value, resources]) => {
      if (!active) return
      if (!value || !Number.isInteger(value.revision) || !value.policy || !resources?.choices?.instructions) throw new Error('Instruction settings are unavailable. Update the Suite server or reconnect.')
      setSaved(value); setPolicy(value.policy); setInputs(JSON.stringify(value.policy.inputs ?? {}, null, 2)); setCatalog(resources)
    }).catch((cause: Error) => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [agents.request, connected, profile?.provider, profile?.profile, reload])
  const selected = policy.mode === 'append' || policy.mode === 'replace'
  const choices = [...(catalog?.choices.instructions ?? [])]
  if (policy.target && !choices.some(row => resourceKey(row.target) === resourceKey(policy.target!))) choices.unshift({ label: resourceLabel(policy.target), target: policy.target })
  async function save() {
    if (!saved || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const values: unknown = selected ? JSON.parse(inputs) : {}
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Prompt inputs must be a JSON object.')
      if (selected && !policy.target) throw new Error('Choose a saved prompt.')
      if (typeof policy.target === 'object' && policy.target.revision && !/^sha256:[a-f0-9]{64}$/.test(policy.target.revision)) throw new Error('A pinned revision must be a sha256 digest.')
      const next = selected ? { ...policy, inputs: values } : { mode: policy.mode }
      const result = await agents.request<Saved>('instruction-defaults-set', { ...scope, policy: next, expectedRevision: saved.revision })
      setSaved(result); setPolicy(result.policy); setInputs(JSON.stringify(result.policy.inputs ?? {}, null, 2)); setNotice('Instructions saved. Applies to new chats.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save instructions.') }
    finally { setBusy(false) }
  }
  return <section className="agent-settings-group" aria-label={profile ? 'Profile instructions' : 'Global instructions'}>
    <h3>{profile ? 'Profile instructions' : 'Global instructions'}</h3>
    <p>{profile ? 'Inherit global instructions, add profile instructions, or replace them for new chats.' : 'Default instructions for new Codex and OpenCode chats using this Suite. Existing chats keep their captured content.'}</p>
    <Select variant={variant} label="Instruction behavior" value={policy.mode} disabled={!saved || busy || !connected}
      options={[...(profile ? [{ id: 'inherit', label: 'Inherit global instructions' }, { id: 'append', label: 'Add to global instructions' }] : []),
        { id: 'replace', label: profile ? 'Replace global instructions' : 'Use a saved prompt' }, { id: 'off', label: 'Off' }]}
      onChange={mode => setPolicy(mode === 'append' || mode === 'replace' ? { ...policy, mode } : { mode: mode as Policy['mode'] })} />
    {selected && <>
      <Select variant={variant} label="Saved prompt" value={policy.target ? resourceKey(policy.target) : ''} disabled={busy || !connected}
        options={[{ id: '', label: 'Choose a prompt' }, ...choices.map(row => ({ id: resourceKey(row.target), label: row.label }))]}
        onChange={value => setPolicy({ ...policy, target: choices.find(row => resourceKey(row.target) === value)?.target })} />
      <Textarea variant={variant} label="Prompt inputs (JSON)" value={inputs} disabled={busy || !connected} onChange={event => setInputs(event.target.value)} />
      {typeof policy.target === 'object' && <TextField variant={variant} label="Pinned revision (optional)" value={policy.target.revision ?? ''} disabled={busy || !connected}
        onChange={event => {
          if (typeof policy.target !== 'object') return
          const { revision: _revision, ...target } = policy.target
          setPolicy({ ...policy, target: event.target.value ? { ...target, revision: event.target.value } : target })
        }} />}
      <p>Uses the accepted prompt version for each new chat. A pinned saved selection keeps its version. <a href="#/agents/prompts">Manage prompts</a></p>
    </>}
    <Button disabled={!saved || !dirty || busy || !connected} onPress={() => void save()} loading={busy}>Save instructions</Button>
    <Button variant="ghost" disabled={busy || !connected} onPress={() => (guard ?? draft.guard)(() => setReload(value => value + 1))}>Reload</Button>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {draft.confirmation}
  </section>
}
