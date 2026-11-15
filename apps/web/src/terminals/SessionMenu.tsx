import { useEffect, useRef, useState } from 'react'
import { Button, DropdownSurface, Icon } from 'bbb-design'
import { Menu, MenuItem, MenuTrigger, Separator, SubmenuTrigger, Text } from 'react-aria-components'
import { UNSAFE_PortalProvider } from 'react-aria/PortalProvider'
import type { SessionMutation } from './connection'
import type { GroupMutation, GroupPage, LibraryTerminal } from './groups'
import { isMyTerminal } from './context'
import { sessionActions } from './SessionLifecycle'

export function SessionMenu({
  terminal,
  data,
  disabled,
  pending,
  mutateSession,
  mutateGroup,
  onClear,
  savedShell = Boolean(terminal.member?.restorable),
  triggerLabel = `Manage terminal ${terminal.name}`
}: {
  terminal: LibraryTerminal
  data?: GroupPage
  disabled: boolean
  pending: boolean
  mutateSession: SessionMutation
  mutateGroup?: GroupMutation
  onClear?: () => void
  savedShell?: boolean
  triggerLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [narrow, setNarrow] = useState(false)
  const running = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const opening = useRef<number | null>(null)
  const { session, group, member } = terminal
  const blocked = disabled || pending || busy
  const groupBlocked = blocked || Boolean(group?.deleting || group?.pending_name)
  const source = group?.name ?? '@ungrouped'
  const actions = session ? sessionActions(session, savedShell) : []
  const canRestore =
    member?.restorable &&
    session?.restart_status?.state !== 'scheduled' &&
    !['running', 'starting', 'stopping'].includes(session?.lifecycle.state ?? '')
  const restoreDescription =
    'Start a new shell in the saved directory. Previous commands and applications will not resume.'

  useEffect(() => {
    const query = window.matchMedia('(max-width: 540px)')
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => () => {
    if (opening.current !== null) cancelAnimationFrame(opening.current)
  }, [])

  function changeOpen(next: boolean) {
    if (opening.current !== null) {
      cancelAnimationFrame(opening.current)
      opening.current = null
    }
    if (next) {
      setError('')
      if (trigger.current?.closest('.tw-section-rows')) {
        // Let scrolling to the trigger finish before the menu listens for scrolls.
        opening.current = requestAnimationFrame(() => {
          opening.current = null
          setOpen(true)
        })
        return
      }
    }
    setOpen(next)
  }

  async function run(operation: () => Promise<void>) {
    if (running.current || disabled || pending) return
    running.current = true
    setBusy(true)
    setError('')
    try {
      await operation()
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Terminal operation failed.')
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  function chooseAction(id: string) {
    if (id === 'clear') {
      if (busy || pending) return
      onClear?.()
      setOpen(false)
    } else if (id === 'my-terminal' && session && !blocked) {
      void run(() =>
        mutateSession('set-my-terminal', {
          sessionId: session.id,
          myTerminal: !isMyTerminal(session.labels)
        })
      )
    } else if (id === 'restore' && canRestore && !groupBlocked && mutateGroup && member && group) {
      void run(() =>
        mutateGroup('group-restore', {
          group: group.name,
          sessionId: member.session_id,
          columns: 100,
          rows: 30
        })
      )
    } else if (session && !blocked) {
      const action = actions.find((item) => item.id === id)
      if (!action || action.disabled) return
      void run(() =>
        mutateSession(action.op, {
          sessionId: session.id,
          ...(action.op === 'remove' ? { confirmed: true as const } : { force: action.force })
        })
      )
    }
  }

  function assignGroup(target: string) {
    if (groupBlocked || !mutateGroup) return
    if (target === source) {
      setOpen(false)
      return
    }
    void run(() =>
      mutateGroup('group-assign', {
        sessionId: member?.session_id ?? session!.id,
        from: source === '@ungrouped' ? null : source,
        to: target === '@ungrouped' ? null : target
      })
    )
  }

  return (
    <UNSAFE_PortalProvider
      getContainer={() =>
        document.fullscreenElement instanceof HTMLElement
          ? document.fullscreenElement
          : document.body
      }
    >
      <MenuTrigger
        isOpen={open}
        onOpenChange={changeOpen}
      >
        <Button
          ref={trigger}
          iconOnly
          variant="ghost"
          size="sm"
          disabled={disabled && !onClear}
          aria-label={triggerLabel}
        >
          <Icon name="ellipsis" />
        </Button>
        <DropdownSurface
          className="bbb-dropdown-menu tw-session-menu"
          placement="bottom end"
          offset={4}
          isNonModal
        >
          <section aria-label={`Actions for ${terminal.name}`}>
            <Menu
              aria-label={`Actions for ${terminal.name}`}
              className="bbb-option-list"
              shouldCloseOnSelect={false}
              onAction={(id) => chooseAction(String(id))}
            >
              {session && (
                <MenuItem
                  id="my-terminal"
                  className="bbb-option"
                  isDisabled={blocked}
                  textValue={
                    isMyTerminal(session.labels)
                      ? 'Remove from My terminals'
                      : 'Add to My terminals'
                  }
                >
                  <span className="bbb-option__content">
                    {isMyTerminal(session.labels)
                      ? 'Remove from My terminals'
                      : 'Add to My terminals'}
                  </span>
                </MenuItem>
              )}
              {data && mutateGroup && (
                <SubmenuTrigger delay={150}>
                  <MenuItem
                    id="group"
                    className="bbb-option"
                    isDisabled={groupBlocked}
                    textValue="Group"
                  >
                    <span className="bbb-option__content">Group</span>
                    <Icon name="chevron-right" />
                  </MenuItem>
                  <DropdownSurface
                    className="bbb-dropdown-menu tw-session-menu tw-session-group-menu"
                    placement={narrow ? 'bottom end' : 'right top'}
                    offset={4}
                    isNonModal
                  >
                    <Menu
                      aria-label="Assign terminal group"
                      className="bbb-option-list"
                      selectionMode="single"
                      selectedKeys={[`group:${source}`]}
                      shouldCloseOnSelect={false}
                      onAction={(id) => assignGroup(String(id).slice(6))}
                    >
                      <MenuItem
                        id="group:@ungrouped"
                        className="bbb-option"
                        isDisabled={groupBlocked}
                        textValue="Ungrouped"
                      >
                        {({ isSelected }) => (
                          <>
                            <span className="tw-group-menu-name">Ungrouped</span>
                            {isSelected && <Icon name="check" />}
                          </>
                        )}
                      </MenuItem>
                      {data.groups.map((target) => (
                        <MenuItem
                          key={target.name}
                          id={`group:${target.name}`}
                          textValue={target.name}
                          className="bbb-option"
                          isDisabled={
                            groupBlocked ||
                            target.deleting ||
                            Boolean(target.pending_name) ||
                            Boolean(member?.restorable && !target.persistent)
                          }
                        >
                          {({ isSelected }) => (
                            <>
                              <span className="tw-group-menu-name" title={target.name}>
                                {target.name}
                              </span>
                              {isSelected && <Icon name="check" />}
                            </>
                          )}
                        </MenuItem>
                      ))}
                    </Menu>
                  </DropdownSurface>
                </SubmenuTrigger>
              )}
              {canRestore && mutateGroup && (
                <MenuItem
                  id="restore"
                  className="bbb-option"
                  isDisabled={groupBlocked}
                  textValue="Restore shell"
                >
                  <Text slot="label" className="bbb-option__content">
                    <span title={restoreDescription}>Restore shell</span>
                  </Text>
                  <Text slot="description" className="tw-sr-only">
                    {restoreDescription}
                  </Text>
                </MenuItem>
              )}
              {onClear && (
                <MenuItem
                  id="clear"
                  className="bbb-option"
                  isDisabled={busy || pending}
                  textValue="Clear screen"
                >
                  <span className="bbb-option__content">Clear screen</span>
                </MenuItem>
              )}
              {actions.length > 0 && <Separator className="bbb-dropdown-menu__separator" />}
              {actions.map((action) => (
                <MenuItem
                  key={action.id}
                  id={action.id}
                  textValue={action.label}
                  className={`bbb-option${action.op === 'remove' || action.force ? ' bbb-option--danger' : ''}`}
                  isDisabled={blocked || action.disabled}
                >
                  <Text slot="label" className="bbb-option__content">
                    <span title={action.description}>{action.label}</span>
                  </Text>
                  <Text slot="description" className="tw-sr-only">
                    {action.description}
                  </Text>
                </MenuItem>
              ))}
            </Menu>
            {busy && (
              <p className="tw-session-menu-notice" role="status">
                Updating terminal…
              </p>
            )}
            {error && (
              <p className="tw-session-menu-notice tw-session-menu-error" role="alert">
                {error}
              </p>
            )}
          </section>
        </DropdownSurface>
      </MenuTrigger>
    </UNSAFE_PortalProvider>
  )
}
