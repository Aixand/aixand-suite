import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import './editor.css'

const palette = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.bool, tags.null], color: 'var(--bbb-color-accent-text)' },
  { tag: [tags.string, tags.url], color: 'var(--bbb-color-accent-text)' },
  { tag: [tags.number, tags.propertyName], color: 'var(--bbb-color-text)' },
  { tag: [tags.comment, tags.meta], color: 'var(--bbb-color-text-secondary)' },
  { tag: tags.heading, fontWeight: '600', color: 'var(--bbb-color-text)' },
]))
export function CodeEditor({ value, onChange, file = '', label, disabled = false, onSave, autoFocus = false }: {
  value: string; onChange: (value: string) => void; file?: string; label: string; disabled?: boolean; onSave?: () => void; autoFocus?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const callbacks = useRef({ onChange, onSave }); callbacks.current = { onChange, onSave }
  const initial = useRef(value)
  const configuration = useRef(new Compartment())
  const lineEndings = useRef(new Compartment())
  useEffect(() => {
    const current = new EditorView({ parent: host.current!, doc: initial.current, extensions: [basicSetup, palette, EditorView.lineWrapping,
      configuration.current.of([]), lineEndings.current.of(EditorState.lineSeparator.of(initial.current.includes('\r\n') ? '\r\n' : '\n')), EditorView.updateListener.of(update => { if (update.docChanged) callbacks.current.onChange(update.state.sliceDoc()) }),
      EditorView.domEventHandlers({ keydown: event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); callbacks.current.onSave?.(); return true }
        return false
      } }),
    ] })
    current.scrollDOM.tabIndex = 0
    current.scrollDOM.setAttribute('role', 'region')
    current.scrollDOM.setAttribute('aria-label', `${label} scroll area`)
    view.current = current
    if (autoFocus) current.focus()
    return () => { view.current = null; current.destroy() }
  }, [autoFocus])
  useEffect(() => {
    view.current?.dispatch({ effects: configuration.current.reconfigure([
      /\.json$/i.test(file) ? json() : /\.(md|markdown)$/i.test(file) ? markdown() : [],
      EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled),
      EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', 'aria-disabled': String(disabled), spellcheck: 'false', tabindex: '0' }),
    ]) })
  }, [file, label, disabled])
  useEffect(() => {
    const current = view.current
    if (!current) return
    const separator = value.includes('\r\n') ? '\r\n' : value.includes('\n') ? '\n' : current.state.lineBreak
    if (separator !== current.state.lineBreak) current.dispatch({ effects: lineEndings.current.reconfigure(EditorState.lineSeparator.of(separator)) })
    if (current.state.sliceDoc() !== value) current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } })
  }, [value])
  return <div className="resource-code-editor" ref={host} />
}
