import { Button, Icon, Popover, StatusIndicator } from 'bbb-design'
import type { CarrierModel } from './model'

export function CarrierConnection({ carrier: c }: { carrier: CarrierModel }) {
  const online = c.status === 'connected' && Boolean(c.service?.connected)
  const label = c.status === 'connecting' ? 'Connecting' : c.status !== 'connected' ? 'Disconnected'
    : !c.service?.connected ? 'Offline · cached inbox' : c.service.syncing ? 'Syncing' : 'Connected'
  return <div className="carrier-connection-footer">
    <StatusIndicator label={label} tone={online ? 'success' : 'neutral'} className="carrier-connection-status" />
    <Popover title="Connection details" trigger={<Button variant="ghost" size="sm" iconOnly aria-label="Carrier connection"><Icon name="ellipsis" /></Button>}>
      <div className="carrier-connection-details">
        <StatusIndicator label={label} tone={online ? 'success' : 'warning'} />
        {c.service?.last_sync && <p>Last synced {new Date(c.service.last_sync * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>}
        <p>Disconnecting this inbox leaves your agents running.</p>
        <Button variant="secondary" size="sm" onPress={c.status === 'connected' ? c.disconnect : c.connect}>
          {c.status === 'connected' ? 'Disconnect' : 'Retry connection'}
        </Button>
      </div>
    </Popover>
  </div>
}
