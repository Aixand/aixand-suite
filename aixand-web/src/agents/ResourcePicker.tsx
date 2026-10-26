import { useContentFieldVariant } from '../branding/ContentTheme'
import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Select, Textarea } from 'bbb-design'
import './resource-picker.css'
import type { AgentsModel } from './model'
import type { Provider } from './client'

export type Target = string | { kind: 'managed' | 'release'; store?: string; reference?: string; publisher_id?: string; package_id?: string; skill_id?: string; server_id?: string; prompt?: string; revision?: string }
export type Item = { target: Target; required?: boolean; inputs?: Record<string, unknown> }
type Policy = { inherit?: boolean; add?: Item[]; exclude?: Target[] }
export type ResourceRequest = { schema?: 'agent-manager/resource-request-1' | 'agent-manager/resource-request-2'; inherit_profile?: boolean; instructions?: { mode?: 'inherit' | 'off' | 'replace'; target?: Target; required?: boolean; inputs?: Record<string, unknown> }; skills?: Policy; mcp?: Policy }
export type ResourceReport = { items: { id: string; kind: string; target: Target; origin: string; application?: { id: string; revision: string }; delivery?: 'native' | 'stdio'; required: boolean; status: string; verification: string; revision?: string; content_digest?: string; reconciliation_required?: boolean; sync_error?: { message: string } | null; connection_status?: string; reason?: { code: string; message: string } | null }[] }
export type Defaults = { revision: string; instructions: Item | null; skills: Item[]; mcp: Item[] }
export function validDefaults(value: Defaults) {
  if (!value || typeof value.revision !== 'string' || !Array.isArray(value.skills) || !Array.isArray(value.mcp)) throw new Error('Profile resource defaults are unavailable. Refresh or update Agent Manager.')
  return value
}
export type Choice = { label: string; target: Target; description?: string; reconciliation_required?: boolean; installation?: { status: string; installation_required: boolean } | null }
type Integration = { manager: string; available: boolean; status: string; reason?: { message: string } | null }
export type ResourceCatalog = { choices: Record<'instructions' | 'skills' | 'mcp', Choice[]>; integrations?: Record<string, Integration> }
export const resourceKey = (target: Target) => typeof target === 'string' ? target : JSON.stringify(Object.fromEntries(Object.entries(target).sort(([a], [b]) => a.localeCompare(b))))
const key = resourceKey
export const resourceLabel = (target: Target) => typeof target === 'string' ? target : target.reference ?? [target.publisher_id, target.package_id ?? target.skill_id ?? target.server_id, target.prompt].filter(Boolean).join('/')
export function resourceRequestVersion(value: ResourceRequest): ResourceRequest {
  return value.mcp?.add?.some(row => typeof row.target !== 'string') || value.mcp?.exclude?.some(row => typeof row !== 'string')
    ? { ...value, schema: 'agent-manager/resource-request-2' } : value
}
export function launchResourceArgs(value: ResourceRequest, mcp?: { inherit?: boolean; add?: string[]; exclude?: string[] }) {
  value = resourceRequestVersion(value)
  return { resources: mcp ? { ...value, mcp: { ...mcp, add: mcp.add?.map(target => ({ target })) } } : value }
}
function reviewLink(kind: string, target: Target) {
  if (kind === 'mcp' && typeof target !== 'string') return `#/agents/tools?publisher=${encodeURIComponent(target.publisher_id ?? '')}&resource=${encodeURIComponent(target.server_id ?? '')}`
  return kind === 'skills' ? '#/agents/skills' : kind === 'mcp' ? '#/agents/tools' : '#/agents/prompts'
}
export function ResourceReportView({ report }: { report?: ResourceReport | null }) {
  if (!report) return null
  return <section className="resource-report" aria-label="Resource delivery"><h4>Resources</h4>{report.items.length === 0 && <p>No manager resources selected.</p>}
    {report.items.map(row => <div key={row.id} className="resource-report-item"><strong>{resourceLabel(row.target)}</strong> · {({ ready: 'Available', applied: 'Applied', skipped: 'Skipped' } as Record<string, string>)[row.status] ?? row.status}{row.required ? ' · required' : ' · optional'}
      <small> · {row.application ? 'Included by Suite' : row.origin === 'profile' ? 'From profile' : 'For this launch'} · {row.verification === 'pending' ? 'Support checked at connection' : 'Delivery checked'}</small>
      {row.reason && <p>{row.reason.message}</p>}
      {row.kind === 'mcp' && row.status === 'applied' && <small>{row.delivery === 'native' ? 'Native tools delivered.' : 'Configuration delivered. Check live MCP status for connections.'}</small>}
      {row.sync_error && <p role="status">Publisher update check failed: {row.sync_error.message}. Using the accepted configuration.</p>}
      {row.revision && <details><summary>Captured version</summary><code>{row.revision}</code><p>{row.content_digest}</p></details>}
      {row.reconciliation_required && <p role="status">Publisher update awaiting reconciliation. Using the accepted copy. <a href={reviewLink(row.kind, row.target)}>Review update</a></p>}
    </div>)}
  </section>
}

export function ResourcePicker({ agents, provider, profile, cwd, backend, mode = 'backend', value, onChange, disabled = false, editingDefaults = false, onValidationChange, applicationPreset }: {
  agents: AgentsModel; provider: Provider; profile: string; cwd?: string; backend?: string; mode?: 'backend' | 'terminal'; value: ResourceRequest; onChange: (value: ResourceRequest) => void; disabled?: boolean; editingDefaults?: boolean; onValidationChange?: (valid: boolean) => void; applicationPreset?: 'controller' | 'basic'
}) {
  const fieldVariant = useContentFieldVariant()
  const api = useRef(agents); api.current = agents
  const [choices, setChoices] = useState<Record<'instructions' | 'skills' | 'mcp', Choice[]>>({ instructions: [], skills: [], mcp: [] })
  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [integrations, setIntegrations] = useState<Record<string, Integration>>({})
  const [report, setReport] = useState<ResourceReport | null>(null)
  const [error, setError] = useState('')
  const [inputsError, setInputsError] = useState('')
  const serialized = JSON.stringify(value)
  useEffect(() => {
    let active = true
    setError(''); setInputsError(''); setDefaults(null); setChoices({ instructions: [], skills: [], mcp: [] }); setIntegrations({}); onValidationChange?.(true)
    void Promise.all([api.current.request<ResourceCatalog>('resource-catalog', { provider }), api.current.request<Defaults>('profile-resources-get', { provider, profile })]).then(([catalog, bindings]) => {
      validDefaults(bindings)
      if (!catalog.choices || !['instructions', 'skills', 'mcp'].every(kind => Array.isArray(catalog.choices[kind as keyof typeof choices]))) throw new Error('Resource catalog is unavailable.')
      if (active) { setChoices(catalog.choices); setIntegrations(catalog.integrations ?? {}); setDefaults(bindings) }
    }).catch((e: Error) => { if (active) setError(e.message) })
    return () => { active = false }
  }, [provider, profile])
  useEffect(() => {
    let active = true
    const refresh = () => {
      void api.current.request<ResourceCatalog>('resource-catalog', { provider }).then(catalog => {
        if (active && catalog.choices) { setChoices(catalog.choices); setIntegrations(catalog.integrations ?? {}) }
      }).catch(() => undefined)
    }
    const unsubscribe = agents.subscribe(event => { if (['resources-changed', 'mcps-changed', 'skills-changed', 'prompts-changed'].includes((event as { type: string }).type)) refresh() })
    window.addEventListener('focus', refresh)
    return () => { active = false; unsubscribe(); window.removeEventListener('focus', refresh) }
  }, [provider, agents.subscribe])
  useEffect(() => {
    let active = true
    setReport(null)
    const timer = setTimeout(() => {
      void api.current.request<{ report: ResourceReport }>('launch-preview', { provider, profile, resources: resourceRequestVersion(JSON.parse(serialized)), ...(cwd ? { cwd } : {}), ...(backend ? { backend } : {}), ...(applicationPreset ? { applicationPreset } : {}), mode }).then(preview => {
        if (active) { setReport(preview.report); setError('') }
      }).catch((e: Error) => { if (active) setError(e.message) })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [provider, profile, serialized, cwd, backend, mode, applicationPreset])
  const instruction = value.instructions
  const instructionKey = instruction?.mode === 'replace' && instruction.target ? key(instruction.target) : instruction?.mode ?? 'inherit'
  const instructionChoices = [...choices.instructions]
  if (instruction?.target && !instructionChoices.some(row => key(row.target) === key(instruction.target!))) instructionChoices.unshift({ label: resourceLabel(instruction.target), target: instruction.target })
  return <div className="agents-sheet-form resource-picker" aria-label="Launch resources">
    <p>Profile defaults apply to new sessions. Optional resources can be skipped when unavailable; required resources must be usable before the task starts.</p>
    {Object.entries(integrations).filter(([, row]) => !row.available).map(([kind, row]) => <p key={kind} role="status">{row.reason?.message ?? `${row.manager} is unavailable on the execution machine.`} Saved assignments are retained.</p>)}
    {!editingDefaults && <Checkbox label="Inherit profile resources" isSelected={value.inherit_profile !== false} disabled={disabled}
      onChange={inherit_profile => onChange({ ...value, inherit_profile })} />}
    {defaults && !editingDefaults && <p>{defaults.instructions ? 'Prompt assigned' : 'No profile prompt'} · {defaults.skills.length} skills · {defaults.mcp.length} MCP servers</p>}
    <Select variant={fieldVariant} label="Instructions" aria-label="Resource instructions" value={instructionKey} disabled={disabled}
      options={[
        ...(!editingDefaults ? [{ id: 'inherit', label: 'Profile default' }] : []),
        { id: 'off', label: 'Off' },
        ...instructionChoices.map(row => ({ id: key(row.target), label: `${row.label}${row.reconciliation_required ? ' · update pending' : ''}` })),
      ]}
      onChange={selectedKey => {
        const choice = instructionChoices.find(row => key(row.target) === selectedKey)
        setInputsError(''); onValidationChange?.(true)
        onChange({ ...value, instructions: choice ? { mode: 'replace', target: choice.target, required: false } : { mode: selectedKey as 'inherit' | 'off' } })
      }} />
    {instruction?.mode === 'replace' && <Checkbox label="Require these instructions" isSelected={instruction.required ?? false} disabled={disabled}
      description="These instructions must be available before the session starts."
      onChange={required => onChange({ ...value, instructions: { ...instruction, required } })} />}
    {(['skills', 'mcp'] as const).map(kind => {
      const policy = value[kind] ?? {}
      const selected = policy.add ?? []
      const options = [...choices[kind]]
      for (const item of selected) if (!options.some(row => key(row.target) === key(item.target))) options.push({ label: resourceLabel(item.target), target: item.target })
      return <fieldset key={kind} disabled={disabled}><legend>{kind === 'skills' ? 'Skills' : 'MCP servers'}</legend>
        {!editingDefaults && <Checkbox label="Include profile defaults" isSelected={policy.inherit !== false} disabled={disabled}
          onChange={inherit => onChange({ ...value, [kind]: { ...policy, inherit } })} />}
        {!editingDefaults && defaults?.[kind].map(item => <Checkbox key={'default:' + key(item.target)}
          label={`${resourceLabel(item.target)} · profile default`} isSelected={!policy.exclude?.some(t => key(t) === key(item.target))} disabled={disabled}
          onChange={included => onChange({ ...value, [kind]: { ...policy, exclude: included ? policy.exclude?.filter(t => key(t) !== key(item.target)) : [...(policy.exclude ?? []), item.target] } })} />)}
        {options.map(choice => {
          const found = selected.find(row => key(row.target) === key(choice.target))
          return <div key={key(choice.target)} className="resource-picker-option">
            <Checkbox label={`${choice.label}${choice.reconciliation_required ? ' · update pending' : ''}`} isSelected={!!found} disabled={disabled}
              onChange={included => onChange({ ...value, [kind]: { ...policy, add: included ? [...selected, { target: choice.target, required: false }] : selected.filter(row => key(row.target) !== key(choice.target)), exclude: policy.exclude?.filter(t => key(t) !== key(choice.target)) } })} />
            {kind === 'mcp' && choice.installation?.installation_required && <p role="status">This library version needs setup. <a href={reviewLink('mcp', choice.target)}>Open server setup</a>. Availability is checked on the execution machine.</p>}
            {found && <Checkbox label="Required" className="resource-picker-required" isSelected={found.required ?? false} disabled={disabled}
              description={`${choice.label} must be available before the session starts.`}
              onChange={required => onChange({ ...value, [kind]: { ...policy, add: selected.map(row => row === found ? { ...row, required } : row) } })} />}
          </div>
        })}
      </fieldset>
    })}
    <details className="resource-instruction-settings"><summary>Instruction inputs (JSON)</summary>
      <Textarea key={instructionKey} variant={fieldVariant} label="Resource instruction inputs" className="resource-instruction-inputs"
        defaultValue={JSON.stringify(instruction?.inputs ?? {}, null, 2)} disabled={disabled} rows={6} spellCheck={false}
        hint="Enter a JSON object containing the values for these instructions." error={inputsError}
        onChange={event => {
          try {
            const inputs: unknown = JSON.parse(event.target.value)
            if (!inputs || Array.isArray(inputs) || typeof inputs !== 'object') throw new Error('Inputs must be an object')
            onChange({ ...value, instructions: { ...instruction, inputs: inputs as Record<string, unknown> } })
            setInputsError(''); onValidationChange?.(true)
          } catch { setInputsError('Instruction inputs must be a valid JSON object.'); onValidationChange?.(false) }
        }} />
    </details>
    {error && <p role="alert">{error}</p>}
    <ResourceReportView report={report} />
  </div>
}

export function ProfileResourceEditor({ agents, profile }: { agents: AgentsModel; profile: { provider: Provider; profile: string } }) {
  const api = useRef(agents); api.current = agents
  const [saved, setSaved] = useState<Defaults | null>(null)
  const [value, setValue] = useState<ResourceRequest>({ inherit_profile: false })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [inputsValid, setInputsValid] = useState(true)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    setSaved(null); setNotice(''); setError('')
    void api.current.request<Defaults>('profile-resources-get', { provider: profile.provider, profile: profile.profile }).then(row => {
      if (!active) return
      validDefaults(row)
      setSaved(row); setValue({ inherit_profile: false, instructions: row.instructions ? { mode: 'replace', ...row.instructions } : { mode: 'off' }, skills: { inherit: false, add: row.skills }, mcp: { inherit: false, add: row.mcp } })
    }).catch((e: Error) => { if (active) setError(e.message) })
    return () => { active = false }
  }, [profile.provider, profile.profile])
  return <section className="agent-resource-links" aria-label="Profile resource defaults"><h3>Resource defaults</h3><p>Changes apply to future sessions. Existing sessions keep their captured copies.</p>
    {saved && <><ResourcePicker agents={agents} provider={profile.provider} profile={profile.profile} value={value} onChange={setValue} disabled={busy} editingDefaults onValidationChange={setInputsValid} />
      <Button type="button" variant="primary" size="sm" disabled={busy || !inputsValid} onPress={() => {
        setBusy(true); setError(''); setNotice('')
        const instruction = value.instructions
        void agents.request<Defaults>('profile-resources-set', { provider: profile.provider, profile: profile.profile, expectedRevision: saved.revision,
          resources: { instructions: instruction?.mode === 'replace' ? { target: instruction.target, required: instruction.required ?? false, inputs: instruction.inputs ?? {} } : null, skills: value.skills?.add ?? [], mcp: value.mcp?.add ?? [] } }).then(row => { setSaved(row); setNotice('Resource defaults saved.') }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false))
      }}>{busy ? 'Saving…' : 'Save resource defaults'}</Button></>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>
}
