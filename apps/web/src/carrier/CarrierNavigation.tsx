import { Badge, Button, Icon, Select } from 'bbb-design'
import type { IconName } from 'bbb-design'
import type { CarrierModel } from './model'
import { WorkspaceSidebarActions, WorkspaceSidebarBody, WorkspaceSidebarHeader } from '../components/WorkspaceSidebar'

export type CarrierSection = 'messages' | 'outbox' | 'agents' | 'delegated'

const folders: { view: string; label: string; icon: IconName }[] = [
  { view: 'Inbox', label: 'Inbox', icon: 'mail' },
  { view: 'Sent', label: 'Sent', icon: 'arrow-up' },
  { view: 'Archived', label: 'Archived', icon: 'box' },
  { view: 'Pending', label: 'To acknowledge', icon: 'check' },
]

export function CarrierNavigation({ carrier: c, section, activeRun, pendingCount, canCompose, hasDraft, onCompose, onMailbox, onView, onSection, onRun }: {
  carrier: CarrierModel
  section: CarrierSection
  activeRun: string
  pendingCount: number
  canCompose: boolean
  hasDraft: boolean
  onCompose: () => void
  onMailbox: (value: string) => void
  onView: (value: string) => void
  onSection: (section: CarrierSection) => void
  onRun: (key: string) => void
}) {
  const mailbox = c.mailboxes.find(item => item.id === c.mailbox)
  return <>
    <WorkspaceSidebarHeader title="Carrier" context={<div className="carrier-mailbox">
      {c.mailboxes.length > 1 ? <Select label="Mailbox" hideLabel value={c.mailbox} onChange={onMailbox}
        variant="plain" options={c.mailboxes.map(item => ({ id: item.id, label: item.name, description: item.address }))} />
        : <strong>{mailbox?.name ?? 'Workspace inbox'}</strong>}
      {mailbox?.address && <span title={mailbox.address}>{mailbox.address}</span>}
    </div>} />
    <WorkspaceSidebarActions>
      <Button variant="ghost" className="workspace-sidebar__action carrier-compose-button" disabled={!canCompose && !hasDraft} onPress={onCompose}>
        <Icon name={hasDraft ? 'file-text' : 'plus'} /><span>{hasDraft ? 'Resume draft' : 'Compose'}</span>
      </Button>
    </WorkspaceSidebarActions>
    <WorkspaceSidebarBody className="workspace-sidebar__navigation">
      <div className="workspace-sidebar__group" role="group" aria-label="Inbox filters">
        {folders.map(folder => {
          const selected = section === 'messages' && (c.view === folder.view || folder.view === 'Inbox' && c.view === 'Unread')
          const count = folder.view === 'Inbox' ? c.counts.Unread : folder.view === 'Pending' ? c.counts.Pending : 0
          return <Button key={folder.view} variant="ghost" className="workspace-sidebar__item" aria-pressed={selected} onPress={() => onView(folder.view)}>
            <Icon name={folder.icon} /><span>{folder.label}</span>{Boolean(count) && <span className="workspace-sidebar__count">{count}</span>}
          </Button>
        })}
        <Button variant="ghost" className="workspace-sidebar__item" aria-pressed={section === 'outbox'} onPress={() => onSection('outbox')}>
          <Icon name="arrow-right" /><span>Outbox</span>{pendingCount > 0 && <Badge tone="warning">{pendingCount}</Badge>}
        </Button>
      </div>
      <div className="carrier-agent-navigation">
        <Button variant="ghost" className="workspace-sidebar__section-heading carrier-navigation-heading" aria-pressed={section === 'delegated'} onPress={() => onSection('delegated')}>
          <span>Delegated work</span><Icon name="chevron-right" />
        </Button>
        <Button variant="ghost" className="workspace-sidebar__section-heading carrier-navigation-heading" aria-pressed={section === 'agents'} onPress={() => onSection('agents')}>
          <span>Agent conversations</span><Icon name="chevron-right" />
        </Button>
        {c.runs.slice(0, 5).map(run => <Button key={run.key} variant="ghost" className="carrier-agent-link"
          aria-pressed={section === 'agents' && activeRun === run.key} onPress={() => onRun(run.key)}>
          <span className="carrier-agent-dot" data-active={run.status === 'active'} aria-hidden="true" />
          <span><strong>{run.profile}</strong><small>{run.prompt.split('\n')[0]}</small></span>
        </Button>)}
        {!c.runs.length && <p className="carrier-navigation-note">Your agent conversations will appear here.</p>}
        {c.runs.length > 5 && <Button variant="ghost" size="sm" onPress={() => onSection('agents')}>View all conversations</Button>}
      </div>
    </WorkspaceSidebarBody>
  </>
}
