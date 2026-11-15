import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  Dialog,
  Icon,
  SearchField,
  TextField,
  Tooltip,
} from 'bbb-design'
import type { GroupMutation, GroupPage } from './groups'

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Group operation failed.'

export function GroupManager({
  data,
  disabled,
  mutate,
  open,
  onOpenChange,
}: {
  data: GroupPage
  disabled: boolean
  mutate: GroupMutation
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const nameInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [shell, setShell] = useState('')
  const [persistent, setPersistent] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (open) {
      setQuery('')
      setError('')
      setNotice('')
    }
  }, [open])
  async function act(key: string, op: string, args: Record<string, unknown>) {
    setBusy(key)
    setError('')
    setNotice('')
    try {
      await mutate(op, args)
      if (op === 'group-create') {
        setName('')
        setQuery('')
        setNotice('Group created.')
      } else if (op === 'group-delete')
        setNotice('Group deleted. Its shells keep running.')
      else
        setNotice(
          'Creation status checked. Unresolved starts stay pending; no shell was retried.'
        )
      requestAnimationFrame(() => (op === 'group-create' ? nameInput : searchInput).current?.focus())
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy('')
    }
  }
  const search = query.trim().toLowerCase()
  const groups = data.groups.filter(group => group.name.toLowerCase().includes(search))
  const validName = /^[A-Za-z0-9_-]{1,48}$/.test(name.trim())
  return (
    <Dialog
      className="tw-group-modal"
      title="Manage groups"
      open={open}
      trigger={<Button hidden>Open group manager</Button>}
      onOpenChange={onOpenChange}
    >
      <div className="tw-group-dialog">
        <div className="tw-group-search">
          <SearchField ref={searchInput} autoFocus label="Search groups" placeholder="Search groups…"
            value={query} onChange={setQuery} clearLabel="Clear group search" />
          <span className="tw-group-count" aria-live="polite">
            {search ? `${groups.length} of ${data.groups.length}` : `${data.groups.length} ${data.groups.length === 1 ? 'group' : 'groups'}`}
          </span>
        </div>
        {error && (
          <p role="alert" className="tw-group-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <ul className="tw-group-list" aria-label="Terminal groups" tabIndex={0}>
          {groups.length === 0 && <li className="tw-group-empty">
            {data.groups.length === 0 ? 'No groups yet. Create one below.' : 'No matching groups.'}
          </li>}
          {groups.map((group) => (
            <li className="tw-group-row" key={group.id}>
              <div className="tw-group-row-info">
                <details className="tw-group-details">
                  <summary aria-label={`Details for group ${group.name}`}
                    aria-description={`${group.members.length} ${group.members.length === 1 ? 'terminal' : 'terminals'}`}>
                    <Icon name="chevron-right" />
                    <strong title={group.name}>{group.name}</strong>
                    <span className="tw-group-count" title={`${group.members.length} ${group.members.length === 1 ? 'terminal' : 'terminals'}`}>
                      {group.members.length}<span className="bbb-visually-hidden"> terminals</span>
                    </span>
                  </summary>
                  <div className="tw-group-details-body">
                    <dl>
                      <dt>Directory</dt><dd>{group.cwd}</dd>
                      <dt>Shell</dt><dd>{group.shell}</dd>
                    </dl>
                    <p>{group.persistent ? 'Saves shells for restoration' : 'No shell restoration'}</p>
                    {group.deleting && <p>Finish shutdown with uc group delete --stop.</p>}
                    {group.pending_name && <p>Pending terminal: {group.pending_name}</p>}
                  </div>
                </details>
                {(group.deleting || group.pending_name) && <p className="tw-group-row-state" role="status">
                  {group.deleting ? 'Shutdown pending' : 'Creation pending'}
                </p>}
              </div>
              <div className="tw-group-row-actions">
                {group.pending_name && (
                  <Tooltip content="Check creation"><Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label={`Check creation for group ${group.name}`}
                    loading={busy === group.id}
                    disabled={disabled || Boolean(busy) || group.deleting}
                    onPress={() =>
                      void act(group.id, 'group-reconcile', {
                        group: group.name,
                      })
                    }
                  >
                    <Icon name="refresh-cw" />
                  </Button></Tooltip>
                )}
                <Tooltip content="Delete group"><Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  className="tw-group-delete"
                  loading={busy === group.id && !group.pending_name}
                  disabled={
                    disabled ||
                    Boolean(busy) ||
                    group.deleting ||
                    Boolean(group.pending_name)
                  }
                  aria-label={`Delete group ${group.name}`}
                  onPress={() =>
                    void act(group.id, 'group-delete', { group: group.name })
                  }
                >
                  <Icon name="trash-2" />
                </Button></Tooltip>
              </div>
            </li>
          ))}
        </ul>
        <p className="tw-group-hint">
          Deleting removes saved settings. Running terminals stay open.
        </p>
        <form
          className="tw-group-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (disabled || busy || !validName) return
            void act('create', 'group-create', {
              name: name.trim(),
              persistent,
              ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
              ...(shell.trim() ? { shell: shell.trim() } : {}),
            })
          }}
        >
          <div className="tw-group-create">
            <TextField
              ref={nameInput}
              label="Group name"
              hideLabel
              placeholder="New group name"
              variant="outlined"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={48}
              title="Letters, numbers, underscores, and hyphens."
              error={name && !validName ? 'Use letters, numbers, underscores, or hyphens.' : undefined}
              disabled={disabled || Boolean(busy)}
              required
            />
            <Tooltip content="Create group"><Button type="submit" size="sm" iconOnly aria-label="Create group"
              loading={busy === 'create'}
              disabled={disabled || Boolean(busy) || !validName}>
              <Icon name="plus" />
            </Button></Tooltip>
          </div>
          <details className="tw-group-defaults">
            <summary><Icon name="chevron-right" />Shell defaults</summary>
            <div className="tw-group-default-fields">
              <TextField
                label="Default directory"
                variant="outlined"
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder={data.defaults.cwd}
                disabled={disabled || Boolean(busy)}
              />
              <TextField
                label="Default shell"
                variant="outlined"
                value={shell}
                onChange={(event) => setShell(event.target.value)}
                placeholder={data.defaults.shell}
                disabled={disabled || Boolean(busy)}
              />
              <Checkbox
                label="Save new shells for restoration"
                isSelected={persistent}
                onChange={setPersistent}
                disabled={disabled || Boolean(busy)}
              />
              <p className="tw-group-hint">Applies to new shells in this group.</p>
            </div>
          </details>
        </form>
      </div>
    </Dialog>
  )
}

