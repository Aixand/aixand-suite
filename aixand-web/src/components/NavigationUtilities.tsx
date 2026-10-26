import { Button, DropdownMenu, Icon, ThemeSwitcher } from 'bbb-design'
import { useRef } from 'react'
import type { ThemeMode } from 'bbb-design'
import { reportRecovery } from '../recovery/events'

export function NavigationUtilities({
  mode,
  onModeChange,
  onNavigate,
  onSignOut,
  onOnboarding,
  onSetup,
}: {
  mode: ThemeMode
  onModeChange: (mode: ThemeMode) => void
  onNavigate: (route: string) => void
  onSignOut: () => Promise<void>
  onSetup?: () => void
  onOnboarding: (returnFocus?: HTMLElement, mode?: ThemeMode) => void
}) {
  const account = useRef<HTMLButtonElement>(null)
  return (
    <div
      className="navigation-rail__utilities"
      role="group"
      aria-label="Workspace controls"
    >
      <ThemeSwitcher
        value={mode}
        onChange={onModeChange}
        className="navigation-rail__utility"
      />
      <DropdownMenu
        label="Profile menu"
        className="navigation-account-menu"
        trigger={
          <Button
            ref={account}
            variant="ghost"
            iconOnly
            className="navigation-rail__utility"
            aria-label="Profile menu"
          >
            <Icon name="user-round" />
          </Button>
        }
        items={[
          { id: 'settings', label: 'Settings' },
          { id: 'recover-chat', label: 'Recover a chat' },
          ...(onSetup ? [{ id: 'setup', label: 'Set up workspace' }] : []),
          { id: 'onboarding', label: 'Onboarding' },
          { id: 'sign-out', label: 'Sign out', danger: true },
        ]}
        onAction={(id) => {
          if (id === 'setup') onSetup?.()
          if (id === 'settings') onNavigate('settings')
          if (id === 'recover-chat') reportRecovery({ kind: 'open' })
          if (id === 'onboarding')
            onOnboarding(account.current ?? undefined, mode)
          if (id === 'sign-out') void onSignOut()
        }}
      />
    </div>
  )
}
