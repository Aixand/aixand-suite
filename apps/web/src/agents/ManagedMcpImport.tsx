import { useRef, useState } from 'react'
import { TextField } from 'bbb-design'
import { McpDefinitionEditor } from './McpDefinitionEditor'
import type { ManagedStatus } from '../resources/managed'

export function ManagedMcpImport({ request, onSaved, onCancel, connected }: {
  request: <T>(op: string, args?: object) => Promise<T>; onSaved: (item: ManagedStatus) => Promise<void>; onCancel: () => void; connected: boolean
}) {
  const saved = useRef<ManagedStatus | null>(null)
  const [publisher, setPublisher] = useState('')
  const [identifier, setIdentifier] = useState('default')
  const [revision, setRevision] = useState('')
  const [version, setVersion] = useState('')
  return <McpDefinitionEditor name="Publisher definition" title="Register publisher definition" definition={{ command: '', args: [], env_vars: [] }} connected={connected} onCancel={onCancel}
    extraDirty={Boolean(publisher || revision || version || identifier !== 'default')}
    extraFields={<>
      <TextField label="Publisher ID" value={publisher} onChange={event => setPublisher(event.target.value)} required />
      <TextField label="Server ID" value={identifier} onChange={event => setIdentifier(event.target.value)} required />
      <TextField label="Publisher revision (optional)" type="number" min={0} step={1} value={revision} onChange={event => setRevision(event.target.value)} />
      <TextField label="Display version (optional)" value={version} onChange={event => setVersion(event.target.value)} />
    </>}
    onSave={async (_name, definition) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(publisher) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(identifier)) throw new Error('Use a valid publisher and server ID: letters, numbers, dots, underscores, or hyphens.')
      const value = revision === '' ? undefined : Number(revision)
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Publisher revision must be a nonnegative integer.')
      saved.current = await request<ManagedStatus>('ensure', { publisherId: publisher, resourceId: identifier,
        definition, ...(version ? { version } : {}), ...(value === undefined ? {} : { publisherRevision: value }) })
    }} onSaved={() => { if (saved.current) void onSaved(saved.current) }} />
}
