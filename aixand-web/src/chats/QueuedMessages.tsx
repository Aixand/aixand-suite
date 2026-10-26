import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from 'bbb-design'
import type { ChatQueue, QueuedMessage } from './model'
import { requestId } from '../terminals/connection'
import { MessageContent } from './MessageContent'
import { sourceLabel, sourceMessageText } from './sourceMessage'

export function QueuedMessages({ queue, chatId, disabled, onEdit, onRemove, onResume }: {
  queue?: ChatQueue
  chatId: string
  disabled: boolean
  onEdit: (args: object) => Promise<unknown>
  onRemove: (args: object) => Promise<unknown>
  onResume: (args: object) => Promise<unknown>
}) {
  const [editing, setEditing] = useState<{ message: QueuedMessage; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const attempt = useRef<{ op: 'edit' | 'remove' | 'resume'; args: object } | null>(null)
  useEffect(() => { if (editing && !queue?.messages.some((message) => message.id === editing.message.id)) setEditing(null) }, [queue, editing])
  if (!queue?.messages.length) return null

  async function act(op: 'edit' | 'remove' | 'resume', args: object) {
    if (busy) return
    const operation = attempt.current ?? { op, args: { key: requestId(), chatId, ...args } }
    attempt.current = operation
    setBusy(true); setError('')
    try {
      await (operation.op === 'edit' ? onEdit : operation.op === 'remove' ? onRemove : onResume)(operation.args)
      attempt.current = null
      setEditing(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update the queue.') }
    finally { setBusy(false) }
  }
  const unavailable = disabled || busy
  return <section className="command-queue" aria-label="Queued messages">
    <div className="command-queue-heading">
      <strong>{queue.paused ? 'Queue paused' : 'Send after this turn'} <span>({queue.messages.length})</span></strong>
      {queue.paused && <Button variant="ghost" size="sm" disabled={unavailable || Boolean(attempt.current) || queue.messages.some((message) => message.status === 'uncertain')}
        onPress={() => { void act('resume', {}) }}>Resume queue</Button>}
    </div>
    {queue.paused && queue.reason && <p role="status">{queue.reason}</p>}
    <ol className="command-queue-list">
      {queue.messages.map((message) => <li key={message.id}>
        {editing?.message.id === message.id ? <form onSubmit={(event) => { event.preventDefault(); void act('edit', {
          messageId: message.id, expectedRevision: editing.message.revision, text: editing.text.trim(),
        }) }}>
          <textarea aria-label="Edit queued message" rows={2} maxLength={32000} value={editing.text} readOnly={unavailable || Boolean(attempt.current)}
            onChange={(event) => setEditing({ ...editing, text: event.target.value })} autoFocus />
          <div className="command-queue-actions">
            <Button type="submit" size="sm" disabled={unavailable || Boolean(attempt.current) || !editing.text.trim()}>Save message</Button>
            <Button variant="ghost" size="sm" disabled={busy || Boolean(attempt.current)} onPress={() => setEditing(null)}>Cancel</Button>
          </div>
        </form> : <>
          <div className="command-queue-text"><MessageContent text={sourceMessageText(message.text, message.source)} /></div>
          {message.source && <small>{sourceLabel(message.source)} {message.source.url ? <a href={message.source.url}>{message.source.title}</a> : message.source.title}</small>}
          <div className="command-queue-actions">
            {message.status === 'queued' && message.source?.messageType !== 'delegation_result' && <Button variant="ghost" size="sm" disabled={unavailable || Boolean(attempt.current)}
              onPress={() => { setError(''); setEditing({ message, text: message.text }) }}>Edit queued message</Button>}
            <Button variant="ghost" size="sm" disabled={unavailable || Boolean(attempt.current) || message.status === 'sending'}
              onPress={() => { void act('remove', { messageId: message.id, expectedRevision: message.revision }) }}>
              <Icon name="trash-2" />Remove queued message
            </Button>
            {message.status !== 'queued' && <span role="status">{message.status === 'sending' ? 'Sending…' : 'Delivery unconfirmed'}</span>}
          </div>
          {message.error && <p>{message.error}</p>}
        </>}
      </li>)}
    </ol>
    {error && <div className="command-queue-actions"><p role="alert">{error}</p>
      <Button variant="ghost" size="sm" disabled={unavailable} onPress={() => { if (attempt.current) void act(attempt.current.op, attempt.current.args) }}>Retry queue update</Button>
      <Button variant="ghost" size="sm" disabled={busy} onPress={() => { attempt.current = null; setError(''); setEditing(null) }}>Dismiss</Button>
    </div>}
  </section>
}
