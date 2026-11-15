import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from 'bbb-design'
import { randomUUID } from '../uuid'
import { AgentRequest } from './Conversation'
import type { BackgroundActivity as Activity, ChatItem, ChatLaunch, ChatSnapshot } from './model'

type Props = {
  chat: ChatSnapshot
  connected: boolean
  supported: boolean
  launches: ChatLaunch[]
  load: (chatId: string) => Promise<Activity>
  inspectAgent: (chatId: string, agentId: string) => Promise<{ items: ChatItem[] }>
  inspectProcess: (chatId: string, processId: string) => Promise<{ text: string }>
  stopProcess: (args: { key: string; chatId: string; processId: string }) => Promise<{ terminated: boolean }>
  onOpenChat: (chatId: string) => void
  onAnswer: (requestId: string, values: { answers?: Record<string, string>; decision?: string }) => Promise<void>
}

export function BackgroundActivity(props: Props) {
  const latest = useRef(props)
  latest.current = props
  const [activity, setActivity] = useState<Activity | null>(null)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ title: string; items: ChatItem[]; agentId?: string } | null>(null)
  const mounted = useRef(true)
  const refresh = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      if (cancelled || inFlight) return
      inFlight = true
      if (latest.current.supported && latest.current.connected && document.visibilityState !== 'hidden') {
        try {
          const value = await latest.current.load(props.chat.id)
          if (cancelled) return
          if (Array.isArray(value.agents) && Array.isArray(value.processes)) {
            setActivity(previous => ({ ...value,
              agents: value.agentsAvailability === 'unavailable' ? previous?.agents ?? [] : value.agents,
              processes: value.processesAvailability === 'unavailable' ? previous?.processes ?? [] : value.processes,
            }))
            setLoadError('')
          }
        } catch {
          if (!cancelled) setLoadError('Background status unavailable. Last known activity is shown.')
        }
      }
      inFlight = false
      if (!cancelled) timer = setTimeout(poll, 5000)
    }
    refresh.current = async () => { clearTimeout(timer); await poll() }
    void poll()
    const visible = () => { if (document.visibilityState === 'visible') void refresh.current() }
    document.addEventListener('visibilitychange', visible)
    return () => { cancelled = true; mounted.current = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [props.chat.id, props.connected, props.supported])

  const launches = props.launches.filter(row => row.attached !== false)
  const agents = activity?.agents ?? []
  const processes = activity?.processes ?? []
  const needsInput = agents.filter(row => row.needsInput).length + launches.filter(row => row.needsInput).length
  const unavailable = Boolean(loadError || activity?.agentsAvailability === 'unavailable' || activity?.processesAvailability === 'unavailable' || !props.connected)
  if (!agents.length && !processes.length && !launches.length && !error && !unavailable) return null
  const agentCount = agents.length + launches.length

  async function inspect(id: string, title: string) {
    setBusy(id); setError('')
    try {
      const value = await latest.current.inspectAgent(props.chat.id, id)
      if (mounted.current) setDetail({ title, items: value.items, agentId: id })
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not inspect this agent.') }
    finally { if (mounted.current) setBusy(null) }
  }

  async function stop(id: string) {
    const key = randomUUID()
    setBusy(`stop:${id}`); setError('')
    try {
      const result = await latest.current.stopProcess({ key, chatId: props.chat.id, processId: id })
      if (mounted.current) {
        if (!result.terminated) setError('The provider did not confirm termination. Refresh to inspect the process.')
        await refresh.current()
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Stop outcome is unconfirmed. Refresh before retrying.') }
    finally { if (mounted.current) setBusy(null) }
  }

  async function inspectOutput(id: string, title: string) {
    setBusy(id); setError('')
    try {
      const value = await latest.current.inspectProcess(props.chat.id, id)
      if (mounted.current) setDetail({ title, items: [{ id, type: 'commandExecution', text: value.text || 'No output is available yet.' }] })
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not read process output.') }
    finally { if (mounted.current) setBusy(null) }
  }

  function depth(id: string) {
    let level = 0
    let current = agents.find(row => row.id === id)
    const seen = new Set<string>()
    while (current?.parentId && !seen.has(current.id) && level < 4) {
      seen.add(current.id)
      current = agents.find(row => row.id === current?.parentId)
      if (current) level++
    }
    return level
  }

  return <details className="command-background" aria-label="Background activity">
    <summary><Icon name="chevron-right" /><span>Background activity</span>
      <span>{agentCount > 0 && `${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`}{agentCount > 0 && processes.length > 0 && ' · '}
        {processes.length > 0 && `${processes.length} ${processes.length === 1 ? 'process' : 'processes'}`}</span>
      {needsInput > 0 && <strong>{needsInput} needs input</strong>}
      {unavailable && <span>Status unavailable</span>}
    </summary>
    <div className="command-background-body">
      {error && <p role="alert">{error}</p>}
      {unavailable && <p role="status">{loadError || 'Live background status is unavailable. Entries may be out of date.'}</p>}
      {activity?.processesAvailability === 'limited' && <p>Showing running commands reported in the conversation. Full process inspection and Stop are unavailable in this provider version.</p>}
      {activity?.processesAvailability === 'unsupported' && <p>Process inspection is unavailable in this provider version.</p>}
      {(agents.length > 0 || launches.length > 0) && <section aria-label="Background agents"><h3>Agents</h3>
        {launches.map(row => <div className="command-background-row" key={`suite:${row.id}`}>
          <div><strong>{row.title}</strong><span>{row.needsInput ? 'Needs your answer' : row.status}</span>{row.resultPreview && <p>{row.resultPreview}</p>}</div>
          <Button variant="ghost" size="sm" onPress={() => props.onOpenChat(row.chatId)}>View conversation</Button>
        </div>)}
        {agents.map(row => <div className="command-background-row" key={`provider:${row.id}`} style={{ paddingInlineStart: `${depth(row.id) * 12}px` }}>
          <div><strong>{row.title}</strong><span>{row.needsInput ? 'Needs input' : row.status === 'unknown' ? 'Status unknown' : row.status}</span>
            {row.preview && row.preview !== row.title && <p>{row.preview}</p>}</div>
          {row.canInspect && <Button variant="ghost" size="sm" disabled={!props.connected || busy !== null}
            onPress={() => { void inspect(row.id, row.title) }}>View conversation</Button>}
        </div>)}
      </section>}
      {processes.length > 0 && <section aria-label="Background processes"><h3>Processes</h3>{processes.map(row => {
        return <div className="command-background-row" key={row.id}><div><code>{row.command}</code><span>{row.status}</span><p>{row.cwd}</p></div>
          <div className="command-background-actions">
            <Button variant="ghost" size="sm" disabled={!props.connected || busy !== null}
              onPress={() => { void inspectOutput(row.id, row.command) }}>View output</Button>
            {row.canStop && <Button variant="ghost" size="sm" disabled={!props.connected || unavailable || busy !== null}
              onPress={() => { void stop(row.id) }}>{busy === `stop:${row.id}` ? 'Stopping…' : 'Stop process'}</Button>}
          </div>
        </div>
      })}</section>}
      {detail && <section aria-label="Background activity preview"><div className="command-background-row"><h3>{detail.title}</h3>
        <Button variant="ghost" size="sm" onPress={() => setDetail(null)}>Close preview</Button></div>
        {!detail.items.length && <p>No saved activity yet.</p>}
        {detail.items.map(item => <div key={item.id}><strong>{item.type === 'agentMessage' ? 'Agent' : item.type === 'userMessage' ? 'User' : 'Activity'}</strong><pre>{item.text}</pre></div>)}
        {detail.agentId && props.chat.requests.filter(request => request.params.threadId === detail.agentId).map(request =>
          <AgentRequest key={request.requestId} request={request} disabled={!props.connected} onAnswer={props.onAnswer} />)}
      </section>}
      <Button variant="ghost" size="sm" disabled={!props.connected} onPress={() => { void refresh.current() }}>Refresh background activity</Button>
    </div>
  </details>
}
