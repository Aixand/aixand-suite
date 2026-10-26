import { useState } from 'react'
import { Button, Select, TextField } from 'bbb-design'
import type { Source } from '../skills/Sources'
export type Application = { id: string; label: string; prompts: Record<string, unknown>; revision: string; error?: string }
export function PromptApplications({ applications, sources, request, disabled, onChanged }: {
  applications: Application[]; sources: Source[]; request: <T>(op: string, args?: object) => Promise<T>; disabled: boolean; onChanged: () => Promise<unknown>
}) {
  const [identifier, setIdentifier] = useState('')
  const [observed, setObserved] = useState<string | null>(null)
  const [logical, setLogical] = useState('')
  const [kind, setKind] = useState('release')
  const [reference, setReference] = useState('')
  const [source, setSource] = useState('')
  const [path, setPath] = useState('')
  const [prompt, setPrompt] = useState('')
  const [publisher, setPublisher] = useState('')
  const [packageId, setPackageId] = useState('default')
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { setResult(await action()); await onChanged() }
    catch (e) { setError(e instanceof Error ? e.message : 'Application operation failed') }
    finally { setBusy(false) }
  }
  return <section className="prompts-form"><h2>Application prompt references</h2>
    <p>Publishing leaves pinned consumers unchanged. Select a registered source explicitly for draft mappings.</p>
    {applications.map(row => <div key={row.id}><Button variant="ghost" onPress={() => { setIdentifier(row.id); setObserved(row.revision); setResult(row) }}>{row.label || row.id}</Button>
      <p>{row.id} · {row.revision}</p>{row.error && <p role="alert">{row.error}</p>}
      <ul>{Object.keys(row.prompts || {}).map(name => <li key={name}>{name}</li>)}</ul></div>)}
    <TextField label="Application ID" value={identifier} onChange={e => { setIdentifier(e.target.value); setObserved(null) }} disabled={disabled || busy} />
    <Button disabled={disabled || busy || !identifier || observed !== null} onPress={() => { void act(async () => {
      const value = await request<Application>('prompts-application-register', { applicationId: identifier, prompts: {}, expectedRevision: null }); setObserved(value.revision); return value
    }) }}>Register application</Button>
    <TextField label="Logical prompt" value={logical} onChange={e => setLogical(e.target.value)} />
    <Select label="Reference type" value={kind} onChange={setKind} options={[{ id: 'release', label: 'Immutable release' }, { id: 'managed', label: 'Active managed copy' }, { id: 'draft', label: 'Registered draft' }]} />
    {kind === 'release' ? <TextField label="Released prompt reference" value={reference} onChange={e => setReference(e.target.value)} hint="pack@version/prompt" /> : kind === 'managed' ? <>
      <TextField label="Publisher ID" value={publisher} onChange={event => setPublisher(event.target.value)} />
      <TextField label="Managed package ID" value={packageId} onChange={event => setPackageId(event.target.value)} />
      <TextField label="Prompt name" value={prompt} onChange={event => setPrompt(event.target.value)} />
    </> : <>
      <Select label="Prompt source" value={source} onChange={setSource} options={[{ id: '', label: 'Choose an exact source' }, ...sources.map(row => ({ id: row.id, label: row.label || row.id }))]} />
      <TextField label="Registered pack directory" value={path} onChange={e => setPath(e.target.value)} />
      <TextField label="Prompt name" value={prompt} onChange={e => setPrompt(e.target.value)} />
    </>}
    <Button disabled={disabled || busy || !observed || !logical} onPress={() => { void act(async () => {
      const value = await request<Application>('prompts-application-set', { applicationId: identifier, logicalPrompt: logical,
        target: kind === 'release' ? { kind, reference } : kind === 'managed' ? { kind, publisher_id: publisher, package_id: packageId, prompt } : { kind, source_id: source, pack_path: path, prompt }, expectedRevision: observed }); setObserved(value.revision); return value
    }) }}>Save effective reference</Button>
    <Button variant="secondary" disabled={disabled || busy || !identifier || !logical} onPress={() => { void act(() => request('prompts-application-resolve', { applicationId: identifier, logicalPrompt: logical })) }}>Inspect actual resolution</Button>
    {result !== null && <pre aria-label="Prompt resolution and registration">{JSON.stringify(result, null, 2)}</pre>}
    {error && <p role="alert">{error}</p>}
  </section>
}
