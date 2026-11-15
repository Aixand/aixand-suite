import type { ReactNode } from 'react'
import { Icon, useThemeAttributes } from 'bbb-design'
import './content-disclosure.css'

/** Optional dark-content details. Children remain mounted to retain drafts. */
export function ContentDisclosure({ title, children, defaultOpen = false, enabled, className = '' }: {
  title: string; children: ReactNode; defaultOpen?: boolean; enabled?: boolean; className?: string
}) {
  const dark = useThemeAttributes()['data-bbb-mode'] === 'dark'
  if (!(enabled ?? dark)) return <>{children}</>
  return <details className={`content-disclosure ${className}`} open={defaultOpen || undefined}>
    <summary>{title}<Icon name="chevron-down" /></summary>
    <div className="content-disclosure-body">{children}</div>
  </details>
}
