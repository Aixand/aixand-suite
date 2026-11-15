import { useEffect, useRef } from 'react'
import { Button, Combobox, Icon, Textarea } from 'bbb-design'
import type { CarrierMessage } from './client'
import type { CarrierModel } from './model'
import { useContentFieldVariant } from '../branding/ContentTheme'

export type CarrierDraft = {
  mailbox: string
  recipient: string
  body: string
  key: string
  attempted: boolean
  replyMessage?: CarrierMessage
}

export function CarrierComposer({ carrier: c, draft, busy, online, onChange, onSend, onClose, onDiscard, onEdit }: {
  carrier: CarrierModel
  draft: CarrierDraft
  busy: boolean
  online: boolean
  onChange: (draft: CarrierDraft) => void
  onSend: () => void
  onClose: () => void
  onDiscard: () => void
  onEdit: () => void
}) {
  const fieldVariant = useContentFieldVariant()
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { bodyRef.current?.focus({ preventScroll: true }) }, [])
  const reply = Boolean(draft.replyMessage)
  return <form className={`carrier-composer${reply ? ' carrier-composer--reply' : ''}`} aria-label={reply ? 'Reply to message' : 'New message'}
    onSubmit={event => { event.preventDefault(); onSend() }}>
    <div className="carrier-composer-heading"><h2>{reply ? 'Reply' : 'New message'}</h2>
      <Button variant="ghost" size="sm" iconOnly aria-label="Close composer" disabled={busy} onPress={onClose}><Icon name="x" /></Button></div>
    <p className="carrier-compose-from">From: {c.mailboxes.find(item => item.id === draft.mailbox)?.name ?? 'Workspace inbox'}</p>
    <Combobox label="To address" options={c.recipients.map(item => ({ id: item.address, label: item.address, description: item.name ?? undefined }))}
      allowsCustomValue isRequired inputValue={draft.recipient} disabled={draft.attempted || reply}
      selectedKey={c.recipients.some(item => item.address === draft.recipient) ? draft.recipient : null}
      onInputChange={recipient => onChange({ ...draft, recipient })}
      onSelectionChange={key => { if (key !== null) onChange({ ...draft, recipient: String(key) }) }}
      placeholder="Search recipients or enter an address" variant={fieldVariant} emptyMessage="Enter the recipient’s address to send a message." />
    {c.recipientCursor && !reply && <Button variant="ghost" size="sm" onPress={() => {
      void c.directory(c.recipientCursor!).catch((error: Error) => c.setError(error.message))
    }}>Load more recipients</Button>}
    <Textarea ref={bodyRef} label="Message" hideLabel required rows={reply ? 5 : 12} maxLength={100_000}
      variant="plain" placeholder={reply ? 'Write your reply…' : 'Write your message…'} value={draft.body} disabled={draft.attempted}
      onChange={event => onChange({ ...draft, body: event.target.value })} />
    {draft.attempted && !busy && <p className="carrier-composer-help">Send confirmation is pending. Retry keeps the original message and send reference. Check Outbox before editing as a new message; the original may still arrive.</p>}
    {c.error && <p role="alert" className="carrier-error">{c.error}</p>}
    {!online && <p className="carrier-composer-help">Your draft is kept here while the inbox is offline. Reconnect to send it.</p>}
    <div className="carrier-composer-actions">
      <Button type="submit" disabled={!online || busy || !draft.recipient.trim() || !draft.body.trim()} loading={busy}>
        <Icon name="arrow-up" />{busy ? 'Sending…' : draft.attempted ? 'Retry same send' : 'Send message'}</Button>
      {draft.attempted ? <Button variant="ghost" disabled={busy} onPress={onEdit}>Edit as new message</Button>
        : <Button variant="ghost" disabled={busy} onPress={onDiscard}>Discard</Button>}
      <span className="carrier-draft-label">{draft.attempted ? 'Confirmation pending' : 'Draft'}</span>
    </div>
  </form>
}
