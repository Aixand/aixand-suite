import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { Button, Icon, Tooltip, useThemeAttributes } from 'bbb-design'
import { Dialog, DialogTrigger, Heading, Popover } from 'react-aria-components'
import type { ChatDraftStore } from './draft'
import { retainedReferences, type CarrierRequest } from './inboxReferences'
import { retainedFileReferences } from './fileReferences'
import { ComposerReferences, InboxComposerInput, type ComposerMentionGroup } from './InboxComposerInput'
import type { ComposerContext } from './useComposerSuggestions'
import { commandInput } from './commands'
import { ComposerStatus } from './ComposerStatus'
import type { ComposerStatusNotice } from './composerNotices'

export function EmptyChatDraft({ draft, children }: { draft: ChatDraftStore; children: ReactNode }) {
  const empty = useSyncExternalStore(draft.subscribe, draft.isEmpty)
  return empty ? children : null
}

export function ChatComposer({ draft, inputRef, placeholder, request, connection, context, mentionGroups, readOnly, canSubmit, canRunCommand, canBrowseSettings, retrying, sending = false, sendLabel, sendOptions, onSubmit, stop, notices = [], identityControls, projectControl, projectSelected = false, projectSelectionDisabled = false, options, actions }: {
  draft: ChatDraftStore
  inputRef: RefObject<HTMLTextAreaElement | null>
  placeholder: string
  request: CarrierRequest
  connection: string
  context?: ComposerContext
  mentionGroups: ComposerMentionGroup[]
  readOnly: boolean
  canSubmit: boolean
  canRunCommand?: boolean
  canBrowseSettings?: boolean
  retrying?: boolean
  sending?: boolean
  sendLabel: string
  sendOptions?: { id: string; label: string }[]
  onSubmit: () => void
  stop?: { label: string; disabled: boolean; onPress: () => void }
  notices?: ComposerStatusNotice[]
  identityControls?: ReactNode
  projectControl?: ReactNode
  projectSelected?: boolean
  projectSelectionDisabled?: boolean
  options: ReactNode
  actions: ReactNode
}) {
  const value = useSyncExternalStore(draft.subscribe, draft.getSnapshot)
  const [resolving, setResolving] = useState(false)
  const [multiline, setMultiline] = useState(false)
  const layout = useRef<{ multiline: boolean; height: number; positions: { element: HTMLElement; x: number; y: number }[] } | null>(null)
  const referenceCount = retainedReferences(value.prompt, value.inboxReferences).length + retainedFileReferences(value.prompt, value.fileReferences).length
  const theme = useThemeAttributes()
  const parsed = commandInput(value.prompt, context?.commands ?? [])
  const commandAllowed = parsed && (['client', 'suite', 'terminal'].includes(parsed.command.execution) || parsed.command.requiresIdle === false)
  const browsingSetting = canBrowseSettings && parsed && !parsed.arguments &&
    (parsed.command.execution === 'setting' || parsed.command.execution === 'client' && parsed.command.action === 'model')
  const enabled = !sending && !resolving && Boolean(canSubmit || canRunCommand && commandAllowed || browsingSetting) && Boolean(value.prompt.trim() || retrying)
  const showStop = Boolean(stop && !sending && !value.prompt.trim())
  const actionLabel = sending ? 'Sending message' : showStop ? stop!.label : sendLabel
  useLayoutEffect(() => {
    const textarea = inputRef.current
    if (!textarea) return
    const resize = () => {
      const row = textarea.closest<HTMLElement>('.command-composer-row')
      const add = row?.querySelector<HTMLElement>(':scope > .bbb-button')
      const tools = row?.querySelector<HTMLElement>('.command-composer-tools')
      const form = row?.closest('form')
      const before = form?.getBoundingClientRect()
      const positions = row && before ? Array.from(row.children).filter((element): element is HTMLElement => element instanceof HTMLElement).map(element => {
        const bounds = element.getBoundingClientRect()
        return { element, x: bounds.x - before.x, y: bounds.y - before.y }
      }) : []
      const gap = row ? parseFloat(getComputedStyle(row).columnGap) || 0 : 0
      // Measure at the single-line width to keep the layout stable when text wraps.
      if (row && add && tools) textarea.style.width = `${Math.max(1, row.clientWidth - add.offsetWidth - tools.offsetWidth - gap * 2)}px`
      textarea.style.height = 'auto'
      const style = getComputedStyle(textarea)
      const singleLineHeight = Math.max(parseFloat(style.minHeight), parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom))
      const nextMultiline = textarea.scrollHeight > singleLineHeight + 1
      if (layout.current?.multiline !== nextMultiline) {
        layout.current = { multiline: nextMultiline, height: layout.current ? before?.height ?? 0 : 0, positions }
        setMultiline(nextMultiline)
      }
      textarea.style.width = ''
      textarea.style.height = `${textarea.scrollHeight}px`
    }
    resize()
    let width = textarea.clientWidth
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return
      width = textarea.clientWidth
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(resize)
    })
    observer.observe(textarea)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [inputRef, value.prompt, placeholder, multiline])

  useLayoutEffect(() => {
    const previous = layout.current
    const form = inputRef.current?.closest('form')
    if (!previous || !form || !previous.height || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const bounds = form.getBoundingClientRect()
    const timing = { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
    const animations = [form.animate([{ height: `${previous.height}px` }, { height: `${bounds.height}px` }], timing)]
    for (const { element, x, y } of previous.positions) {
      const current = element.getBoundingClientRect()
      animations.push(element.animate([
        { transform: `translate(${x - (current.x - bounds.x)}px, ${y - (current.y - bounds.y)}px)` },
        { transform: 'translate(0, 0)' },
      ], timing))
    }
    return () => animations.forEach(animation => animation.cancel())
  }, [inputRef, multiline])

  function submit() {
    if (enabled) {
      onSubmit()
      requestAnimationFrame(() => {
        if (!document.querySelector('[role="dialog"], [role="alertdialog"]')) inputRef.current?.focus({ preventScroll: true })
      })
    }
  }

  return <div className="command-composer-shell"><form className="command-composer" onSubmit={(event) => { event.preventDefault(); submit() }}
    onClick={event => {
      const target = event.target
      if (!(target instanceof Element) || target.closest('button, a, input, textarea, select, [role="button"], [role="dialog"], [role="listbox"], [contenteditable]')) return
      if (!window.getSelection()?.isCollapsed) return
      inputRef.current?.focus({ preventScroll: true })
    }}>
    {readOnly && <p className="inbox-mention-status" role="status">Draft editing is temporarily paused while this request is processed or awaiting resolution.</p>}
    <ComposerStatus notices={notices} />
    <div className="command-composer-row" data-multiline={multiline || undefined}>
      <DialogTrigger>
        <Tooltip content="Add context and tools">
          <Button variant="ghost" size="sm" iconOnly aria-label="Add context and tools"><Icon name="plus" /></Button>
        </Tooltip>
        <Popover {...theme} placement="top start" className="bbb-theme bbb-floating-surface command-add-popover">
          <Dialog className="command-add-menu">
            {({ close }) => <>
              <Heading slot="title" className="bbb-visually-hidden">Add context and tools</Heading>
              <Button variant="ghost" size="sm" disabled={readOnly || resolving} onPress={() => {
                const current = draft.getSnapshot()
                const position = inputRef.current?.selectionStart ?? current.prompt.length
                const prefix = current.prompt.slice(0, position)
                const insertion = `${prefix && !/\s$/.test(prefix) ? ' ' : ''}@`
                draft.set({ ...current, prompt: prefix + insertion + current.prompt.slice(position) })
                close()
                requestAnimationFrame(() => {
                  inputRef.current?.focus()
                  inputRef.current?.setSelectionRange(position + insertion.length, position + insertion.length)
                })
              }}><Icon name="plus" />Add context</Button>
              <Button variant="ghost" size="sm" disabled={readOnly || resolving || projectSelectionDisabled} onPress={() => {
                const current = draft.getSnapshot()
                const prefix = current.prompt
                draft.set({ ...current, prompt: `${prefix}${prefix && !/\s$/.test(prefix) ? ' ' : ''}@project:` })
                close()
                requestAnimationFrame(() => {
                  inputRef.current?.focus()
                  const end = draft.getSnapshot().prompt.length
                  inputRef.current?.setSelectionRange(end, end)
                })
              }}><Icon name="folder" />Select project</Button>
              {actions && <div className="command-add-actions">{actions}</div>}
            </>}
          </Dialog>
        </Popover>
      </DialogTrigger>
      <div className="command-composer-input">
      <InboxComposerInput inputRef={inputRef} placeholder={placeholder}
        value={value.prompt} references={value.inboxReferences}
        fileReferences={value.fileReferences} context={context}
        request={request} connection={connection} mentionGroups={mentionGroups} readOnly={readOnly}
        onChange={(prompt, inboxReferences, fileReferences) => draft.set({ ...draft.getSnapshot(), prompt, inboxReferences, fileReferences })}
        onSubmit={submit} onResolvingChange={setResolving} />
      </div>
      <div className="command-composer-tools">
        <div className="command-composer-options" role="group" aria-label="Composer options">{options}</div>
        <div className="command-composer-send">
          {sendOptions?.length && !showStop && !parsed && !retrying ? <DialogTrigger>
            <Tooltip content={actionLabel}>
              <Button type="button" className="command-send" size="sm" iconOnly aria-label={actionLabel} loading={sending} disabled={!enabled}>
                <Icon name="arrow-up" />
              </Button>
            </Tooltip>
            <Popover {...theme} placement="top end" className="bbb-theme bbb-floating-surface command-add-popover">
              <Dialog className="command-add-menu">
                {({ close }) => <>
                  <Heading slot="title" className="bbb-visually-hidden">Send message</Heading>
                  {sendOptions.map(option => <Button key={option.id} type="button" variant="ghost" size="sm" disabled={!enabled}
                    onPress={() => { close(); submit() }}><Icon name="arrow-up" />{option.label}</Button>)}
                </>}
              </Dialog>
            </Popover>
          </DialogTrigger> : <Tooltip content={actionLabel}>
            {showStop ? <Button type="button" className="command-send" size="sm" iconOnly aria-label={actionLabel}
              disabled={stop!.disabled} onPress={stop!.onPress}>
              <span className="command-stop-symbol" aria-hidden="true" />
            </Button> : <Button type="submit" className="command-send" size="sm" iconOnly aria-label={actionLabel} loading={sending} disabled={!enabled}>
              <Icon name="arrow-up" />
            </Button>}
          </Tooltip>}
        </div>
      </div>
    </div>
  </form>
    {(identityControls || projectSelected || referenceCount > 0) && <div className="command-composer-context-summary" role="group" aria-label="Selected context">
      {projectSelected && projectControl}
      {referenceCount > 0 && <DialogTrigger>
        <Button variant="ghost" size="sm"><Icon name="file-text" />{referenceCount} {referenceCount === 1 ? 'reference' : 'references'}</Button>
        <Popover {...theme} placement="top start" className="bbb-theme bbb-floating-surface command-references-popover">
          <Dialog className="command-references-dialog">
            <Heading slot="title">References</Heading>
            <ComposerReferences inputRef={inputRef} value={value.prompt} references={value.inboxReferences}
              fileReferences={value.fileReferences} request={request} readOnly={readOnly || resolving}
              onChange={(prompt, inboxReferences, fileReferences) => draft.set({ ...draft.getSnapshot(), prompt, inboxReferences, fileReferences })} />
          </Dialog>
        </Popover>
      </DialogTrigger>}
      {identityControls}
    </div>}
  </div>
}
