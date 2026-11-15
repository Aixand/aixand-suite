import type { ComponentProps, ReactNode } from 'react'
import { Icon, Link, useThemeAttributes } from 'bbb-design'
import type { IconName } from 'bbb-design'
import { Focusable, Tooltip, TooltipTrigger } from 'react-aria-components'
import { Mark } from './Mark'

export type NavigationDestination = {
  id: string
  label: string
  href: string
  icon: IconName
}

function NavigationHint({
  label,
  children,
}: {
  label: string
  children: ComponentProps<typeof Focusable>['children']
}) {
  const theme = useThemeAttributes()
  // BBB's tooltip wrapper does not expose timing. Use its React Aria primitive
  // and shared styling so rail hints can open quickly without changing other tips.
  return (
    <TooltipTrigger delay={100} closeDelay={0}>
      <Focusable>{children}</Focusable>
      <Tooltip
        {...theme}
        className="bbb-theme bbb-tooltip navigation-rail__hint"
        placement="right"
      >
        {label}
      </Tooltip>
    </TooltipTrigger>
  )
}

export function NavigationRail({
  destinations,
  currentId,
  onNavigate,
  utilities,
}: {
  destinations: NavigationDestination[]
  currentId: string
  onNavigate: (id: string) => void
  utilities: ReactNode
}) {
  return (
    <aside className="navigation-rail" aria-label="Workspace sidebar">
      <NavigationHint label="Aixand Home">
        <Link
          className="navigation-rail__brand"
          variant="quiet"
          href="#/home"
          aria-label="Aixand Home"
        >
          <Mark small />
        </Link>
      </NavigationHint>
      <nav
        className="navigation-rail__navigation"
        aria-label="Workspace navigation"
      >
        <ul>
          {destinations.map((destination) => (
            <li key={destination.id}>
              <NavigationHint label={destination.label}>
                <Link
                  className="navigation-rail__link"
                  variant="quiet"
                  href={destination.href}
                  aria-label={destination.label}
                  aria-current={
                    destination.id === currentId ? 'page' : undefined
                  }
                  onClick={(event) => {
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return
                    event.preventDefault()
                    onNavigate(destination.id)
                  }}
                >
                  <Icon name={destination.icon} className="navigation-rail__icon" />
                </Link>
              </NavigationHint>
            </li>
          ))}
        </ul>
      </nav>
      {utilities}
    </aside>
  )
}
