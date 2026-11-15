import { Button, DropdownMenu, Icon, ThemeSwitcher } from 'bbb-design'
import type { ThemeMode } from 'bbb-design'
import { reportRecovery } from '../recovery/events'

export function NavigationUtilities({
  mode,
  onModeChange,
  onNavigate,
  onSignOut,
}: {
  mode: ThemeMode
  onModeChange: (mode: ThemeMode) => void
  onNavigate: (route: string) => void
  onSignOut: () => Promise<void>
}) {
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
          { id: 'sign-out', label: 'Sign out', danger: true },
        ]}
        onAction={(id) => {
          if (id === 'settings') onNavigate('settings')
          if (id === 'recover-chat') reportRecovery({ kind: 'open' })
          if (id === 'sign-out') void onSignOut()
        }}
      />
    </div>
  )
}
