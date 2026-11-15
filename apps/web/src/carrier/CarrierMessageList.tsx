import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, EmptyState, FilterGroup, Icon, SearchField, Tooltip } from 'bbb-design'
import type { CarrierMessage } from './client'
import type { CarrierModel } from './model'
import { CarrierListHeader } from './CarrierListHeader'
import { PageLoading } from '../components/PageLoading'

export function messageTime(value: string) {
  const date = new Date(value)
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function dateGroup(value: string) {
  const date = new Date(value).toDateString()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  return date === new Date().toDateString() ? 'Today' : date === yesterday.toDateString() ? 'Yesterday' : 'Earlier'
}

function messagePreview(item: CarrierMessage) {
  const lines = item.body.trim().split('\n')
  if (lines[0]?.trim() === item.title.trim()) lines.shift()
  return lines.join(' ').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180)
}

export function CarrierMessageList({ carrier: c, activeId, navigation, onSelect, onView, onSearch, onPrevious, onNext, onRefresh }: {
  carrier: CarrierModel
  activeId: string
  navigation?: ReactNode
  onSelect: (message: CarrierMessage) => void
  onView: (view: string) => void
  onSearch: (query: string) => void
  onPrevious: () => void
  onNext: () => void
  onRefresh: () => void
}) {
  const [searchOpen, setSearchOpen] = useState(Boolean(c.search))
  const searchRef = useRef<HTMLInputElement>(null)
  const searchTriggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus()
  }, [searchOpen])
  function closeSearch() {
    onSearch('')
    setSearchOpen(false)
    requestAnimationFrame(() => searchTriggerRef.current?.focus())
  }
  const inbox = ['Inbox', 'Unread'].includes(c.view)
  const folder = c.view === 'Pending' ? 'To acknowledge' : inbox ? 'Inbox' : c.view
  const title = c.search ? 'Search results' : folder
  const initialLoading = !c.messages.length && (c.loading || c.status === 'connecting')
  return <>
    <CarrierListHeader title={title} description={initialLoading ? '' : `${c.total} ${c.total === 1 ? 'message' : 'messages'}`} navigation={navigation}
      actions={<>
        <Tooltip content={searchOpen ? 'Close search' : 'Search messages'}><Button ref={searchTriggerRef} variant="ghost" size="sm" iconOnly
          aria-label={searchOpen ? 'Close message search' : 'Search messages'} aria-expanded={searchOpen}
          onPress={() => { if (searchOpen) closeSearch(); else setSearchOpen(true) }}><Icon name={searchOpen ? 'x' : 'search'} /></Button></Tooltip>
        <Tooltip content="Refresh messages"><Button variant="ghost" size="sm" iconOnly aria-label="Refresh messages"
        disabled={c.status !== 'connected' || c.loading} onPress={onRefresh}><Icon name="refresh-cw" /></Button></Tooltip>
      </>}>
      {searchOpen && <SearchField ref={searchRef} label="Search messages" placeholder={`Search ${folder.toLowerCase()}…`}
        value={c.search} onChange={onSearch} className="carrier-search" onKeyDown={event => {
          if (event.key === 'Escape' && !c.search) { event.preventDefault(); closeSearch() }
        }} />}
      {inbox && !c.search && !initialLoading && <FilterGroup label="Message filters" value={c.view} options={[{ value: 'Inbox', label: 'All', count: c.counts.Inbox ?? 0 }, { value: 'Unread', label: 'Unread', count: c.counts.Unread ?? 0 }]}
        onChange={onView} />}
      {c.search && <p className="carrier-list-search">Results for “{c.search}” in {c.view === 'Pending' ? 'To acknowledge' : c.view}</p>}
    </CarrierListHeader>
    <div className="carrier-message-scroll carrier-message-scroll--mail" aria-busy={c.loading}>
      {c.messages.map((item, index) => {
        const group = dateGroup(item.created_at)
        const unread = item.direction === 'incoming' && !item.read
        const preview = messagePreview(item)
        return <div key={item.id}>
          {(index === 0 || dateGroup(c.messages[index - 1].created_at) !== group) && <h2 className="carrier-date-group">{group}</h2>}
          <Button variant="ghost" className="carrier-message-row" data-message-id={item.id} data-unread={unread || undefined}
            aria-pressed={activeId === item.id} onPress={() => onSelect(item)}>
            <span className="carrier-row-top"><span className="carrier-row-sender">{item.direction === 'outgoing' ? `To: ${item.recipient}` : item.source}</span>
              <time dateTime={item.created_at} title={new Date(item.created_at).toLocaleString()}>{messageTime(item.created_at)}</time></span>
            <span className="carrier-row-title">{unread && <><span className="carrier-unread-dot" aria-hidden="true" /><span className="bbb-visually-hidden">Unread: </span></>}<span className="carrier-row-subject">{item.title}</span></span>
            {preview && <span className="carrier-row-preview">{preview}</span>}
          </Button>
        </div>
      })}
      {!c.messages.length && (c.loading || c.status === 'connecting'
        ? <PageLoading label="Loading your inbox…" size="panel" />
        : <EmptyState headingLevel={2} icon={c.search ? 'search' : 'mail'}
          title={c.search ? 'No matching messages' : c.view === 'Unread' ? 'You’re all caught up' : 'No messages here'}
          description={c.search ? 'Try another search or choose a different folder.' : c.status !== 'connected' ? 'Your messages will appear when the inbox reconnects.' : c.view === 'Pending' ? 'Messages awaiting acknowledgment will appear here.' : c.view === 'Sent' ? 'Messages you send will appear here.' : c.view === 'Archived' ? 'Archived messages remain available here.' : 'New messages will appear here automatically.'} />)}
    </div>
    {!initialLoading && <div className="carrier-pagination">
      <span aria-live="polite">{c.total ? `${c.offset + 1}–${c.offset + c.messages.length} of ${c.total}` : '0 messages'}</span>
      <Button variant="ghost" size="sm" iconOnly aria-label="Previous page" disabled={!c.offset || c.loading} onPress={onPrevious}><Icon name="chevron-left" /></Button>
      <Button variant="ghost" size="sm" iconOnly aria-label="Next page" disabled={c.nextOffset === null || c.loading} onPress={onNext}><Icon name="chevron-right" /></Button>
    </div>}
  </>
}
