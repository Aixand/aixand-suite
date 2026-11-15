import { useState } from 'react'
import { Badge, Button } from 'bbb-design'
import { fileSize, type Transfer } from './model'
import './connect.css'

const labels: Record<Transfer['status'], string> = { preparing: 'Preparing', sending: 'Sending', cancelling: 'Cancelling',
  cancelled: 'Cancelled', completed: 'Delivered and verified', failed: 'Failed', uncertain: 'Delivery unconfirmed' }

export function TransferCard({ transfer, connected, onAction }: {
  transfer: Transfer; connected: boolean; onAction?: (id: string, action: 'cancel' | 'check') => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = ['preparing', 'sending', 'cancelling'].includes(transfer.status)
  async function act(action: 'cancel' | 'check') {
    setBusy(true); setError('')
    try { await onAction?.(transfer.id, action) } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  return <article className="connect-transfer" aria-label={`File transfer: ${transfer.name}`}>
    <div className="connect-row"><strong>{transfer.name} → {transfer.device}</strong><Badge>{labels[transfer.status]}</Badge></div>
    <p className="connect-path">From project: <code>{transfer.source}</code></p>
    {active && <progress aria-label={`Transfer progress for ${transfer.name}`} max={Math.max(transfer.size, 1)} value={transfer.bytesSent} />}
    <p>{fileSize(transfer.bytesSent)} / {fileSize(transfer.size)}{transfer.status === 'preparing' ? ' · Checking the source file' : transfer.status === 'sending' && transfer.bytesSent >= transfer.size ? ' · Waiting for destination verification' : ''}</p>
    {transfer.destination && <p className="connect-path">Saved to <code>{transfer.destination}</code></p>}
    {transfer.status === 'completed' && <details><summary>Delivery details</summary><p className="connect-path">SHA-256: <code>{transfer.sha256}</code></p></details>}
    {transfer.error && <p>{transfer.error}</p>}
    {!connected && active && <p role="status">Connection lost. Progress will refresh when Suite reconnects.</p>}
    <div className="connect-row">
      {onAction && (active || transfer.status === 'uncertain') && <Button variant="ghost" size="sm" disabled={!connected || busy || transfer.status === 'cancelling'} onPress={() => { void act('cancel') }}>Cancel transfer</Button>}
      {onAction && transfer.status === 'uncertain' && <Button variant="secondary" size="sm" disabled={!connected || busy} onPress={() => { void act('check') }}>Check delivery</Button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </article>
}
