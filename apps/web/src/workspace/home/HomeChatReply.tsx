import { useRef, useState, useSyncExternalStore } from 'react'
import { Button, Icon, Select, Textarea } from 'bbb-design'
import { useContentFieldVariant } from '../../branding/ContentTheme'
import { resolvePromptReferences } from '../../chats/fileReferences'
import { messageTimingOptions } from '../../chats/messageTiming'
import type { ChatSnapshot } from '../../chats/model'
import type { Workspace } from '../model'

export function HomeChatReply({ chat, workspace: w, disabled, onSend }: {
  chat: ChatSnapshot; workspace: Workspace; disabled: boolean
  onSend: (op: 'chat-send' | 'chat-steer' | 'chat-queue', args: Record<string, unknown>, onSent: () => void) => Promise<boolean>
}) {
  const fieldVariant = useContentFieldVariant()
  const composer = w.chatComposers.forConversation(chat.id, chat.project)
  const draft = useSyncExternalStore(composer.draft.subscribe, composer.draft.getSnapshot)
  const state = useSyncExternalStore(composer.subscribe, composer.getSnapshot)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const latestChat = useRef(chat); latestChat.current = chat
  const activeTurn = ['running', 'waiting'].includes(chat.status)
  const managed = chat.backendRoute === 'managed'
  const canSteer = !managed || Boolean(chat.chatCapabilities?.steer)
  const canQueue = !managed || Boolean(chat.chatCapabilities?.queue)
  const timing = canSteer ? state.configuration.followupMode ?? 'steer' : 'queue'
  const showTiming = canQueue && (activeTurn || Boolean(chat.queue?.messages.length))
  const blocked = disabled || preparing || state.sending || state.actionBusy || Boolean(state.pendingAttempt)
  const sendLabel = showTiming && timing === 'queue' ? 'Send after this turn' : activeTurn ? 'Add to current turn' : 'Send message'

  async function send() {
    if (blocked || inFlight.current || !draft.prompt.trim()) return
    inFlight.current = true; setPreparing(true); setError('')
    try {
      const projectId = chat.projectId ?? w.projects.projects.find(project => project.name === chat.project)?.id
      const text = await resolvePromptReferences(draft.prompt.trim(), draft.inboxReferences, draft.fileReferences,
        projectId, w.carrier.request, w.agents.request)
      const current = latestChat.current
      const currentTurn = ['running', 'waiting'].includes(current.status)
      const op = timing === 'queue' && (currentTurn || current.queue?.messages.length) ? 'chat-queue' : currentTurn ? 'chat-steer' : 'chat-send'
      await onSend(op, { text, ...(op === 'chat-steer' ? { expectedTurnId: current.turnId } : op === 'chat-send' ? { followupMode: timing } : {}) }, () => {
        if (composer.draft.getSnapshot() === draft) composer.draft.set({ ...draft, prompt: '', inboxReferences: [], fileReferences: [] })
      })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not prepare this message.') }
    finally { inFlight.current = false; setPreparing(false) }
  }

  return <form className="home-reply" onSubmit={event => { event.preventDefault(); void send() }}>
    {showTiming && <Select label="Message timing" variant={fieldVariant} value={timing} options={messageTimingOptions(activeTurn, canSteer)}
      disabled={blocked} onChange={value => composer.configure({ followupMode: value as 'steer' | 'queue' })} />}
    <Textarea label={activeTurn ? 'Add a follow-up' : 'Continue the conversation'} variant={fieldVariant} rows={3} maxLength={32000}
      value={draft.prompt} onChange={event => composer.draft.set({ ...composer.draft.getSnapshot(), prompt: event.target.value })}
      placeholder="Give the agent a direction…" disabled={blocked} />
    {error && <p role="alert">{error}</p>}
    <Button type="submit" disabled={blocked || !draft.prompt.trim()} loading={preparing}>{sendLabel}<Icon name="arrow-right" /></Button>
  </form>
}
