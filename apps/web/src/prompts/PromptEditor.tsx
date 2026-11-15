import { useEffect, useRef, useState } from 'react'
import { Button } from 'bbb-design'
import type { Details, Pack } from './model'
import { errorMessage, fileContent, firstFile } from './presentation'
import type { PromptRequest } from './presentation'
import { ResourceEditor } from '../resources/editor/ResourceEditor'
import { useResourceDraft } from '../resources/editor/drafts'

export function PromptEditor({ pack, name, request, connected, onSaved }: {
  pack: Pack; name?: string; request: PromptRequest; connected: boolean; onSaved: (details: Details) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [details, setDetails] = useState<Details | null>(null)
  const [file, setFile] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const snapshotKey = useRef('')
  const dirty = open && details !== null && text !== fileContent(details, file)
  const draft = useResourceDraft(dirty, saving)
  useEffect(() => {
    if (!open) { snapshotKey.current = ''; return }
    if (!connected || details && snapshotKey.current === `${pack.id}/${name ?? ''}`) return
    snapshotKey.current = `${pack.id}/${name ?? ''}`
    let active = true
    setDetails(null); setError('')
    void request<Details>('prompts-show', { packId: pack.id, prompt: name }).then(value => {
      if (!active) return
      const next = firstFile(value, name); setDetails(value); setFile(next); setText(fileContent(value, next))
    }).catch((cause: unknown) => { if (active) setError(errorMessage(cause)) })
    return () => { active = false }
  }, [open, pack.id, name, request, connected])
  async function save() {
    if (!details || !connected || saving || !dirty || !details.release.digest || text.length > 32000) return
    setSaving(true); setError('')
    try {
      const updated = await request<Details>('prompts-save', { packId: pack.id, file, text, expectedDigest: details.release.digest })
      setDetails(updated); setText(fileContent(updated, file)); await onSaved(updated); setOpen(false)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setSaving(false) }
  }
  return <>
    <Button variant="secondary" size="sm" disabled={!connected} aria-label={`Edit ${name ?? 'shared content'}`} onPress={() => setOpen(true)}>Edit</Button>
    {open && <ResourceEditor title={`Edit ${name ?? 'shared content'}`} subtitle={`${pack.name} · Draft`} file={file} files={details ? ['pack.json', ...Object.keys(details.files).filter(path => path !== 'pack.json')] : []}
      onFile={next => draft.guard(() => { if (details) { setFile(next); setText(fileContent(details, next)); setError('') } })}
      value={text} onChange={setText} label="Prompt file contents" dirty={dirty} busy={saving} disabled={!connected || !details || text.length > 32000}
      onCancel={() => draft.guard(() => setOpen(false))} onSave={() => { void save() }} error={text.length > 32000 ? 'Content must be 32,000 characters or fewer.' : error}
      notice={!connected ? 'Your edits are preserved. Reconnect to save.' : !details ? 'Loading prompt…' : undefined} />}
    {draft.confirmation}
  </>
}
