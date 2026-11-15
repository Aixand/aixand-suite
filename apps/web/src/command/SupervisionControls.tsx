import { randomUUID } from '../uuid'
import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Icon, Select, Sheet, Textarea } from 'bbb-design'
import { PageLoading } from '../components/PageLoading'
import type { Workspace } from '../workspace/model'
import type { Monitor } from './model'
import { chatSupervision, supervisionChat, supervisionLabel, supervisionRoute } from './supervision'
import './supervision.css'

export function SupervisionBadge({ monitor }: { monitor: Monitor }) {
  return <span className={`supervision-badge supervision-badge--${monitor.state}`}><Icon name="eye" />{supervisionLabel(monitor)}</span>
}

/** Resolve old monitor bookmarks into the conversation that owns the mandate. */
export function SupervisionLink({ workspace: w, monitorId, navigate }: { workspace: Workspace; monitorId: string; navigate: (route: string) => void }) {
  useEffect(() => { void w.command.open(monitorId); return () => { void w.command.open(null) } }, [monitorId])
  const monitor = w.command.monitors.find(row => row.id === monitorId)
  useEffect(() => { if (monitor && supervisionChat(monitor)) navigate(supervisionRoute(monitor)) }, [monitor?.sourceChatId, monitor?.supervisorChatId, monitorId])
  return <div className="supervision-resolving"><PageLoading label="Opening the supervising conversation…" size="panel" />
    {w.command.error && <p role="alert">{w.command.error}</p>}
    <Button variant="ghost" onPress={() => navigate('chat/supervising')}>Back to chats</Button></div>
}

export function SupervisionControl({ workspace: w, chatId, focusId, navigate }: { workspace: Workspace; chatId: string; focusId?: string; navigate: (route: string) => void }) {
  const monitors = chatSupervision(w.command.monitors, chatId)
  const [open, setOpen] = useState(Boolean(focusId))
  const [selected, setSelected] = useState(focusId ?? '')
  const [direction, setDirection] = useState('')
  const [evidence, setEvidence] = useState<{ id: string; kind: 'evidence' | 'action'; text: string; nextOffset: number | null } | null>(null)
  const [error, setError] = useState('')
  const retry = useRef<{ signature: string; key: string } | null>(null)
  const current = monitors.find(row => row.id === selected) ?? monitors[0]
  const detail = w.command.detail?.monitor.id === current?.id ? w.command.detail : null
  const monitor = detail?.monitor ?? current
  useEffect(() => { setOpen(Boolean(focusId)); setSelected(focusId ?? ''); setDirection(''); setEvidence(null); setError('') }, [chatId, focusId])
  useEffect(() => { void w.command.open(open && current ? current.id : null); return () => { void w.command.open(null) } }, [open, current?.id])
  if (!monitor) return null
  async function action(op: string, extra: object = {}) {
    const args = { monitorId: monitor.id, ...extra }
    const signature = JSON.stringify([op, args])
    if (!retry.current || retry.current.signature !== signature) retry.current = { signature, key: randomUUID() }
    setError('')
    try { await w.command.mutate(op, { key: retry.current.key, ...args }); retry.current = null; setDirection('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update supervision.') }
  }
  async function read(id: string, kind: 'evidence' | 'action' = 'evidence', offset = 0) {
    try {
      const page = await w.command.request<{ text: string; nextOffset: number | null }>(`command-${kind}`, {
        monitorId: monitor.id, [kind === 'action' ? 'actionId' : 'evidenceId']: id, offset,
      })
      setEvidence(prior => ({ id, kind, text: offset && prior?.id === id ? prior.text + page.text : page.text, nextOffset: page.nextOffset }))
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read the saved evidence.') }
  }
  return <Sheet title="Supervision" side="end" open={open} onOpenChange={setOpen} bodyClassName="supervision-sheet"
    trigger={<Button variant="ghost" size="sm" className="supervision-trigger" aria-label={`${supervisionLabel(monitor)}: open supervision`}>
      <SupervisionBadge monitor={monitor} />{monitors.length > 1 && <span>({monitors.length})</span>}<Icon name="chevron-down" />
    </Button>}>
    {monitors.length > 1 && <Select label="Responsibility" value={monitor.id} options={monitors.map(row => ({ id: row.id, label: row.title }))}
      onChange={id => { setSelected(id); setEvidence(null); setDirection(''); setError('') }} />}
    <section aria-label="Supervision progress"><h3>{monitor.title}</h3><p className="supervision-preserve">{monitor.progress}</p>
      <Badge tone="neutral">{supervisionLabel(monitor)}</Badge>
      {monitor.error && <p role="alert">{monitor.error}</p>}
      {!w.command.connected && <p role="status">Offline. Supervision continues while the server is running.</p>}
      <div className="supervision-actions">
        {['scheduled', 'running', 'waiting'].includes(monitor.state) && <Button variant="secondary" disabled={w.command.busy || !w.command.connected} onPress={() => { void action('command-pause') }}>Pause supervision</Button>}
        {['paused', 'needs_input'].includes(monitor.state) && <Button disabled={w.command.busy || !w.command.connected} onPress={() => { void action('command-resume') }}>Resume supervision</Button>}
        {!['cancelled', 'completed'].includes(monitor.state) && <Button variant="ghost" disabled={w.command.busy || !w.command.connected} onPress={() => { void action('command-cancel') }}>Stop supervision</Button>}
      </div>
    </section>
    <details open><summary>Brief and requirements</summary><p className="supervision-preserve">{monitor.instruction}</p>
      {monitor.memory && <><h3>Remembered progress</h3><p className="supervision-preserve">{monitor.memory}</p></>}
    </details>
    {!detail && <p role="status">Loading supervision details…</p>}
    {w.command.error && <p role="alert">{w.command.error} <Button variant="ghost" onPress={() => { void w.command.open(monitor.id) }}>Retry</Button></p>}
    {detail && <>
      <section aria-label="Watched resources"><h3>Watching</h3>
        {detail.watches.length ? <ul className="supervision-resources">{detail.watches.map((watch, index) => <li key={watch.id ?? index}>
          <Badge tone="neutral">{watch.kind}</Badge>
          {watch.kind === 'chat' ? <a href={`#/chat/${watch.targetId}`}>{w.chats.chats.find(chat => chat.id === watch.targetId)?.title ?? 'Open watched chat'}</a>
            : watch.kind === 'workflow' ? <a href={`#/workflows/runs/${watch.targetId}`}>Open workflow</a>
              : <span>{watch.kind === 'timer' ? watch.intervalSeconds ? `Every ${watch.intervalSeconds / 60} minutes` : watch.nextAt ? new Date(watch.nextAt).toLocaleString() : 'Scheduled timer' : watch.targetId}</span>}
          <small>{watch.done ? 'Settled' : 'Active'}</small>
        </li>)}</ul> : <p>The supervisor will choose what to watch.</p>}
      </section>
      {!!detail.delegations?.length && <section aria-label="Delegated work"><h3>Delegated work</h3><ul className="supervision-resources">
        {detail.delegations.map(launch => <li key={launch.id}><a href={`#/chat/${launch.chatId}`}>{launch.title}</a><small>{launch.status}</small></li>)}
      </ul></section>}
      {monitor.state !== 'cancelled' && <form className="supervision-direction" onSubmit={event => { event.preventDefault(); if (direction.trim()) void action('command-update', { expectedRevision: monitor.revision, direction: direction.trim() }) }}>
        <Textarea label="Update the brief" rows={3} value={direction} maxLength={32000} onChange={event => setDirection(event.target.value)} />
        <Button type="submit" disabled={!direction.trim() || w.command.busy || !w.command.connected}>Save direction</Button>
      </form>}
      <section aria-label="Supervision activity"><h3>Activity</h3><ol className="supervision-activity">{detail.activity.map(entry => <li key={entry.sequence}>
        <p>{entry.text}</p><small>{new Date(entry.createdAt).toLocaleString()}</small>
        {entry.evidenceId && <Button variant="ghost" size="sm" onPress={() => { void read(entry.evidenceId!) }}>Read report</Button>}
        {entry.actionId && <Button variant="ghost" size="sm" onPress={() => { void read(entry.actionId!, 'action') }}>Inspect action</Button>}
      </li>)}</ol></section>
      {monitor.evidence.length > 0 && <section aria-label="Completion evidence"><h3>Evidence</h3><ul>{monitor.evidence.map(ref => <li key={ref}>
        {ref.startsWith('#/chat/') || ref.startsWith('#/workflows/') ? <a href={ref}>{ref}</a>
          : /^[\da-f]{8}-[\da-f-]{27}$/i.test(ref) ? <Button variant="ghost" onPress={() => { void read(ref) }}>{ref}</Button> : <span>{ref}</span>}
      </li>)}</ul></section>}
      {evidence && <section aria-label="Saved evidence"><h3>Saved evidence</h3><pre className="supervision-evidence">{evidence.text}</pre>
        {evidence.nextOffset !== null && <Button variant="ghost" onPress={() => { void read(evidence.id, evidence.kind, evidence.nextOffset!) }}>Read next part</Button>}</section>}
    </>}
    <details><summary>Execution settings</summary><p>{monitor.evaluations} / {monitor.limits.maxEvaluations} evaluations · {monitor.permissionMode}</p>
      <p>{monitor.profile ?? 'Automatic profile'}{monitor.limits.deadline ? ` · Due ${new Date(monitor.limits.deadline).toLocaleString()}` : ''}</p>
      {monitor.state !== 'cancelled' && <div className="supervision-actions">
        <Button variant="secondary" disabled={w.command.busy || !w.command.connected || monitor.limits.maxEvaluations >= 10000} onPress={() => { void action('command-update', {
          expectedRevision: monitor.revision, limits: { maxEvaluations: Math.min(10000, monitor.limits.maxEvaluations + 100) },
        }) }}>Allow 100 more evaluations</Button>
        <Button variant="ghost" disabled={w.command.busy || !w.command.connected} onPress={() => { void action('command-update', { expectedRevision: monitor.revision, freshSession: true }) }}>Use a fresh execution chat</Button>
      </div>}
      {monitor.supervisorChatId && monitor.supervisorChatId !== chatId && <Button variant="ghost" onPress={() => { setOpen(false); navigate(`chat/${monitor.supervisorChatId}`) }}>Open execution chat</Button>}
    </details>
    {error && <p role="alert">{error}</p>}
  </Sheet>
}
