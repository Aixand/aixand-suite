import { Button, Icon } from 'bbb-design'
import type { ChatLaunch } from './model'
import { permissionLabel } from '../agents/permissions'
import { ProfileResolution } from '../agents/profileSelection'

const labels: Record<string, string> = {
  prepared: 'Preparing…', creating: 'Creating chat…', created: 'Chat created', starting: 'Starting task…',
  running: 'Running', waiting: 'Waiting for your response', completed: 'Completed', interrupted: 'Stopped',
  failed: 'Failed', uncertain: 'Inspect launch outcome', offline: 'Reconnect to check progress', ready: 'Ready',
}
const deliveryLabels: Record<string, string> = {
  waiting: 'The result will return here automatically.', pending: 'Result awaiting delivery', queued: 'Result queued for this chat',
  paused: 'Result delivery paused', accepted: 'Result delivered', processing: 'Processing returned result',
  processed: 'Returned result processed', parent_failed: 'Parent processing stopped', uncertain: 'Inspect result delivery',
  cancelled: 'Result return cancelled', removed: 'Result removed from the queue',
}

export function LaunchCards({ launches, connected, onOpen }: {
  launches: ChatLaunch[]
  connected: boolean
  onOpen: (chatId: string) => void
}) {
  launches = launches.filter((launch) => launch.attached !== false)
  if (!launches.length) return null
  return <section className="command-launches" aria-label="Project investigations">
    <h2>Spawned sessions</h2>
    {launches.map((launch) => <article className="command-launch-card" key={launch.id} aria-label={launch.title}>
      <div className="command-launch-heading"><Icon name="eye" /><strong>{launch.title}</strong></div>
      <p className="command-launch-context">{launch.project} · {permissionLabel(launch.permissionMode ?? 'read-only')}{launch.permissionSource ? ` · ${launch.permissionSource}` : ''}</p>
      {launch.profileSelection && <ProfileResolution requested={launch.profileSelection} decision={launch.profileDecision} />}
      <p role="status">{!connected && ['running', 'waiting', 'creating', 'starting'].includes(launch.status) ? 'Reconnect to check progress' : labels[launch.status] ?? launch.status}</p>
      {launch.resultDelivery && <p aria-live="polite" aria-label="Result delivery">{deliveryLabels[launch.resultDelivery.state] ?? launch.resultDelivery.state}
        {launch.resultDelivery.outcome === 'failed' && ' · Task failed'}</p>}
      {launch.resultDelivery?.error && <p className="command-launch-error">{launch.resultDelivery.error}</p>}
      {launch.error && <p className="command-launch-error">{launch.error}</p>}
      {launch.resultPreview && <p className="command-launch-result" tabIndex={0} aria-label="Investigation result">{launch.resultPreview}</p>}
      <details><summary>Task instructions</summary><p className="command-launch-instruction">{launch.instruction}</p></details>
      {launch.url && <Button variant="ghost" size="sm" onPress={() => onOpen(launch.chatId)}>
        {launch.needsInput ? 'Open chat to respond' : 'Open chat'}<Icon name="arrow-right" />
      </Button>}
    </article>)}
  </section>
}
