import { profileAccountLabel } from '../agents/accountPresentation'
import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Icon, Select, Switch, Tooltip } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import { useVox, type VoxItem } from './model'
import { useDock } from './useDock'
import { CallIcon } from './CallIcon'
import { ConversationLinks } from './ConversationLinks'
import { getSettings } from '../settings/model'
import './vox.css'

const actions: Record<string, string> = {
  list_projects: 'Finding projects…', inspect_profiles: 'Checking profiles…',
  start_investigation: 'Starting an investigation…', get_task_status: 'Checking progress…',
  stop_task: 'Requesting task stop…', list_tasks: 'Finding recent tasks…',
  search_chats: 'Finding conversations…', read_chat: 'Reading conversation…',
  send_chat_message: 'Sending your message…', get_chat_message_status: 'Checking message progress…',
}

export function Vox({ agents }: { agents: AgentsModel }) {
  const vox = useVox(), dock = useDock()
  const [open, setOpen] = useState(false)
  const [profile, setProfile] = useState('')
  const [draft, setDraft] = useState('')
  const [noticesVisible, setNoticesVisible] = useState(false)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false)
  const [diagnosticsFallback, setDiagnosticsFallback] = useState('')
  const callButton = useRef<HTMLButtonElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const previousSession = useRef<string | null>(null)

  // A new utterance replaces the previous exchange; repeated assistant updates
  // share one reply bubble, including background task announcements.
  const user = [...vox.items].reverse().find((item) => item.role === 'user')
  const userIndex = user ? vox.items.indexOf(user) : -1
  const reply = vox.items.slice(userIndex + 1).reverse().find((item) => item.role === 'assistant')
  const exchange = [user, reply].filter((item): item is VoxItem => !!item)
  const notices = exchange.filter((item) => item.text.trim())
  const latestNotice = notices.at(-1)
  const callStatus = vox.tool ? actions[vox.tool] : vox.audioConnecting || vox.phase === 'starting' ? 'Connecting…' :
    vox.phase === 'ending' ? 'Ending call…' : vox.phase === 'thinking' ? 'Vox is thinking…' :
    vox.phase === 'listening' ? 'Listening…' :
    vox.audioActive ? vox.muted ? 'Microphone muted' : 'Connected' : vox.session ? 'Microphone off' : 'Your virtual assistant'
  const panelBounds = dock.overlay(400)
  const panelStyle = vox.session ? { ...panelBounds, height: Math.min(620, Number(panelBounds.maxHeight)) } : panelBounds

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }) }, [vox.items, open])
  useEffect(() => {
    if (vox.audioActive) { setOpen(false); callButton.current?.focus() }
  }, [vox.audioActive])
  useEffect(() => {
    if (previousSession.current && !vox.session) hidePanel()
    previousSession.current = vox.session?.id ?? null
  }, [vox.session?.id])
  useEffect(() => { vox.setOnWake(() => { setOpen(true); operation(startCall) }) })
  useEffect(() => {
    if (!vox.debugEnabled) { setDiagnosticsCopied(false); setDiagnosticsFallback('') }
  }, [vox.debugEnabled])
  useEffect(() => {
    if (open || !vox.session || !latestNotice) { setNoticesVisible(false); return }
    setNoticesVisible(true)
    const timer = setTimeout(() => setNoticesVisible(false), 12000)
    return () => clearTimeout(timer)
  }, [open, vox.session?.id, latestNotice?.id, latestNotice?.text])
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') hidePanel() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [open])

  function showPanel() { vox.connect(); setOpen(true) }
  function hidePanel() { setOpen(false); callButton.current?.focus() }
  function operation(work: () => Promise<unknown>) {
    void work().catch((cause) => vox.setError(cause instanceof Error ? cause.message : 'Vox request failed.'))
  }
  async function startCall() {
    if (await vox.start(profile || null)) await vox.startAudio()
  }
  async function endCall() { if (await vox.end()) hidePanel() }
  async function copyDiagnostics() {
    const preference = getSettings()
    if (!preference.debugMode) return
    const report = vox.diagnosticReport()
    try {
      await navigator.clipboard.writeText(report)
      if (getSettings() === preference) { setDiagnosticsCopied(true); setDiagnosticsFallback('') }
    } catch {
      if (getSettings() === preference) { setDiagnosticsCopied(false); setDiagnosticsFallback(report) }
    }
  }

  return <div className="vox-widget" style={dock.style} data-side={dock.side} data-dragging={dock.dragging || undefined}
    onPointerDownCapture={dock.pointerDown} onKeyDownCapture={dock.keyDown}>
    <Tooltip disabled={dock.dragging} placement={dock.above ? 'top' : 'bottom'} content={vox.session ? `Vox call · ${callStatus}` : 'Call Vox'}>
      <Button ref={callButton} variant="ghost" size="sm" iconOnly className="vox-trigger" aria-label="Vox assistant" aria-expanded={open} aria-controls={open ? 'vox-panel' : undefined}
        aria-description="Drag to move and snap to an edge. Use Left or Right to dock to a side, Up or Down to adjust the position, and Home to return to the bottom right."
        data-active={!!vox.session || undefined} data-listening={vox.audioActive && !vox.muted || undefined}
        data-wake={vox.wakeStatus !== 'off' || undefined}
        onPress={(event) => { if (dock.canPress(event.pointerType)) (open ? hidePanel : showPanel)() }}>
        <CallIcon name="phone" />
        {(vox.audioActive || vox.wakeStatus !== 'off') && <span className="vox-live-dot" data-muted={vox.muted || !vox.audioActive || undefined}
          aria-label={vox.wakeStatus !== 'off' && (vox.muted || !vox.audioActive) ? 'Hey Vox microphone listener is on' : vox.muted ? 'Microphone muted' : 'Microphone on'} />}
      </Button>
    </Tooltip>

    {!open && <section className="vox-call-updates" style={dock.overlay(340)} aria-label="Vox call updates">
      <div className="vox-notices" role="log" aria-label="Vox message notifications" aria-live="polite">
        {vox.session && noticesVisible && notices.filter((item) => !dismissed.includes(item.id)).map((item) =>
          <article className={`vox-notice vox-notice--${item.role}`} key={item.id} aria-label={item.role === 'user' ? 'Your message' : 'Vox reply'}>
            <div className="vox-notice-heading"><strong>{item.role === 'user' ? 'You' : 'Vox'}</strong>
              <Button variant="ghost" size="sm" iconOnly aria-label={item.role === 'user' ? 'Dismiss your message' : 'Dismiss Vox reply'}
                onPress={() => setDismissed((previous) => [...previous, item.id].slice(-10))}><Icon name="x" /></Button>
            </div>
            <p>{item.text}</p>
          </article>)}
      </div>
      {vox.session && <ConversationLinks conversations={vox.conversations} />}
      {vox.error && <p role="alert" className="vox-call-error">{vox.error}</p>}
    </section>}

    {open && <aside id="vox-panel" className="vox-panel" style={panelStyle} data-call={!!vox.session || undefined} aria-label="Vox assistant">
      <div className="vox-call-heading"><span>VOICE CALL</span>
        <Button variant="ghost" size="sm" iconOnly aria-label="Hide Vox" onPress={hidePanel}><Icon name="minus" /></Button>
      </div>
      <div className="vox-caller">
        <div className="vox-caller-avatar" data-connected={vox.audioActive || undefined} aria-hidden="true"><CallIcon name="phone" /></div>
        <h2>Vox</h2>
        <p className="vox-status" role="status">{callStatus}</p>
        {vox.session && <small>{vox.session.profile}{vox.session.auth ? ` · ${vox.session.auth}` : ''}</small>}
      </div>
      {vox.error && <p role="alert" className="vox-error">{vox.error}</p>}
      {vox.status === 'offline' && <Button variant="ghost" onPress={vox.connect}>Reconnect Vox</Button>}
      <div className="vox-wake-setting"><Switch label="Auto-call · Hey Vox" checked={vox.wakeStatus !== 'off'} disabled={vox.status !== 'connected'}
        onChange={(event) => operation(event.target.checked ? vox.startWake : vox.stopWake)}
        description={vox.wakeStatus === 'preparing' ? 'Preparing the lightweight wake listener…' : 'Keeps microphone access for Hey Vox, mute, unmute, and end commands. Go offline stops all listening.'} />
        {vox.debugEnabled && <details className="vox-diagnostics"><summary>Voice diagnostics</summary>
          <p>Auto-call: {vox.wakeStatus}. Console filter: [Vox].</p>
          <Button variant="ghost" size="sm" onPress={() => operation(copyDiagnostics)}>Copy diagnostics</Button>
          {diagnosticsCopied && <span role="status">Copied</span>}
          {diagnosticsFallback && <textarea aria-label="Vox diagnostics report" readOnly value={diagnosticsFallback} onFocus={(event) => event.currentTarget.select()} />}
        </details>}
      </div>

      {!vox.session && <div className="vox-start">
        <Select label="Codex profile" value={profile} onChange={setProfile} disabled={vox.busy}
          options={[{ id: '', label: 'Auto · most allowance remaining' }, ...(agents.catalog?.profiles.filter((row) => row.provider === 'codex') ?? [])
            .map((row) => ({ id: row.profile, label: row.profile, description: profileAccountLabel(row, 'chat') }))]} />
        <p>Talk to Vox about your projects, or ask it to start an investigation.</p>
        <Button className="vox-start-call" disabled={vox.status !== 'connected' || vox.busy || agents.status !== 'connected'} onPress={() => operation(startCall)}>
          <CallIcon name="phone" />{vox.phase === 'starting' ? 'Connecting…' : 'Start call'}
        </Button>
      </div>}

      {vox.session && <>
        <div className="vox-conversation">
        <div ref={log} className="vox-messages" role="log" aria-label="Vox conversation" aria-live="polite" tabIndex={0}>
          {exchange.map((item) => <div className={`vox-message vox-message--${item.role}`} key={item.id}>
            <strong>{item.role === 'user' ? 'You' : 'Vox'}</strong><p>{item.text || '…'}</p>
          </div>)}
        </div>
        <ConversationLinks conversations={vox.conversations} />
        <form className="vox-compose" onSubmit={(event) => {
          event.preventDefault()
          const text = draft.trim()
          if (text) operation(async () => { await vox.send(text); setDraft('') })
        }}>
          <input aria-label="Message Vox" placeholder="Or type a message…" value={draft} maxLength={16000} disabled={vox.busy} onChange={(event) => setDraft(event.target.value)} />
          <Button type="submit" size="sm" iconOnly aria-label="Send to Vox" disabled={!draft.trim() || vox.busy}><Icon name="arrow-up" /></Button>
        </form>

        {!!vox.tasks.length && <details className="vox-investigations"><summary>Investigations <Badge tone="neutral">{vox.tasks.length}</Badge></summary>
          <section className="vox-tasks" aria-label="Vox investigations">
            {vox.tasks.map((task) => <div className="vox-task" key={task.id}>
              <a href={task.url}>{task.title}</a><Badge tone="neutral">{task.needsInput ? 'Needs input' : task.status}</Badge>
              <small>{task.project}</small>{task.error && <p>{task.error}</p>}
            </div>)}
          </section>
        </details>}
        </div>

        <div className="vox-call-controls">
          <div><Button className="vox-call-control" variant="secondary" iconOnly aria-label={vox.muted ? 'Unmute' : 'Mute'} aria-pressed={vox.muted}
            disabled={!vox.audioActive || vox.busy} onPress={vox.toggleMute}><CallIcon name="mic" off={vox.muted} /></Button><span>{vox.muted ? 'Unmute' : 'Mute'}</span></div>
          <div><Button className="vox-end-call" variant="danger" iconOnly aria-label="End call" disabled={vox.busy} onPress={() => operation(endCall)}>
            <CallIcon name="end" /></Button><span>End call</span></div>
          <div><Button className="vox-call-control" variant="secondary" iconOnly aria-label={vox.speakerMuted ? 'Unmute speaker' : 'Mute speaker'} aria-pressed={vox.speakerMuted}
            disabled={!vox.audioActive || vox.busy} onPress={vox.toggleSpeaker}><CallIcon name="speaker" off={vox.speakerMuted} /></Button><span>Speaker</span></div>
        </div>
        <div className="vox-call-options">
          <Button variant="ghost" size="sm" disabled={vox.busy} onPress={() => operation(vox.audioActive || vox.audioConnecting ? vox.stopAudio : vox.startAudio)}>
            {vox.audioActive || vox.audioConnecting ? 'Disconnect microphone' : 'Connect microphone'}</Button>
          {vox.playbackBlocked && <Button variant="ghost" size="sm" onPress={() => operation(vox.play)}>Play replies</Button>}
          {vox.phase === 'thinking' && <Button variant="ghost" size="sm" onPress={() => operation(vox.interrupt)}>Interrupt reply</Button>}
        </div>
      </>}
    </aside>}
  </div>
}
