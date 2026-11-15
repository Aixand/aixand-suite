import { useState } from 'react'
import { Button, Icon, Popover, Tooltip } from 'bbb-design'

export function SettingsHelp({ label, children }: { label: string; children: string }) {
  const [open, setOpen] = useState(false)
  return <Popover title={label} open={open} onOpenChange={setOpen} className="settings-info-popover"
    trigger={<Tooltip content={children} disabled={open}>
      <Button variant="ghost" size="sm" iconOnly className="settings-info-trigger" aria-label={`About ${label}`}><Icon name="info" /></Button>
    </Tooltip>}>
    <p className="settings-note">{children}</p>
  </Popover>
}
