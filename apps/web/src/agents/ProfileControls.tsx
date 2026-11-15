import type { ComponentProps } from 'react'
import { useState } from 'react'
import { Button, Icon, Popover, Tooltip } from 'bbb-design'

export function ProfileIconAction({ label, icon, ...props }: Omit<ComponentProps<typeof Button>, 'children'> & {
  label: string; icon: ComponentProps<typeof Icon>['name']
}) {
  return <Tooltip content={label}><Button type="button" variant="ghost" size="sm" iconOnly {...props} aria-label={label}>
    <Icon name={icon} />
  </Button></Tooltip>
}

export function ProfileStatus({ label, tone = 'neutral', text }: { label: string; tone?: 'success' | 'warning' | 'neutral' | 'pending'; text?: string }) {
  const [open, setOpen] = useState(false)
  return <Popover title={text ? `${text} status` : 'Status details'} open={open} onOpenChange={setOpen}
    trigger={<Tooltip content={label} disabled={open}><Button type="button" variant="ghost" size="sm" iconOnly={!text}
      className={`agent-status-icon${text ? ' agent-status-pill' : ''}`} data-tone={tone} aria-label={label}>
      {text && <span>{text}</span>}<Icon name={tone === 'success' ? 'circle-check' : tone === 'warning' ? 'triangle-alert' : tone === 'pending' ? 'refresh-cw' : 'info'} />
    </Button></Tooltip>}>
    <p className="agent-status-details">{label}</p>
  </Popover>
}
