import { useLayoutEffect, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { Button, Icon, Tooltip } from 'bbb-design'
import type { ChatDraftStore } from './draft'
import type { CarrierRequest } from './inboxReferences'
import { InboxComposerInput, type ComposerMentionGroup } from './InboxComposerInput'
import type { ComposerContext } from './useComposerSuggestions'
import { commandInput } from './commands'

export function EmptyChatDraft({ draft, children }: { draft: ChatDraftStore; children: ReactNode }) {
  const empty = useSyncExternalStore(draft.subscribe, draft.isEmpty)
  return empty ? children : null
}

export function ChatComposer({ draft, inputRef, placeholder, request, connection, context, mentionGroups, readOnly, canSubmit, canRunCommand, retrying, sendLabel, onSubmit, options, actions }: {
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
  retrying?: boolean
  sendLabel: string
  onSubmit: () => void
  options: ReactNode
  actions: ReactNode
}) {
  const value = useSyncExternalStore(draft.subscribe, draft.getSnapshot)
  const [resolving, setResolving] = useState(false)
  const parsed = commandInput(value.prompt, context?.commands ?? [])
  const commandAllowed = parsed && (['client', 'suite'].includes(parsed.command.execution) || parsed.command.requiresIdle === false)
  const enabled = !resolving && Boolean(canSubmit || canRunCommand && commandAllowed) && Boolean(value.prompt.trim() || retrying)
  useLayoutEffect(() => {
    const textarea = inputRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [inputRef, value.prompt, placeholder])

  function submit() {
    if (enabled) onSubmit()
  }

  return <form className="command-composer" onSubmit={(event) => { event.preventDefault(); submit() }}>
    <InboxComposerInput inputRef={inputRef} placeholder={placeholder}
      value={value.prompt} references={value.inboxReferences}
      fileReferences={value.fileReferences} context={context}
      request={request} connection={connection} mentionGroups={mentionGroups} readOnly={readOnly}
      onChange={(prompt, inboxReferences, fileReferences) => draft.set({ ...draft.getSnapshot(), prompt, inboxReferences, fileReferences })}
      onSubmit={submit} onResolvingChange={setResolving} />
    <div className="command-composer-tools">
      <div className="command-composer-options" role="group" aria-label="Composer options">{options}</div>
      <div className="command-composer-send">
        {actions}
        <Tooltip content={sendLabel}>
          <Button type="submit" className="command-send" size="sm" iconOnly aria-label={sendLabel} disabled={!enabled}>
            <Icon name="arrow-up" />
          </Button>
        </Tooltip>
      </div>
    </div>
  </form>
}
