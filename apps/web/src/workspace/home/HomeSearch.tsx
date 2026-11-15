import { Button, Icon } from 'bbb-design'

export function HomeSearch({ onPress }: { onPress: () => void }) {
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
  return <Button variant="ghost" className="home-search-trigger" aria-label="Search workspace" aria-keyshortcuts="Control+K Meta+K" onPress={onPress}>
    <Icon name="search" /><span>Search workspace</span><kbd>{modifier} K</kbd>
  </Button>
}
