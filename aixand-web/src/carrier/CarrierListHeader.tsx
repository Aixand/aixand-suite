import type { ReactNode } from 'react'

export function CarrierListHeader({ title, description, navigation, actions, children }: {
  title: string
  description: string
  navigation?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return <header className="carrier-list-heading">
    <div className="carrier-list-title-row">
      {navigation}
      <h1 data-carrier-list-title tabIndex={-1}>{title}</h1>
      {actions}
    </div>
    {description && <p className="carrier-list-description">{description}</p>}
    {children}
  </header>
}
