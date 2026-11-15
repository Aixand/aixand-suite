import { useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { Alert, Badge, Button, Combobox, Dialog, EmptyState, Icon, Select, TextField } from 'bbb-design'
import { useContentFieldVariant } from '../branding/ContentTheme'
import type { Source } from '../skills/Sources'
import type { Pack } from './model'
import type { ManagedStatus } from '../resources/managed'
import type { PromptRequest } from './presentation'
import { errorMessage } from './presentation'
import './integrations.css'

type PromptTarget =
  | { kind: 'release'; reference: string }
  | { kind: 'managed'; publisher_id: string; package_id: string; prompt: string; revision?: string }
  | { kind: 'draft'; source_id: string; pack_path: string; prompt: string }
export type Application = { id: string; label: string; prompts: Record<string, PromptTarget>; revision: string; error?: string }
type Resolution = { reference?: string | null; source_id?: string; path?: string | null; prompt?: string; used_fallback?: boolean; release?: { digest?: string }; target?: PromptTarget }
const validName = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
const targetLabel = (target: PromptTarget) => target.kind === 'release' ? target.reference : target.kind === 'managed' ? `${target.publisher_id} / ${target.package_id} / ${target.prompt}` : `${target.source_id} / ${target.prompt}`
const kindLabel = (target: PromptTarget) => target.kind === 'release' ? 'Released version' : target.kind === 'managed' ? 'Managed copy' : 'Registered draft'

export function PromptApplications({ applications, sources, packs, managed, request, disabled, onChanged }: {
  applications: Application[]; sources: Source[]; packs: Pack[]; managed: ManagedStatus[]
  request: PromptRequest; disabled: boolean; onChanged: () => Promise<unknown>
}) {
  const fieldVariant = useContentFieldVariant()
  const [active, setActive] = useState<Application | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [name, setName] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [mapping, setMapping] = useState<{ app: Application; name: string; target?: PromptTarget } | null>(null)
  const [resolution, setResolution] = useState<{ app: string; name: string; value?: Resolution; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lastAction = useRef<HTMLButtonElement | null>(null)
  const resolutionRequest = useRef(0)
  const title = useRef<HTMLHeadingElement>(null)
  function restoreFocus() { requestAnimationFrame(() => (lastAction.current?.isConnected ? lastAction.current : title.current)?.focus()) }
  const remember: NonNullable<ComponentProps<typeof Button>['onClick']> = event => { if (event.currentTarget instanceof HTMLButtonElement) lastAction.current = event.currentTarget }
  function closeResolution() { resolutionRequest.current++; setResolution(null); restoreFocus() }
  async function connect() {
    setBusy(true); setError('')
    try {
      const value = await request<Application>('prompts-application-register', { applicationId: identifier.trim(), label: name.trim() || identifier.trim(), prompts: {}, expectedRevision: null })
      setActive(value); setConnecting(false); await onChanged()
      requestAnimationFrame(() => title.current?.focus())
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  async function inspect(app: Application, logical: string) {
    const token = ++resolutionRequest.current
    setResolution({ app: app.label || app.id, name: logical })
    try {
      const value = await request<Resolution>('prompts-application-resolve', { applicationId: app.id, logicalPrompt: logical })
      if (token === resolutionRequest.current) setResolution(current => current ? { ...current, value } : null)
    } catch (cause) { if (token === resolutionRequest.current) setResolution(current => current ? { ...current, error: errorMessage(cause) } : null) }
  }
  const connectButton = <Button disabled={disabled} onClick={remember} onPress={() => { setName(''); setIdentifier(''); setError(''); setConnecting(true) }}><Icon name="plus" />Connect app</Button>
  return <section className="prompt-integrations" aria-label="App integrations">
    {active ? <>
      <Button className="prompt-integrations-back" variant="ghost" size="sm" onPress={() => { setActive(null); requestAnimationFrame(() => title.current?.focus()) }}><Icon name="chevron-left" />All integrations</Button>
      <header className="prompt-integrations-heading"><div><h3 ref={title} tabIndex={-1}>{active.label || active.id}</h3><p>Choose the prompt used for each name this app requests.</p></div>
        <Button disabled={disabled || !!active.error} onClick={remember} onPress={() => setMapping({ app: active, name: '' })}><Icon name="plus" />Add mapping</Button>
      </header>
      {active.error && <Alert tone="warning" title="Integration needs attention">{active.error}</Alert>}
      {Object.keys(active.prompts ?? {}).length ? <ul className="prompt-integration-list" aria-label="Prompt mappings">
        {Object.entries(active.prompts).map(([logical, target]) => <li key={logical} className="prompt-integration-row">
          <div className="prompt-integration-copy"><strong>{logical}</strong><p>{targetLabel(target)}</p><Badge>{kindLabel(target)}</Badge></div>
          <div className="prompt-integration-actions">
            <Button variant="secondary" size="sm" disabled={disabled || !!active.error} aria-label={`Edit mapping ${logical}`} onClick={remember} onPress={() => setMapping({ app: active, name: logical, target })}>Edit</Button>
            <Button variant="ghost" size="sm" disabled={disabled || !!active.error} aria-label={`Inspect mapping ${logical}`} onClick={remember} onPress={() => { void inspect(active, logical) }}>Inspect</Button>
          </div>
        </li>)}
      </ul> : <EmptyState headingLevel={4} icon="scroll-text" title="No prompt mappings yet" description="Add a mapping to choose which prompt this app receives." />}
      <details className="prompts-disclosure"><summary>Integration details</summary><dl className="agent-source-details">
        <dt>Application ID</dt><dd>{active.id}</dd><dt>Revision</dt><dd>{active.revision}</dd>
      </dl></details>
    </> : <>
      <header className="prompt-integrations-heading"><div><h3 ref={title} tabIndex={-1}>Connected apps</h3><p>Map the prompt names your apps request to prompts in your library.</p></div>{connectButton}</header>
      {applications.length ? <ul className="prompt-integration-list" aria-label="Connected apps">
        {applications.map(app => <li className="prompt-integration-row" key={app.id}>
          <div className="prompt-integration-copy"><strong>{app.label || app.id}</strong><p>{Object.keys(app.prompts ?? {}).length} prompt {Object.keys(app.prompts ?? {}).length === 1 ? 'mapping' : 'mappings'}</p>
            {app.error && <span className="prompts-source-error">{app.error}</span>}</div>
          <Button variant="secondary" size="sm" aria-label={`Manage ${app.label || app.id}`} onPress={() => { setActive(app); requestAnimationFrame(() => title.current?.focus()) }}>Manage<Icon name="chevron-right" /></Button>
        </li>)}
      </ul> : <EmptyState headingLevel={4} icon="layers" title="No connected apps" description="Connect an app when it needs to request prompts from this library." />}
    </>}
    <Dialog title="Connect app" description="Register the application that will request prompts from your library." className="prompts-dialog prompt-integration-dialog" bodyClassName="prompts-form"
      trigger={<Button hidden className="prompts-dialog-trigger">Connect app dialog</Button>} open={connecting} onOpenChange={open => { if (!busy) { setConnecting(open); if (!open) restoreFocus() } }}
      footer={<><Button variant="ghost" disabled={busy} onPress={() => { setConnecting(false); restoreFocus() }}>Cancel</Button><Button loading={busy} disabled={disabled || !validName(identifier.trim())} onPress={() => { void connect() }}>Connect app</Button></>}>
      <TextField label="App name" variant={fieldVariant} value={name} maxLength={128} disabled={busy} onChange={event => setName(event.target.value)} hint="A name you will recognize in the list." />
      <TextField label="Application ID" variant={fieldVariant} value={identifier} maxLength={128} disabled={busy} onChange={event => setIdentifier(event.target.value)} hint="Use the identifier expected by your app, such as review-service." />
      {error && <Alert tone="danger" role="alert" title="Could not connect app">{error}</Alert>}
    </Dialog>
    {mapping && <MappingDialog app={mapping.app} logical={mapping.name} target={mapping.target} packs={packs} managed={managed} sources={sources} request={request} disabled={disabled}
      onClose={() => { setMapping(null); restoreFocus() }} onSaved={async app => { setActive({ ...mapping.app, ...app }); setMapping(null); await onChanged(); restoreFocus() }} />}
    <Dialog title="Resolved prompt" description={resolution ? `${resolution.app} · ${resolution.name}` : undefined} className="prompts-dialog prompt-integration-dialog" bodyClassName="prompts-form"
      trigger={<Button hidden className="prompts-dialog-trigger">Resolved prompt dialog</Button>} open={resolution !== null} onOpenChange={open => { if (!open) closeResolution() }}
      footer={<Button variant="secondary" onPress={closeResolution}>Close</Button>}>
      {resolution?.error ? <Alert tone="danger" role="alert" title="Could not resolve prompt">{resolution.error}</Alert> : resolution?.value ? <>
        <dl className="agent-source-details"><dt>Prompt</dt><dd>{resolution.value.reference || (resolution.value.target ? targetLabel(resolution.value.target) : resolution.value.prompt) || 'Resolved prompt'}</dd>
          <dt>Source</dt><dd>{resolution.value.source_id || 'Managed library'}</dd><dt>Selection</dt><dd>{resolution.value.used_fallback ? 'Packaged fallback' : 'Configured mapping'}</dd></dl>
        <details className="prompts-disclosure"><summary>Technical details</summary><pre className="prompts-output" aria-label="Prompt resolution details">{JSON.stringify(resolution.value, null, 2)}</pre></details>
      </> : <p role="status">Resolving prompt…</p>}
    </Dialog>
  </section>
}

function MappingDialog({ app, logical, target, packs, managed, sources, request, disabled, onClose, onSaved }: {
  app: Application; logical: string; target?: PromptTarget; packs: Pack[]; managed: ManagedStatus[]; sources: Source[]; request: PromptRequest; disabled: boolean
  onClose: () => void; onSaved: (app: Application) => Promise<void>
}) {
  const variant = useContentFieldVariant()
  const [name, setName] = useState(logical)
  const [kind, setKind] = useState<PromptTarget['kind']>(target?.kind ?? 'release')
  const [reference, setReference] = useState(target?.kind === 'release' ? target.reference : '')
  const [publisher, setPublisher] = useState(target?.kind === 'managed' ? target.publisher_id : '')
  const [packageId, setPackageId] = useState(target?.kind === 'managed' ? target.package_id : '')
  const [revision, setRevision] = useState(target?.kind === 'managed' ? target.revision ?? '' : '')
  const [source, setSource] = useState(target?.kind === 'draft' ? target.source_id : '')
  const [path, setPath] = useState(target?.kind === 'draft' ? target.pack_path : '')
  const [prompt, setPrompt] = useState(target && target.kind !== 'release' ? target.prompt : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const releases = [...new Set(packs.filter(pack => pack.kind === 'release' && pack.reference).flatMap(pack => pack.prompts.map(row => `${pack.reference}/${row.name}`)))].map(id => ({ id, label: id }))
  const draftPacks = packs.filter(pack => pack.kind === 'draft' && pack.source_id === source && pack.path)
  const packageOptions = managed.map(row => ({ id: `${row.publisher_id}/${row.id}`, label: row.label || row.id, description: row.publisher_id }))
  const selectedPackage = publisher && packageId ? `${publisher}/${packageId}` : ''
  if (selectedPackage && !packageOptions.some(row => row.id === selectedPackage)) packageOptions.push({ id: selectedPackage, label: packageId, description: publisher })
  const sourceOptions = sources.map(row => ({ id: row.id, label: row.label || row.id }))
  if (source && !sourceOptions.some(row => row.id === source)) sourceOptions.push({ id: source, label: source })
  const duplicate = !target && Object.hasOwn(app.prompts, name)
  const complete = validName(name) && !duplicate && (kind === 'release' ? !!reference.trim() : kind === 'managed' ? validName(publisher) && validName(packageId) && validName(prompt) : !!source && !!path.trim() && validName(prompt))
  async function save() {
    setBusy(true); setError('')
    const next: PromptTarget = kind === 'release' ? { kind, reference: reference.trim() } : kind === 'managed'
      ? { kind, publisher_id: publisher, package_id: packageId, prompt, ...(revision ? { revision } : {}) }
      : { kind, source_id: source, pack_path: path.trim(), prompt }
    try {
      const value = await request<Application>('prompts-application-set', { applicationId: app.id, logicalPrompt: name, target: next, expectedRevision: app.revision })
      await onSaved(value)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  return <Dialog title={target ? 'Edit prompt mapping' : 'Add prompt mapping'} description={app.label || app.id} className="prompts-dialog prompt-integration-dialog" bodyClassName="prompts-form"
    trigger={<Button hidden className="prompts-dialog-trigger">Prompt mapping dialog</Button>} open onOpenChange={open => { if (!open && !busy) onClose() }}
    footer={<><Button variant="ghost" disabled={busy} onPress={onClose}>Cancel</Button><Button disabled={disabled || !complete} loading={busy} onPress={() => { void save() }}>Save mapping</Button></>}>
    <TextField label="Prompt name in app" value={name} variant={variant} disabled={busy || !!target} hint="The name the app requests, such as code_review."
      error={duplicate ? 'This name already has a mapping. Edit it from the list.' : undefined} onChange={event => setName(event.target.value)} />
    <Select label="Use" value={kind} variant={variant} disabled={busy} onChange={value => setKind(value as PromptTarget['kind'])}
      options={[{ id: 'release', label: 'Released version' }, { id: 'managed', label: 'Managed copy' }, { id: 'draft', label: 'Registered draft' }]} />
    {kind === 'release' ? <PromptChoice label="Released prompt" variant={variant} options={releases} value={reference} onChange={setReference}
      disabled={busy} hint="Choose a prompt or enter pack@version/prompt." /> : kind === 'managed' ? <>
      {managed.length ? <Select label="Managed package" variant={variant} options={[{ id: '', label: 'Choose a package' }, ...packageOptions]} value={selectedPackage} disabled={busy}
        onChange={value => { const [nextPublisher, nextPackage] = value.split('/'); setPublisher(nextPublisher ?? ''); setPackageId(nextPackage ?? ''); if (value !== selectedPackage) setRevision('') }} /> : <>
        <TextField label="Publisher ID" variant={variant} value={publisher} disabled={busy} onChange={event => { setPublisher(event.target.value); setRevision('') }} />
        <TextField label="Managed package ID" variant={variant} value={packageId} disabled={busy} onChange={event => { setPackageId(event.target.value); setRevision('') }} />
      </>}
      <TextField label="Prompt name" variant={variant} value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)} />
      <details className="prompts-disclosure"><summary>Revision settings</summary><TextField label="Pinned revision" variant={variant} value={revision} disabled={busy} hint="Leave empty to follow the active managed copy." onChange={event => setRevision(event.target.value)} /></details>
    </> : <>
      <Select label="Prompt source" variant={variant} value={source} options={[{ id: '', label: 'Choose a source' }, ...sourceOptions]} disabled={busy} onChange={value => { setSource(value); setPath('') }} />
      <PromptChoice label="Pack directory" variant={variant} options={draftPacks.map(pack => ({ id: pack.path!, label: pack.path! }))} value={path} onChange={setPath}
        disabled={busy} hint="Choose a pack from this source or enter its absolute directory." />
      <TextField label="Prompt name" variant={variant} value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)} />
    </>}
    {error && <Alert tone="danger" role="alert" title="Could not save mapping">{error}</Alert>}
  </Dialog>
}

function PromptChoice({ label, options, value, onChange, disabled, hint, variant }: {
  label: string; options: { id: string; label: string }[]; value: string; onChange: (value: string) => void; disabled: boolean; hint: string; variant: ComponentProps<typeof Combobox>['variant']
}) {
  if (!options.length) return <TextField label={label} variant={variant} value={value} onChange={event => onChange(event.target.value)} disabled={disabled} hint={hint} />
  return <Combobox label={label} variant={variant} allowsCustomValue options={options} inputValue={value} onInputChange={onChange}
    onSelectionChange={key => { if (key !== null) onChange(String(key)) }} disabled={disabled} hint={hint} />
}
