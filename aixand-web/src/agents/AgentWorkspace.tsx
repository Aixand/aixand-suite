import { useEffect, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Button, Icon, Popover, Sheet, StatusIndicator, Tooltip } from 'bbb-design'
import type { AgentsModel } from './model'
import { CarrierListHeader } from '../carrier/CarrierListHeader'
import { WorkspaceTheme } from '../branding/ContentTheme'
import { requestResourceNavigation } from '../resources/editor/drafts'
import '../carrier/carrier.css'
import './workspace.css'

export type WorkspacePanes = {
  title: string
  description?: string
  list: ReactNode
  reader: ReactNode
  selected: boolean
  onBack: () => void
  actions?: ReactNode
  controls?: ReactNode
  primary?: { label: string; onPress: () => void; disabled?: boolean }
  error?: string
  notice?: string
}
export type WorkspaceRenderer = (panes: WorkspacePanes) => ReactNode

export function AgentWorkspace({ agents: a, navigation, panes, error, notice }: {
  agents: AgentsModel; navigation: ReactNode | ((close: () => void) => ReactNode); panes: WorkspacePanes; error?: string; notice?: string
}) {
  const [menu, setMenu] = useState(false)
  const reader = useRef<HTMLElement>(null)
  const list = useRef<HTMLElement>(null)
  const lastFocus = useRef<HTMLElement | null>(null)
  const previousSelection = useRef(false)
  const previousTitle = useRef(panes.title)
  const drawer = useRef<HTMLDivElement>(null)
  const drawerAction = useRef(false)
  const restoreFocus = useRef(false)
  const connected = a.status === 'connected'
  const status = connected ? 'Connected' : a.status === 'connecting' ? 'Connecting' : 'Disconnected'
  useEffect(() => {
    if (!panes.selected && previousSelection.current && restoreFocus.current) {
      restoreFocus.current = false
      requestAnimationFrame(() => {
        const target = lastFocus.current
        if (target?.isConnected && target.getClientRects().length) target.focus()
        else (list.current?.querySelector<HTMLElement>('.bbb-tree-view__item[data-selected], .bbb-tree-view__item[tabindex="0"]') ?? list.current?.querySelector<HTMLElement>('h1'))?.focus()
      })
    }
    if (panes.selected && !previousSelection.current) {
      if (!lastFocus.current && document.activeElement instanceof HTMLElement && document.activeElement !== document.body)
        lastFocus.current = document.activeElement
      if (window.matchMedia('(max-width: 760px)').matches)
        requestAnimationFrame(() => reader.current?.querySelector<HTMLElement>('h2')?.focus())
    }
    previousSelection.current = panes.selected
    if (previousTitle.current !== panes.title) {
      setMenu(false)
      previousTitle.current = panes.title
    }
  }, [panes.selected, panes.title])
  useEffect(() => {
    if (menu || !drawerAction.current) return
    let frame = 0
    function focusContent() {
      if (drawer.current) { frame = requestAnimationFrame(focusContent); return }
      drawerAction.current = false
      const target = panes.selected ? reader.current?.querySelector<HTMLElement>('input:not([type="hidden"]), h2') : list.current?.querySelector<HTMLElement>('h1')
      target?.focus()
    }
    frame = requestAnimationFrame(focusContent)
    return () => cancelAnimationFrame(frame)
  }, [menu, panes.selected, panes.title])
  function back() {
    requestResourceNavigation(() => { restoreFocus.current = true; panes.onBack() })
  }
  const closeNavigation = () => { drawerAction.current = true; setMenu(false) }
  const connection = <div className="carrier-connection-footer">
    <StatusIndicator label={status} tone={connected ? 'success' : 'neutral'} className="carrier-connection-status" />
    <Popover title="Agent Manager connection" trigger={<Button iconOnly variant="ghost" size="sm" aria-label="Agent Manager connection"><Icon name="ellipsis" /></Button>}>
      <div className="carrier-connection-details"><p>{status}</p>
        <Button variant="secondary" size="sm" onPress={connected ? a.disconnect : a.connect}>{connected ? 'Disconnect' : 'Reconnect'}</Button>
      </div>
    </Popover>
  </div>
  const mobileNavigation = <>
    <WorkspaceTheme><Sheet title="Agent navigation" side="start" open={menu} onOpenChange={setMenu}
      bodyClassName="carrier-mailbox-sheet-body" footer={connection}
      trigger={<Button className="carrier-menu-trigger" iconOnly variant="ghost" size="sm" aria-label="Open agent navigation"><Icon name="menu" /></Button>}>
      <div ref={drawer}>{typeof navigation === 'function' ? navigation(closeNavigation) : navigation}</div>
    </Sheet></WorkspaceTheme>
  </>
  return <div className="carrier-page agent-workspace" data-reader-open={panes.selected || undefined}>
    <div className="carrier-workspace">
      <WorkspaceTheme><aside className="carrier-sidebar" aria-label="Agent navigation">{typeof navigation === 'function' ? navigation(() => {}) : navigation}<footer className="carrier-sidebar-footer">{connection}</footer></aside></WorkspaceTheme>
      <div className="carrier-announcements">
        {(error || a.error) && <p role="alert" className="carrier-error">{error || a.error}</p>}
        {!connected && <div className="carrier-offline-banner"><span role="status">{a.status === 'connecting' ? 'Connecting to Agent Manager…' : 'Disconnected. Loaded profiles and transcripts remain available.'}</span>
          {a.status === 'offline' && <Button variant="ghost" size="sm" onPress={a.connect}>Reconnect</Button>}</div>}
      </div>
      <section className="carrier-list-pane" ref={list} aria-label={`${panes.title} list`} onClickCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>('.carrier-message-row, .bbb-tree-view__item')
        if (row) lastFocus.current = row
      }}>
        <CarrierListHeader title={panes.title} description={panes.description ?? ''} navigation={mobileNavigation} actions={<>
          {panes.primary && <Tooltip content={panes.primary.label}><Button className="agent-create" iconOnly variant="ghost" size="sm" aria-label={panes.primary.label}
            disabled={panes.primary.disabled} onPress={() => requestResourceNavigation(() => panes.primary?.onPress())}><Icon name="plus" /></Button></Tooltip>}
          {panes.actions}
        </>}>{panes.controls}</CarrierListHeader>
        {panes.list}
      </section>
      <article className="carrier-reader" ref={reader} aria-label="Agent details">
        <h1 className="bbb-visually-hidden agent-reader-title">{panes.title}</h1>
        <div className="carrier-mobile-back"><Button variant="ghost" size="sm" onPress={back}><Icon name="chevron-left" />Back to {panes.title.toLowerCase()}</Button></div>
        {panes.reader}
      </article>
    </div>
    <p role="status" className="carrier-notice">{notice}</p>
  </div>
}

export function PaneForm({ inline, headerActions, ...props }: ComponentProps<typeof Sheet> & { inline?: boolean; headerActions?: ReactNode }) {
  if (!inline) return <Sheet {...props} />
  const close = () => props.onOpenChange?.(false)
  return <section className="agent-inline-form" aria-label={typeof props.title === 'string' ? props.title : undefined}>
    <div className="carrier-reader-scroll"><div className="agent-form-heading"><h2 tabIndex={-1}>{props.title}</h2>{headerActions}
      <Button iconOnly variant="ghost" size="sm" aria-label="Close details" onPress={() => props.onOpenChange?.(false)}><Icon name="x" /></Button></div>
      {props.description && <p className="carrier-muted">{props.description}</p>}{typeof props.children === 'function' ? props.children(close) : props.children}</div>
    <footer className="agent-form-footer">{typeof props.footer === 'function' ? props.footer(close) : props.footer}</footer>
  </section>
}
