import { useState } from 'react'
import { Button, Checkbox, Textarea, TextField } from 'bbb-design'
export type Source = { id: string; label?: string; paths: string[]; writable: boolean; owner?: unknown; revision: string; error?: unknown }
export function ResourceSources({ kind, sources, request, disabled, onChanged }: {
  kind: 'skills' | 'prompts'; sources: Source[]; request: <T>(op: string, args?: object) => Promise<T>; disabled: boolean; onChanged: () => Promise<unknown>
}) {
  const [identifier, setIdentifier] = useState('')
  const [paths, setPaths] = useState('')
  const [writable, setWritable] = useState(false)
  const [observed, setObserved] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function mutate(op: string, args: object) {
    setBusy(true); setError('')
    try { await request(op, args); await onChanged(); setIdentifier(''); setObserved(null); setPaths('') }
    catch (e) { setError(e instanceof Error ? e.message : 'Source registration failed') }
    finally { setBusy(false) }
  }
  return <div className="resource-sources">
    {sources.map(source => <div key={source.id}><strong>{source.label || source.id}</strong><p>{source.id} · {source.writable ? 'Writable' : 'Read only'}</p>
      <p>{(source.paths ?? []).join('\n')}</p><p>Revision: {source.revision}</p>{Boolean(source.error) && <p role="alert">{JSON.stringify(source.error)}</p>}
      <Button variant="ghost" disabled={disabled || busy || !source.revision} onPress={() => { setIdentifier(source.id); setPaths((source.paths ?? []).join('\n')); setWritable(source.writable); setObserved(source.revision) }}>Edit source registration</Button>
      <Button variant="ghost" disabled={disabled || busy || !source.revision} onPress={() => { void mutate(`${kind}-source-unregister`, { sourceId: source.id, expectedRevision: source.revision }) }}>Unregister source</Button>
    </div>)}
    <form onSubmit={event => { event.preventDefault(); void mutate(`${kind}-source-register`, { sourceId: identifier, paths: paths.split('\n').filter(Boolean), writable, expectedRevision: observed }) }}>
      <TextField variant="outlined" label="Source ID" required value={identifier} disabled={disabled || busy || observed !== null} onChange={event => setIdentifier(event.target.value)} />
      <Textarea variant="outlined" label="Source paths (one per line)" required rows={4} value={paths} disabled={disabled || busy} onChange={event => setPaths(event.target.value)} />
      <Checkbox label="Allow draft editing" isSelected={writable} onChange={setWritable} disabled={disabled || busy} />
      <Button type="submit" disabled={disabled || busy || !identifier || !paths}>{observed ? 'Save source registration' : 'Register source'}</Button>
      {observed && <Button variant="ghost" onPress={() => { setObserved(null); setIdentifier(''); setPaths(''); setWritable(false) }}>New source</Button>}
    </form>{error && <p role="alert">{error}</p>}
  </div>
}
