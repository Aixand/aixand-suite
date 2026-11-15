import type { ComponentPropsWithRef, ComponentPropsWithoutRef, ReactNode } from 'react'
import './WorkspaceSidebar.css'

// Features compose their own contents; the frame and its geometry stay shared.
export function WorkspaceSidebar({ className = '', children, footer, ...props }: ComponentPropsWithRef<'aside'> & {
  footer?: ReactNode
}) {
  return <aside {...props} className={`workspace-sidebar ${className}`}>
    {children}
    {footer && <footer className="workspace-sidebar__footer">{footer}</footer>}
  </aside>
}

export function WorkspaceSidebarHeader({ title, actions, context, className = '', ...props }: Omit<ComponentPropsWithRef<'div'>, 'title' | 'children'> & {
  title: string
  actions?: ReactNode
  context?: ReactNode
}) {
  return <div {...props} className={`workspace-sidebar__header ${className}`}>
    <div className="workspace-sidebar__heading">
      <h2 className="workspace-sidebar__title">{title}</h2>
      {actions && <div className="workspace-sidebar__tools">{actions}</div>}
    </div>
    {context && <div className="workspace-sidebar__context">{context}</div>}
  </div>
}

export function WorkspaceSidebarActions({ className = '', ...props }: ComponentPropsWithRef<'div'>) {
  return <div {...props} className={`workspace-sidebar__actions ${className}`} />
}

export function WorkspaceSidebarBody({ as: Tag = 'div', className = '', ...props }: ComponentPropsWithoutRef<'div'> & {
  as?: 'div' | 'nav'
}) {
  return <Tag {...props} className={`workspace-sidebar__body ${className}`} />
}
