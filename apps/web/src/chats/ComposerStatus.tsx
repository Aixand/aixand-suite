import { useEffect, useId, useRef, useState } from 'react'
import { Button, Icon, useThemeAttributes, type IconName } from 'bbb-design'
import { Dialog, DialogTrigger, Heading, Popover } from 'react-aria-components'
import { orderedComposerNotices, type ComposerStatusNotice } from './composerNotices'
import './ComposerStatus.css'

const icons: Record<ComposerStatusNotice['tone'], IconName> = {
  info: 'info', success: 'circle-check', warning: 'triangle-alert', error: 'triangle-alert',
}

export function ComposerStatus({ notices }: { notices: ComposerStatusNotice[] }) {
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const summary = useRef<HTMLButtonElement>(null)
  const listId = useId()
  // Routine background activity and confirmations should not add UI to the composer.
  const ordered = orderedComposerNotices(notices.filter(notice => notice.tone === 'warning' || notice.tone === 'error'))
  const selectedExists = ordered.some(notice => `${notice.id}:${notice.title}:${notice.scope ?? ''}` === selected)
  useEffect(() => { if (selected && !selectedExists) setSelected(null) }, [selected, selectedExists])
  const count = ordered.length
  useEffect(() => { if (!count) setExpanded(false) }, [count])
  if (!ordered.length) return null
  const errors = ordered.filter(notice => notice.tone === 'error').length
  const kind = errors === count ? 'error' : errors ? 'issue' : 'warning'
  const label = `${count} ${kind}${count === 1 ? '' : 's'}`
  return <section className="command-composer-status" data-tone={errors ? 'error' : 'warning'} role="group" aria-label="Composer notices"
    onKeyDown={event => {
      if (event.key === 'Escape' && expanded && !selected) {
        event.stopPropagation(); setExpanded(false); summary.current?.focus()
      }
    }}>
    <Button ref={summary} type="button" variant="ghost" size="sm" className="command-composer-status-summary"
      aria-label={label} aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
      onPress={() => { setExpanded(value => !value); setSelected(null) }}>
      <Icon name="triangle-alert" />
      <span role={expanded ? undefined : errors ? 'alert' : 'status'} aria-atomic="true">{label}</span>
      <Icon name="chevron-down" className="command-composer-status-chevron" />
    </Button>
    {expanded && <ul id={listId} className="command-composer-status-list">
      {ordered.map(notice => {
        const key = `${notice.id}:${notice.title}:${notice.scope ?? ''}`
        return <li key={key}><StatusNotice notice={notice} open={selected === key}
          onOpenChange={open => setSelected(current => open ? key : current === key ? null : current)} /></li>
      })}
    </ul>}
  </section>
}

function StatusNotice({ notice, open, onOpenChange }: { notice: ComposerStatusNotice; open: boolean; onOpenChange: (open: boolean) => void }) {
  const theme = useThemeAttributes()
  const trigger = useRef<HTMLButtonElement>(null)
  const label = notice.label ?? (notice.tone === 'error' ? 'Error details' : 'Warning details')
  return <div className={`command-composer-status-item${notice.className ? ` ${notice.className}` : ''}`} data-tone={notice.tone}
    role="group" aria-label={notice.label ?? 'Composer status'}>
    <DialogTrigger isOpen={open} onOpenChange={onOpenChange}>
      <Button ref={trigger} type="button" variant="ghost" size="sm" className="command-composer-status-trigger" aria-label={notice.title}>
        <Icon name={icons[notice.tone]} />
        <span className="command-composer-status-title" role={notice.tone === 'error' ? 'alert' : 'status'} aria-atomic="true">{notice.title}</span>
        <Icon name="chevron-right" className="command-composer-status-chevron" />
      </Button>
      <Popover {...theme} isNonModal placement="top start" offset={8} containerPadding={12}
        shouldCloseOnInteractOutside={target => !trigger.current?.contains(target)}
        className="bbb-theme bbb-floating-surface command-composer-status-popover" data-tone={notice.tone}>
        <Dialog className="command-composer-status-dialog">
          {({ close }) => <>
            <div className="command-composer-status-heading">
              <Heading slot="title">{label}</Heading>
              <Button type="button" variant="ghost" size="sm" iconOnly aria-label="Close notice details" onPress={close}><Icon name="x" /></Button>
            </div>
            <div className="command-composer-status-details" tabIndex={0} role="region" aria-label="Notice details">
              <p className="command-composer-status-message">{notice.title}</p>
              {notice.description && <p>{notice.description}</p>}
              {notice.details && notice.details !== notice.title && <div className="command-composer-status-technical">
                <h3>{notice.detailsLabel ?? 'Technical details'}</h3><p>{notice.details}</p>
              </div>}
            </div>
            {Boolean(notice.actions?.length) && <div className="command-composer-status-actions">
              {notice.actions?.map(action => <Button key={action.label} type="button" variant="ghost" size="sm" disabled={action.disabled}
                onPress={() => { close(); action.onPress() }}>{action.label}</Button>)}
            </div>}
          </>}
        </Dialog>
      </Popover>
    </DialogTrigger>
  </div>
}
