import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { Button, Dialog, Icon, useThemeAttributes } from 'bbb-design'
import type { IconName } from 'bbb-design'
import { Popover } from 'react-aria-components'
import type { CarrierMessage, Mailbox } from '../carrier/client'
import { activeMention, mentionSlug, removeInboxReference, retainedReferences, type CarrierRequest, type InboxReference, type MessageSearch } from './inboxReferences'
import './inboxReferences.css'
import { removeFileReference, retainedFileReferences, type FileReference } from './fileReferences'
import { useComposerSuggestions, type ComposerContext } from './useComposerSuggestions'
import { mentionScore, readMentionRecents, rememberMention, type ComposerMentionGroup } from './composerMentions'
export type { ComposerMentionGroup } from './composerMentions'

type Option = { key: string; label: string; detail: string; icon?: IconName; choose: () => void; score?: number }

export function InboxComposerInput({ inputRef, value, references = [], fileReferences = [], context, mentionGroups = [], onChange, request, connection, placeholder, readOnly, onSubmit, onResolvingChange }: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  value: string
  references?: InboxReference[]
  fileReferences?: FileReference[]
  context?: ComposerContext
  mentionGroups?: ComposerMentionGroup[]
  onChange: (value: string, references: InboxReference[], files: FileReference[]) => void
  request: CarrierRequest
  connection: string
  placeholder: string
  readOnly: boolean
  onSubmit: () => void
  onResolvingChange?: (resolving: boolean) => void
}) {
  const theme = useThemeAttributes()
  const popoverRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [page, setPage] = useState<MessageSearch | null>(null)
  const [offset, setOffset] = useState(0)
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [directoryError, setDirectoryError] = useState('')
  const [messageLoading, setMessageLoading] = useState(false)
  const [messageError, setMessageError] = useState('')
  const [error, setError] = useState('')
  const [index, setIndex] = useState(0)
  const [recents, setRecents] = useState(readMentionRecents)
  const [resolving, setResolving] = useState(false)
  const [insertionError, setInsertionError] = useState('')
  const live = useRef({ value, scope: context?.scope, onResolvingChange })
  live.current = { value, scope: context?.scope, onResolvingChange }
  const insertion = useRef(0)
  const requestRef = useRef(request)
  requestRef.current = request
  const extra = useComposerSuggestions(context, value, caret, focused && !readOnly, fileReferences, (text, files, position) => {
    onChange(text, retainedReferences(text, references), files)
    setCaret(position); setIndex(0); setDismissed(null)
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(position, position) })
  })
  const mention = focused && !readOnly ? activeMention(value, caret, ['inbox', ...(context ? ['file'] : []), ...mentionGroups.flatMap((group) => [group.id, ...(group.aliases ?? [])])]) : null
  const signature = extra.active ? extra.signature : mention ? `${mention.start}:${mention.token}` : ''
  const open = Boolean(!resolving && (extra.active || mention) && dismissed !== signature && !references.some((reference) => reference.token === mention?.token))
  const commandsContext = useRef(context); commandsContext.current = context
  useEffect(() => { if (open && extra.commandMode) commandsContext.current?.onCommandsOpen() }, [open, extra.commandMode, context?.scope])
  const parts = /^@([^/:]*)([/:]?)(.*)$/.exec(mention?.token ?? '')
  const namespace = parts?.[1].toLowerCase() ?? ''
  const query = parts?.[3] ?? ''
  const group = mentionGroups.find((item) => item.id === namespace || item.aliases?.includes(namespace))
  const selector = query.indexOf(':')
  const stage = parts?.[2] && group ? 'setting' : namespace === 'inbox' && parts?.[2] === '/' ? selector < 0 ? 'mailbox' : 'message' : 'root'
  const settingGroupId = stage === 'setting' ? group?.id : undefined
  const browseInbox = namespace === 'inbox' && (stage === 'mailbox' || stage === 'message')
  const mailboxQuery = selector < 0 ? query : query.slice(0, selector)
  const availableMailboxes = browseInbox ? mailboxes : context?.mailboxes ?? mailboxes
  const matchingNames = availableMailboxes.filter((mailbox) => mentionSlug(mailbox.name) === mailboxQuery)
  const selectedMailbox = availableMailboxes.find((mailbox) => encodeURIComponent(mailbox.id) === mailboxQuery) ?? (matchingNames.length === 1 ? matchingNames[0] : undefined)
  const search = selector < 0 ? '' : query.slice(selector + 1).slice(0, 300)
  const loading = extra.active ? extra.loading : stage === 'setting' ? group?.loading : browseInbox && (directoryLoading || (stage === 'message' && messageLoading))
  const displayError = extra.active ? extra.error : error || (browseInbox ? directoryError || (stage === 'message' ? messageError : '') : '')

  useEffect(() => {
    insertion.current++; setResolving(false); live.current.onResolvingChange?.(false); setInsertionError('')
    return () => { insertion.current++; live.current.onResolvingChange?.(false) }
  }, [context?.scope])

  useEffect(() => {
    if (!open || extra.active) return
    for (const item of stage === 'root' ? mentionGroups.filter(item => !item.browseOnly) : group ? [group] : []) item.onOpen?.()
  }, [open, stage, settingGroupId, context?.scope])

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const selectionChanged = () => {
      if (document.activeElement === input) setCaret(input.selectionStart === input.selectionEnd ? input.selectionStart : -1)
    }
    // React's onSelect does not cover every programmatic/mobile caret move.
    input.addEventListener('select', selectionChanged)
    document.addEventListener('selectionchange', selectionChanged)
    return () => { input.removeEventListener('select', selectionChanged); document.removeEventListener('selectionchange', selectionChanged) }
  }, [inputRef])

  useEffect(() => { setOffset(0); setIndex(0); setPage(null); setError('') }, [signature])
  useEffect(() => {
    setDirectoryError(''); setDirectoryLoading(false)
    if (!open || !browseInbox) return
    let alive = true
    if (connection !== 'connected') { setDirectoryError('Connect to Carrier to browse saved inbox messages.'); return }
    setDirectoryLoading(true)
    void requestRef.current<Mailbox[]>('mailboxes').then((items) => { if (alive) setMailboxes(items) })
      .catch((cause: Error) => { if (alive) setDirectoryError(cause.message) }).finally(() => { if (alive) setDirectoryLoading(false) })
    return () => { alive = false }
  }, [open, browseInbox, connection])
  useEffect(() => {
    setMessageLoading(false); setMessageError('')
    if (!open || stage !== 'message' || !selectedMailbox || connection !== 'connected') return
    let alive = true
    setMessageLoading(true)
    // Debounce typing and ignore responses belonging to an older caret/query.
    const timer = setTimeout(() => {
      void requestRef.current<MessageSearch>('message_search', { mailbox: selectedMailbox.id, search, offset, limit: 20 })
        .then((result) => { if (alive) setPage(result) })
        .catch((cause: Error) => { if (alive) { setPage(null); setMessageError(cause.message) } })
        .finally(() => { if (alive) setMessageLoading(false) })
    }, 150)
    return () => { alive = false; clearTimeout(timer) }
  }, [open, stage, selectedMailbox?.id, search, offset, connection])

  function replace(token: string, reference?: InboxReference) {
    if (!mention) return
    const updated = value.slice(0, mention.start) + token + (reference ? ' ' : '') + value.slice(mention.end)
    if (updated.length > 32000) { setError('The prompt is full. Shorten it before adding a reference.'); return }
    if (reference && references.some((existing) => existing.token === reference.token && existing.instance !== reference.instance)) {
      setError('The inbox changed. Remove the older reference before selecting this message.'); return
    }
    const retained = retainedReferences(updated, references)
    onChange(updated, reference ? [...retained.filter((item) => item.token !== reference.token), reference] : retained, retainedFileReferences(updated, fileReferences))
    const nextCaret = mention.start + token.length + (reference ? 1 : 0)
    setCaret(nextCaret); setIndex(0); setDismissed(null)
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(nextCaret, nextCaret) })
  }

  function remember(key: string) { setRecents(previous => rememberMention(key, previous)) }

  async function chooseGroup(item: ComposerMentionGroup, id: string) {
    const key = `${item.id}:${id}`
    if (parts?.[2] === '/' && item.onNavigate) {
      remember(key); replace(''); item.onNavigate(id)
      return
    }
    if (!item.insertText) {
      remember(key); replace(''); item.onSelect?.(id)
      return
    }
    const attempt = ++insertion.current
    const scope = context?.scope
    setInsertionError(''); setResolving(true); onResolvingChange?.(true)
    try {
      const text = await item.insertText(id, value.slice(mention!.end))
      if (insertion.current !== attempt) return
      if (live.current.value !== value || live.current.scope !== scope) {
        setInsertionError('The draft changed. Select this item again to insert it.'); return
      }
      if (text !== null) {
        if (value.length - (mention!.end - mention!.start) + text.length > 32000) throw new Error('The message is full. Shorten it before inserting this item.')
        replace(text); remember(key)
      }
      setDismissed(signature)
    } catch (cause) {
      if (insertion.current === attempt) { setInsertionError(cause instanceof Error ? cause.message : 'Could not insert this item.'); setDismissed(signature) }
    } finally {
      if (insertion.current === attempt) {
        setResolving(false); live.current.onResolvingChange?.(false)
        requestAnimationFrame(() => inputRef.current?.focus())
      }
    }
  }

  let options: Option[]
  if (stage === 'root') {
    const search = mention?.token.slice(1) ?? ''
    const shortcuts: Option[] = [
      { key: 'inbox', label: 'Inbox', detail: 'Include a Carrier message in your prompt', icon: 'mail' as const, choose: () => replace('@inbox/') },
      ...(context ? [{ key: 'file', label: 'File', detail: 'Include a project text file in your message', icon: 'file-text' as const, choose: () => replace('@file:') }] : []),
      ...mentionGroups.map((item) => ({ key: item.id, label: item.label, detail: `@${item.id}${item.separator ?? ':'} · ${item.description}`, icon: item.icon, choose: () => replace(`@${item.id}${item.separator ?? ':'}`) })),
    ].map(option => ({ ...option, score: Math.min(mentionScore(search, option.label, option.key),
      ...(mentionGroups.find(item => item.id === option.key)?.aliases ?? []).map(alias => mentionScore(search, alias, alias) + 0.25)) }))
      .filter(option => Number.isFinite(option.score))
    const matches: Option[] = mentionGroups.flatMap(item => item.options.filter(option => !option.disabled).map(option => ({
      key: `${item.id}:${option.id}`, label: `${item.label} · ${option.label}`, detail: `${item.description}${option.description ? ` · ${option.description}` : ''}`,
      icon: item.icon, score: mentionScore(search, option.label, option.id, option.description, option.keywords), choose: () => { void chooseGroup(item, option.id) },
    }))).concat(availableMailboxes.map(mailbox => ({ key: `inbox:${mailbox.id}`, label: `Inbox · ${mailbox.name}`,
      detail: `Browse messages · ${mailbox.address}`, icon: 'mail' as const, score: mentionScore(search, mailbox.name, mailbox.id, mailbox.address),
      choose: () => { remember(`inbox:${mailbox.id}`); replace(`@inbox/${encodeURIComponent(mailbox.id)}:`) },
    })))
    const recentIndex = (key: string) => { const index = recents.indexOf(key); return index < 0 ? Infinity : index }
    if (!search) options = [...shortcuts, ...matches.filter(option => recents.includes(option.key))
      .sort((a, b) => recentIndex(a.key) - recentIndex(b.key)).slice(0, 5).map(option => ({ ...option, detail: `Recent · ${option.detail}` }))]
    else options = [...shortcuts, ...matches.filter(option => Number.isFinite(option.score))]
      .sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity) || recentIndex(a.key) - recentIndex(b.key))
  } else if (stage === 'setting' && group) {
    options = group.options.filter((option) => !option.disabled && Number.isFinite(mentionScore(query, option.label, option.id, option.description, option.keywords)))
      .sort((a, b) => mentionScore(query, a.label, a.id, a.description, a.keywords) - mentionScore(query, b.label, b.id, b.description, b.keywords))
      .map((option) => ({ key: option.id, label: option.label, detail: option.description ?? '', icon: group.icon,
        choose: () => { void chooseGroup(group, option.id) } }))
  } else if (stage === 'mailbox') {
    options = availableMailboxes.filter((mailbox) => `${mailbox.name} ${mailbox.id} ${mentionSlug(mailbox.name)}`.toLowerCase().includes(mailboxQuery.toLowerCase()))
      .map((mailbox) => ({ key: mailbox.id, label: mailbox.name, detail: mailbox.address, choose: () => { remember(`inbox:${mailbox.id}`); replace(`@inbox/${encodeURIComponent(mailbox.id)}:`) } }))
  } else {
    options = (page?.messages ?? []).map((message) => ({ key: message.id, label: message.title,
      detail: `${message.sender} · ${new Date(message.created_at).toLocaleDateString()} · ${message.preview}`,
      choose: () => { if (selectedMailbox && page) {
        const token = `@inbox/${encodeURIComponent(selectedMailbox.id)}:${mentionSlug(message.title)}~${message.id}`
        replace(token, { token, id: message.id, instance: page.instance, mailbox: selectedMailbox.id, mailboxName: selectedMailbox.name, title: message.title })
      } } }))
  }
  if (stage === 'message' && page?.next_offset !== null && page?.next_offset !== undefined) options.push({ key: 'more', label: 'More messages', detail: 'Show the next page', choose: () => { setOffset(page.next_offset!); setIndex(0); setPage(null) } })
  if (extra.active) options = extra.options
  const highlighted = useRef<{ signature: string; index: number; key?: string }>({ signature: '', index: 0 })
  const retainedIndex = highlighted.current.signature === signature && highlighted.current.index === index ?
    options.findIndex(option => option.key === highlighted.current.key) : -1
  const activeIndex = retainedIndex >= 0 ? retainedIndex : Math.min(index, Math.max(0, options.length - 1))
  highlighted.current = { signature, index, key: options[activeIndex]?.key }
  const blocked = loading || Boolean(displayError && !extra.commandMode)
  const showStatus = !(extra.active && extra.footer && (loading || displayError || extra.disabled)) && (loading || displayError || !options.length)
  useEffect(() => {
    if (open && !loading) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, loading, listId, activeIndex, signature])

  return <>
    {insertionError && <p className="inbox-mention-status" role="status">{insertionError}</p>}
    {resolving && <p className="inbox-mention-status" role="status">Preparing selection…</p>}
    <textarea ref={inputRef} className="command-input" aria-label="Instructions" rows={1} maxLength={32000}
      placeholder={placeholder} value={value} readOnly={readOnly || resolving} aria-autocomplete="list" aria-haspopup="listbox"
      aria-controls={open ? listId : undefined} aria-activedescendant={open && options.length && !blocked ? `${listId}-${activeIndex}` : undefined}
      onFocus={(event) => { setFocused(true); setCaret(event.currentTarget.selectionStart === event.currentTarget.selectionEnd ? event.currentTarget.selectionStart : -1) }}
      onBlur={event => { if (!(event.relatedTarget instanceof Node && popoverRef.current?.contains(event.relatedTarget))) setFocused(false) }}
      onSelect={(event) => setCaret(event.currentTarget.selectionStart === event.currentTarget.selectionEnd ? event.currentTarget.selectionStart : -1)}
      onChange={(event) => { setCaret(event.currentTarget.selectionStart); setDismissed(null); setInsertionError(''); onChange(event.target.value, retainedReferences(event.target.value, references), retainedFileReferences(event.target.value, fileReferences)) }}
      onKeyDown={(event) => {
        if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && ['u', 'j'].includes(event.key.toLowerCase())
          && !event.nativeEvent.isComposing && !readOnly && !resolving) {
          event.preventDefault()
          event.stopPropagation()
          const input = event.currentTarget
          const newline = event.key.toLowerCase() === 'j'
          const start = newline ? input.selectionStart : value.slice(0, input.selectionStart).lastIndexOf('\n') + 1
          const nextBreak = value.indexOf('\n', input.selectionEnd)
          const end = newline ? input.selectionEnd : nextBreak < 0 ? value.length : nextBreak
          const next = value.slice(0, start) + (newline ? '\n' : '') + value.slice(end)
          if (next.length > input.maxLength) return
          const caret = start + (newline ? 1 : 0)
          setCaret(caret)
          setDismissed(null)
          setInsertionError('')
          onChange(next, retainedReferences(next, references), retainedFileReferences(next, fileReferences))
          requestAnimationFrame(() => input.setSelectionRange(caret, caret))
          return
        }
        if (event.nativeEvent.isComposing) return
        if (resolving) { if (event.key === 'Enter') event.preventDefault(); return }
        if (open) {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(signature); return }
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault(); setIndex((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(options.length, 1)) % Math.max(options.length, 1)); return
          }
          if (event.key === 'Enter' && !event.shiftKey && extra.exactCommand && !blocked) {
            event.preventDefault(); onSubmit(); return
          }
          if (event.key === 'Enter' && !event.shiftKey && extra.commandMode && extra.standaloneCommand && !options.length && !loading && !displayError) {
            event.preventDefault(); onSubmit(); return
          }
          if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey && options.length > 0 && !loading)) {
            event.preventDefault(); if (!blocked) options[activeIndex]?.choose(); return
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSubmit() }
      }} />
    <Popover {...theme} ref={popoverRef} isOpen={open} triggerRef={inputRef} isNonModal placement="top start" offset={8}
      onOpenChange={(isOpen) => { if (!isOpen) setDismissed(signature) }}
      className="bbb-theme bbb-floating-surface bbb-dropdown-surface inbox-mention-popover">
      <div className="inbox-mention-heading">{extra.active ? extra.heading : stage === 'root' ? 'Search or add to your chat' : stage === 'setting' ? `Choose a ${group!.label.toLowerCase()}` : stage === 'mailbox' ? 'Choose an inbox' : selectedMailbox?.name ?? 'Choose an inbox first'}<span>↑↓ · Enter · Esc</span></div>
      <div id={listId} role="listbox" aria-label={extra.active ? `${extra.heading.split(' · ')[0]} suggestions` : stage === 'root' ? 'Chat mention suggestions' : stage === 'setting' ? `${group!.label} suggestions` : 'Inbox reference suggestions'} className="bbb-option-list inbox-mention-options">
        {!blocked && options.map((option, optionIndex) => <div role="option" aria-selected={optionIndex === activeIndex} id={`${listId}-${optionIndex}`} key={option.key}
          className="bbb-option inbox-mention-option" data-focused={optionIndex === activeIndex || undefined}
          onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={option.choose}>
          <Icon name={option.icon ?? (stage === 'mailbox' ? 'folder' : 'mail')} /><span className="bbb-option__content"><strong>{option.label}</strong><span className="bbb-option__description">{option.detail}</span></span>
        </div>)}
      </div>
      {extra.active && extra.footer}
      {showStatus && <p className="inbox-mention-status" role="status">{extra.active ? loading ? extra.loadingText : displayError || extra.empty : loading ? stage === 'setting' ? `Loading ${group!.label.toLowerCase()} options…` : 'Loading saved inbox…' : displayError || (stage === 'root' ? 'No matches. Try a name or an explicit category such as @project: or @file:.' : stage === 'setting' ? `No ${group!.label.toLowerCase()} options match this name.` : stage === 'message' && !selectedMailbox ? 'Choose an inbox from the suggestions after @inbox/.' : stage === 'mailbox' ? 'No inboxes match this name.' : 'No messages found. Try a different search.')}</p>}
      {!extra.active && stage === 'root' && mentionGroups.some(item => item.loading) && <p className="inbox-mention-status" role="status">Loading more suggestions…</p>}
      {!extra.active && (stage === 'root' ? mentionGroups : stage === 'setting' && group ? [group] : []).filter(item => item.error).map(item => <div key={item.id}>
        <p className="inbox-mention-status" role="status">{item.label}: {item.error}</p>
        {item.onRetry && <Button variant="ghost" size="sm" disabled={item.loading} onPress={() => {
          item.onRetry?.()
          requestAnimationFrame(() => { inputRef.current?.focus(); setDismissed(null) })
        }}>Retry {item.label.toLowerCase()} list</Button>}
      </div>)}
    </Popover>
  </>
}

export function ComposerReferences({ inputRef, value, references = [], fileReferences = [], request, readOnly, onChange }: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  value: string
  references?: InboxReference[]
  fileReferences?: FileReference[]
  request: CarrierRequest
  readOnly: boolean
  onChange: (value: string, references: InboxReference[], files: FileReference[]) => void
}) {
  const activeReferences = retainedReferences(value, references)
  return <>
    {activeReferences.length > 0 && <div className="inbox-reference-chips" role="group" aria-label="Inbox message references">
      {activeReferences.map((reference) => <span className="inbox-reference-chip" key={reference.token}>
        <InboxReferencePreview reference={reference} request={request} disabled={readOnly} />
        <Button variant="ghost" size="sm" iconOnly disabled={readOnly} aria-label={`Remove inbox message: ${reference.title}`} onPress={() => {
          const updated = removeInboxReference(value, reference.token)
          onChange(updated, retainedReferences(updated, references), retainedFileReferences(updated, fileReferences)); inputRef.current?.focus()
        }}><Icon name="x" /></Button>
      </span>)}
      <span className="inbox-reference-note">Message content included when you send</span>
    </div>}
    {retainedFileReferences(value, fileReferences).length > 0 && <div className="inbox-reference-chips" role="group" aria-label="Project file references">
      {retainedFileReferences(value, fileReferences).map(reference => <span className="inbox-reference-chip" key={reference.token}>
        <Icon name="file-text" /><span>{reference.path}</span>
        <Button variant="ghost" size="sm" iconOnly disabled={readOnly} aria-label={`Remove file: ${reference.path}`} onPress={() => {
          const updated = removeFileReference(value, reference.token)
          onChange(updated, retainedReferences(updated, references), retainedFileReferences(updated, fileReferences))
          inputRef.current?.focus()
        }}><Icon name="x" /></Button>
      </span>)}
      <span className="inbox-reference-note">File content included when you send</span>
    </div>}
  </>
}

function InboxReferencePreview({ reference, request, disabled }: { reference: InboxReference; request: CarrierRequest; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<CarrierMessage | null>(null)
  const [error, setError] = useState('')
  const requestRef = useRef(request)
  requestRef.current = request
  useEffect(() => {
    if (!open) return
    let alive = true
    setMessage(null); setError('')
    void requestRef.current<CarrierMessage>('message_get', { mailbox: reference.mailbox, id: Number(reference.id), instance: reference.instance })
      .then((result) => { if (alive) setMessage(result) }).catch((cause: Error) => { if (alive) setError(cause.message) })
    return () => { alive = false }
  }, [open, reference.mailbox, reference.id, reference.instance])
  return <Dialog title={reference.title} open={open} onOpenChange={setOpen}
    trigger={<Button variant="ghost" size="sm" disabled={disabled} aria-label={`Preview inbox message: ${reference.title}`}><Icon name="mail" /><span>{reference.title}</span></Button>}>
    <div className="inbox-reference-preview">
      <p>{reference.mailboxName}{message && ` · ${message.sender} · ${new Date(message.created_at).toLocaleString()}`}</p>
      {message ? <pre>{message.body}</pre> : <p role="status">{error || 'Loading message…'}</p>}
    </div>
  </Dialog>
}
