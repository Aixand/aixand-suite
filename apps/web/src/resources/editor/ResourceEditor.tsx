import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button, CommandSearch, Icon, Popover } from 'bbb-design'
import { useContentFieldVariant } from '../../branding/ContentTheme'
import { CodeEditor } from './LazyCodeEditor'
import { ResourceContent } from './ResourceContent'
import './editor.css'

export function ResourceFilePicker({ files, value, onChange, disabled = false }: {
  files: string[]; value: string; onChange: (file: string) => void; disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const fieldVariant = useContentFieldVariant()
  return <Popover title="Choose a file" open={open} onOpenChange={open => {
    setOpen(open)
    if (open) setQuery('')
  }} trigger={<Button variant="ghost" size="sm" disabled={disabled} className="resource-file-trigger"><Icon name="file-text" /><span className="resource-file-name">{value || 'Choose a file'}</span><Icon name="chevron-down" /></Button>}>
    <CommandSearch className="resource-file-picker" label="Search files" placeholder="Find a file…" query={query} onQueryChange={setQuery} autoFocus variant={fieldVariant}
      items={files.map(file => ({ id: file, label: file, group: 'Package files', description: file === value ? 'Current file' : undefined,
        leading: <Icon name={file === value ? 'check' : 'file-text'} /> }))}
      onAction={file => { setOpen(false); onChange(file) }} />
  </Popover>
}

/** A portal fills the existing reader; the main app rail and Agents navigation stay accessible. */
export function ResourceEditor({ title, subtitle, file, files, onFile, value, onChange, label, dirty, busy, disabled,
  onCancel, onSave, saveLabel = 'Save changes', children, binary = false, error, notice, body, modes }: {
  title: string; subtitle?: string; file: string; files?: string[]; onFile?: (file: string) => void
  value: string; onChange: (value: string) => void; label: string; dirty: boolean; busy?: boolean; disabled?: boolean
  onCancel: () => void; onSave: () => void; saveLabel?: string; children?: ReactNode; binary?: boolean; error?: string; notice?: ReactNode; body?: ReactNode; modes?: ReactNode | false
}) {
  const marker = useRef<HTMLSpanElement>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const [preview, setPreview] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const previousFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const reader = marker.current?.closest<HTMLElement>('.carrier-reader')
    if (!reader) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const siblings = [...reader.children] as HTMLElement[]
    const previous = siblings.map(node => node.inert)
    siblings.forEach(node => { node.inert = true })
    reader.dataset.editing = 'true'; setContainer(reader)
    return () => { delete reader.dataset.editing; siblings.forEach((node, i) => { node.inert = previous[i] }); requestAnimationFrame(() => previousFocus.current?.isConnected && previousFocus.current.focus()) }
  }, [])
  const save = () => { if (!disabled && !busy && dirty) onSave() }
  return <><span ref={marker} hidden />{container && createPortal(<section className="resource-editor" aria-label={title} data-expanded={expanded || undefined} onKeyDownCapture={event => { if (event.key === 'Escape' && event.currentTarget.contains(event.target as Node) && !busy && !event.currentTarget.querySelector('.cm-search, .cm-tooltip-autocomplete')) { event.preventDefault(); event.stopPropagation(); onCancel() } }}>
    <header className="resource-editor-header"><div className="resource-editor-heading"><div><h1 tabIndex={-1}>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      <span className="resource-editor-state" role="status">{busy ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</span>
      <Button variant="ghost" size="sm" className="resource-cancel" aria-label="Cancel" disabled={busy} onPress={onCancel}><Icon name="x" className="resource-mobile-icon" /><span className="resource-action-label">Cancel</span></Button>
      <Button size="sm" disabled={disabled || busy || !dirty} loading={busy} onPress={save} aria-label={saveLabel}><span className="resource-action-label">{saveLabel}</span><span className="resource-mobile-label">Save</span></Button></div>
      <div className="resource-editor-toolbar">
        {files && onFile ? <ResourceFilePicker files={files} value={file} onChange={onFile} disabled={busy} /> : <span className="resource-editor-file">{file}</span>}
        {modes !== undefined ? modes : !binary && <div className="resource-editor-modes resource-default-modes" role="group" aria-label="Editor view"><Button size="sm" className="resource-mode-edit" variant="ghost" aria-pressed={!preview} onPress={() => setPreview(false)}>Edit</Button>
          <Button size="sm" className="resource-mode-preview" variant="ghost" aria-pressed={preview} onPress={() => setPreview(true)}>Preview</Button></div>}
        <Button iconOnly size="sm" variant="ghost" className="resource-editor-expand" aria-label={expanded ? 'Show resource library' : 'Expand editor'} onPress={() => setExpanded(!expanded)}><Icon name="panel-left" /></Button>
      </div>
    </header>
    {error && <p className="resource-error" role="alert">{error}</p>}{notice && <div className="resource-editor-notice">{notice}</div>}
    <div className="resource-editor-body">{body ?? (binary ? <div className="resource-document"><h2>Binary file</h2><p>Bytes are preserved. Upload a replacement to change its contents.</p></div>
      : <><div className="resource-editor-code" hidden={preview}><CodeEditor key={file} label={label} file={file} value={value} onChange={onChange} disabled={busy} onSave={save} autoFocus /></div>
        {preview && <div className="resource-preview" tabIndex={0} role="region" aria-label="Resource preview"><ResourceContent text={value} file={file} /></div>}</>)}</div>
    {children && <footer className="resource-editor-footer">{children}</footer>}
  </section>, container)}</>
}
