import { useEffect, useState } from 'react'
import { Button, CommandSearch, Icon, type CommandItem } from 'bbb-design'
import { HomeSheet } from './HomeDetails'

export function HomeSearch({ items, onAction }: { items: CommandItem[]; onAction: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
  function show() { setQuery(''); setOpen(true) }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k' ||
        event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]') || document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      event.preventDefault(); setQuery(''); setOpen(true)
    }
    document.addEventListener('keydown', shortcut)
    return () => document.removeEventListener('keydown', shortcut)
  }, [])
  return <>
    <Button variant="ghost" className="home-search-trigger" aria-label="Search workspace" onPress={show}><Icon name="search" /><span>Search workspace</span><kbd>{modifier} K</kbd></Button>
    {open && <HomeSheet title="Search workspace" centered closeLabel="Close search" onClose={() => setOpen(false)}>
      <CommandSearch label="Search workspace" autoFocus query={query} onQueryChange={setQuery}
        placeholder="Find work, projects, or an action…" items={items} onAction={id => { setOpen(false); onAction(id) }} />
    </HomeSheet>}
  </>
}
