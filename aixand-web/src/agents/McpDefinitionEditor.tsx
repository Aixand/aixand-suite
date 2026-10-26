import { useState, type ReactNode } from 'react'
import { Button, DropdownMenu, Icon, TextField } from 'bbb-design'
import { ResourceEditor } from '../resources/editor/ResourceEditor'
import { useResourceDraft } from '../resources/editor/drafts'

export type McpDefinition = { kind?: string; command: string; args?: string[]; env_vars?: string[]; cwd?: string; startup_timeout_sec?: number; tool_timeout_sec?: number; installation?: Record<string, unknown> }
export function parseDefinition(text: string): McpDefinition {
  const row = JSON.parse(text)
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Enter a JSON object for the server definition.')
  const allowed = ['kind', 'command', 'args', 'env_vars', 'cwd', 'startup_timeout_sec', 'tool_timeout_sec', 'installation']
  const unsupported = Object.keys(row).filter(key => !allowed.includes(key))
  if (unsupported.length) throw new Error(`Unsupported configuration fields: ${unsupported.join(', ')}.`)
  if (!['stdio', 'sonar', 'lore'].includes(row.kind ?? 'stdio')) throw new Error('Choose a supported server type: stdio, sonar, or lore.')
  if (typeof row.command !== 'string' || !row.command.trim() || row.command.includes('\0')) throw new Error('Enter an executable name or path in Command.')
  for (const key of ['args', 'env_vars']) if (row[key] !== undefined && (!Array.isArray(row[key]) || row[key].some((value: unknown) => typeof value !== 'string' || value.includes('\0')))) throw new Error(`${key === 'args' ? 'Arguments' : 'Environment variables'} must be an array of strings.`)
  if ((row.args?.length ?? 0) > 128) throw new Error('Use no more than 128 arguments.')
  if (row.env_vars?.some((key: string) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error('Environment references must be variable names, such as DOCS_TOKEN.')
  if (row.cwd !== undefined && (typeof row.cwd !== 'string' || !row.cwd.trim())) throw new Error('Enter a working directory or omit that field.')
  for (const key of ['startup_timeout_sec', 'tool_timeout_sec', 'installation']) if (row[key] !== undefined && (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] <= 0 || row[key] > 3600)) throw new Error('Timeouts must be greater than 0 and no more than 3,600 seconds.')
  if (row.installation !== undefined && (!row.installation || typeof row.installation !== 'object' || Array.isArray(row.installation))) throw new Error('Installation must be a recipe object.')
  return row as McpDefinition
}
function Values({ label, values, onChange, disabled }: { label: string; values: string[]; onChange: (values: string[]) => void; disabled: boolean }) {
  return <section className="mcp-value-list"><h2>{label === 'Argument' ? 'Arguments' : 'Environment variables'}</h2>
    {label !== 'Argument' && <p className="carrier-muted">Names of variables available to the server process. Values stay in the environment.</p>}
    {values.map((value, index) => <div className="mcp-value-row" key={index}><TextField label={`${label} ${index + 1}`} hideLabel value={value} disabled={disabled}
      onChange={event => onChange(values.map((row, at) => at === index ? event.target.value : row))} />
      <DropdownMenu label={`${label} ${index + 1} actions`} trigger={<Button iconOnly variant="ghost" size="sm" disabled={disabled} aria-label={`${label} ${index + 1} actions`}><Icon name="ellipsis" /></Button>}
        items={[{ id: 'up', label: 'Move up', disabled: index === 0 }, { id: 'down', label: 'Move down', disabled: index === values.length - 1 }, { id: 'remove', label: 'Remove' }]}
        onAction={action => { const next = [...values]; if (action === 'remove') next.splice(index, 1); else { const at = index + (action === 'up' ? -1 : 1); [next[index], next[at]] = [next[at], next[index]] } onChange(next) }} />
    </div>)}
    <Button variant="ghost" size="sm" disabled={disabled} onPress={() => onChange([...values, ''])}><Icon name="plus" />Add {label.toLowerCase()}</Button>
  </section>
}
export function McpDefinitionEditor({ name, definition, connected, onCancel, onSave, onSaved, extraFields, extraDirty = false, title }: {
  extraFields?: ReactNode; extraDirty?: boolean; title?: string; name?: string; definition: McpDefinition; connected: boolean; onCancel: () => void; onSave: (name: string, definition: McpDefinition) => Promise<void>; onSaved: (name: string) => void
}) {
  const [serverName, setServerName] = useState(name ?? '')
  const initial = JSON.stringify(definition, null, 2)
  const [text, setText] = useState(initial)
  const [form, setForm] = useState(definition)
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const dirty = extraDirty || text !== initial || serverName !== (name ?? '')
  const draft = useResourceDraft(dirty, busy)
  const patch = (value: Partial<McpDefinition>) => { const next = { ...form, ...value }; if (!next.cwd) delete next.cwd; setForm(next); setText(JSON.stringify(next, null, 2)); setError('') }
  async function save() {
    if (busy || !connected) return
    try {
      if (!serverName.trim()) throw new Error('Enter a server name.')
      const value = parseDefinition(text)
      setBusy(true); setError(''); await onSave(serverName.trim(), value); draft.complete(() => onSaved(serverName.trim()))
    } catch (cause) { setError(cause instanceof SyntaxError ? `Invalid JSON: ${cause.message}` : cause instanceof Error ? cause.message : 'Configuration could not be saved.') }
    finally { setBusy(false) }
  }
  return <><ResourceEditor title={title ?? (name ? `Edit ${name}` : 'Add MCP server')} subtitle="Server configuration" file={`${name ?? 'server'}.json`} value={text}
    onChange={setText} label="MCP server definition" dirty={dirty} busy={busy} disabled={!connected} onSave={() => { void save() }}
    onCancel={() => draft.guard(onCancel)} error={error} notice={!connected ? 'Your edits are preserved. Reconnect to save.' : undefined}
    modes={<div className="resource-editor-modes" role="group" aria-label="Configuration editor"><Button variant="ghost" size="sm" aria-pressed={mode === 'form'} onPress={() => {
      try { const value = parseDefinition(text); setForm(value); setMode('form'); setError('') } catch (cause) { if (mode !== 'form') setError(cause instanceof Error ? cause.message : 'Correct the JSON before opening the form.') }
    }}>Form</Button><Button variant="ghost" size="sm" aria-pressed={mode === 'json'} onPress={() => setMode('json')}>JSON</Button></div>}
    body={mode === 'form' ? <div className="resource-preview"><div className="resource-form mcp-definition-form">
      {extraFields}
      {form.installation && <details><summary>Managed installation</summary><pre>{JSON.stringify(form.installation, null, 2)}</pre>
        <p>The manager prepares this installation recipe. You can edit it in JSON or configure an executable installed separately.</p>
        <Button variant="secondary" disabled={busy} onPress={() => { const next = { ...form }; delete next.installation; setForm(next); setText(JSON.stringify(next, null, 2)) }}>Use an external executable</Button>
      </details>}
      {!name && <TextField label="Server name" value={serverName} onChange={event => setServerName(event.target.value)} disabled={busy} required autoFocus />}
      <TextField label="Command" value={form.command} onChange={event => patch({ command: event.target.value })} disabled={busy} required autoFocus={Boolean(name)} hint="Executable name or absolute path." />
      <Values label="Argument" values={form.args ?? []} onChange={args => patch({ args })} disabled={busy} />
      <Values label="Environment variable" values={form.env_vars ?? []} onChange={env_vars => patch({ env_vars })} disabled={busy} />
      <details className="mcp-advanced"><summary>Advanced settings</summary><div className="resource-form">
        <TextField label="Working directory" value={form.cwd ?? ''} onChange={event => patch({ cwd: event.target.value })} disabled={busy} hint="Leave empty to use the launch context." />
        <TextField label="Startup timeout (seconds)" type="number" min={0.1} max={3600} step="any" value={String(form.startup_timeout_sec ?? 60)} onChange={event => patch({ startup_timeout_sec: Number(event.target.value) })} disabled={busy} />
        <TextField label="Tool timeout (seconds)" type="number" min={0.1} max={3600} step="any" value={String(form.tool_timeout_sec ?? 60)} onChange={event => patch({ tool_timeout_sec: Number(event.target.value) })} disabled={busy} />
      </div></details>
    </div></div> : undefined} />{draft.confirmation}</>
}
