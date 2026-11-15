import { useEffect, useState } from 'react'
import { Alert, Button, Dialog, EmptyState, Select } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { SavedSession } from '../agents/client'
import { usePrompts } from '../prompts/model'
import type { Launch, Snapshot } from '../prompts/model'
import { ResourceContent } from '../resources/editor/ResourceContent'
import { PageLoading } from '../components/PageLoading'
import './instructions.css'

type Identity = Pick<SavedSession, 'provider' | 'profile' | 'id'>
export function SessionInstructions({ agents, identity, open, onOpenChange }: {
  agents: AgentsModel; identity: Identity; open: boolean; onOpenChange: (open: boolean) => void
}) {
  return <Dialog title="Saved instructions" description={`Instructions recorded with this session · ${identity.profile}`} className="session-instructions-dialog"
    trigger={<Button hidden className="resource-dialog-trigger">Saved instructions dialog</Button>} open={open} onOpenChange={onOpenChange}
    footer={<Button variant="secondary" onPress={() => onOpenChange(false)}>Close</Button>}>
    {open && <InstructionRecords agents={agents} identity={identity} />}
  </Dialog>
}

function InstructionRecords({ agents, identity }: { agents: AgentsModel; identity: Identity }) {
  const p = usePrompts(agents)
  const [pages, setPages] = useState<Record<string, { launches: Launch[]; next: number | null }>>({})
  const [selection, setSelection] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { setPages({}) }, [p.catalog?.checked_at])
  const consumers = (p.catalog?.consumers ?? []).filter(row => row.local && row.provider === identity.provider)
  const records = consumers.flatMap(consumer => [...new Map([...consumer.launches, ...(pages[consumer.id]?.launches ?? [])].map(launch => [launch.id, launch])).values()]
    .filter(launch => launch.profile === identity.profile && launch.thread_id === identity.id)
    .map(launch => ({ consumer, launch, key: `${consumer.id}/${launch.id}` })))
  const selected = records.find(row => row.key === selection) ?? records[0]
  async function older(consumerId: string, offset: number) {
    setBusy(consumerId); setError('')
    try {
      const result = await p.request<{ launches: Launch[]; next_offset: number | null }>('prompts-history', { consumerId, offset })
      setPages(current => ({ ...current, [consumerId]: { launches: [...(current[consumerId]?.launches ?? []), ...result.launches], next: result.next_offset } }))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Saved runs could not be loaded.') }
    finally { setBusy('') }
  }
  return <div className="session-instructions">
    {p.error && <Alert title="Could not load saved instructions" tone="danger" role="alert">{p.error}<Button variant="secondary" size="sm" disabled={!p.connected || p.loading} onPress={() => { void p.refresh() }}>Try again</Button></Alert>}
    {!p.connected && <p className="carrier-muted">Reconnect to inspect saved instructions.</p>}
    {consumers.filter(row => row.error).map(row => <Alert key={row.id} title={`${row.label} unavailable`} tone="warning">{row.error}</Alert>)}
    {!p.catalog && p.loading ? <PageLoading label="Loading saved instructions…" size="panel" /> : selected ? <>
      {records.length > 1 && <Select label="Saved run" value={selected.key} onChange={setSelection} options={records.map(row => ({ id: row.key, label: `${row.launch.reference || 'No managed prompt'} · ${row.launch.id}` }))} />}
      <InstructionSnapshot key={selected.key} agents={agents} consumerId={selected.consumer.id} launch={selected.launch} />
    </> : p.catalog && !p.error && <EmptyState headingLevel={3} icon="scroll-text" title="No saved instructions found"
      description="This session has no saved prompt in the loaded records." />}
    {consumers.map(consumer => {
      const next = pages[consumer.id] ? pages[consumer.id].next : consumer.next_offset
      return next != null && <Button key={consumer.id} variant="secondary" size="sm" disabled={!p.connected || !!busy} loading={busy === consumer.id}
        onPress={() => { void older(consumer.id, next) }}>Load older saved runs{consumers.length > 1 ? ` · ${consumer.label}` : ''}</Button>
    })}
    {error && <Alert title="Could not load older runs" tone="danger" role="alert">{error}</Alert>}
  </div>
}

function InstructionSnapshot({ agents, consumerId, launch }: { agents: AgentsModel; consumerId: string; launch: Launch }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const request = agents.request
  const online = agents.status === 'connected'
  useEffect(() => {
    if (!online) return
    let active = true
    setError('')
    void request<Snapshot>('prompts-snapshot', { consumerId, launchId: launch.id }).then(value => { if (active) setSnapshot(value) })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Saved instructions could not be loaded.') })
    return () => { active = false }
  }, [consumerId, launch.id, request, online, retry])
  return <>
    {error && <Alert title="Could not inspect saved instructions" tone="danger" role="alert">{error}<Button variant="secondary" size="sm" disabled={!online} onPress={() => setRetry(value => value + 1)}>Try again</Button></Alert>}
    {snapshot ? <>
      {snapshot.instructions ? <>
        <p className="session-instruction-reference">{snapshot.instructions.reference}</p>
        <ResourceContent text={snapshot.instructions.developer_instructions} file="instructions.md" label="Saved developer instructions" />
      </> : <p className="carrier-muted">No managed prompt was saved with this session.</p>}
      <details className="session-instruction-details"><summary>Technical details</summary><pre>{JSON.stringify({ status: snapshot.status, launch: launch.id, thread_id: snapshot.thread_id, provenance: snapshot.instructions?.provenance }, null, 2)}</pre></details>
    </> : !error && online && <PageLoading label="Loading saved prompt…" size="panel" />}
  </>
}
