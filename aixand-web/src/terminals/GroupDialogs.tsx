import { useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  Dialog,
  Icon,
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
}: {
  data: GroupPage
  disabled: boolean
  mutate: GroupMutation
}) {
  const nameInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [shell, setShell] = useState('')
  const [persistent, setPersistent] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  async function act(key: string, op: string, args: Record<string, unknown>) {
    setBusy(key)
    setError('')
    setNotice('')
    try {
      await mutate(op, args)
      if (op === 'group-create') {
        setName('')
        setNotice(
          'Group created. Add an existing terminal or start a new shell in it.'
        )
      } else if (op === 'group-delete')
        setNotice('Group deleted. Its shells keep running.')
      else
        setNotice(
          'Creation status checked. Unresolved starts stay pending; no shell was retried.'
        )
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy('')
      requestAnimationFrame(() => nameInput.current?.focus())
    }
  }
  return (
    <Dialog
      className="tw-group-modal"
      title="Manage groups"
      description="Organize terminals. Your open panes stay where they are."
      trigger={
        <Tooltip content="Manage groups"><Button variant="ghost" size="sm" iconOnly disabled={disabled} aria-label="Manage groups">
          <Icon name="folder" />
        </Button></Tooltip>
      }
      onOpenChange={(open) => {
        if (open) {
          setError('')
          setNotice('')
        }
      }}
    >
      <div className="tw-group-dialog">
        {error && (
          <p role="alert" className="tw-group-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <div className="tw-group-list">
          {data.groups.length === 0 && <p>No groups yet. Create one below.</p>}
          {data.groups.map((group) => (
            <div className="tw-group-row" key={group.id}>
              <div>
                <strong>{group.name}</strong>
                <p>
                  {group.members.length}{' '}
                  {group.members.length === 1 ? 'terminal' : 'terminals'} ·{' '}
                  {group.persistent
                    ? 'Saves shells for restoration'
                    : 'No shell restoration'}
                </p>
                <small>
                  {group.shell} · {group.cwd}
                </small>
                {group.deleting && (
                  <p role="status">
                    Shutdown pending. Finish it with uc group delete --stop.
                  </p>
                )}
                {group.pending_name && (
                  <p role="status">Creation pending: {group.pending_name}</p>
                )}
              </div>
              <div className="tw-group-row-actions">
                {group.pending_name && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={disabled || Boolean(busy) || group.deleting}
                    onPress={() =>
                      void act(group.id, 'group-reconcile', {
                        group: group.name,
                      })
                    }
                  >
                    Check creation
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
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
                  Delete group
                </Button>
              </div>
            </div>
          ))}
        </div>
        <p className="tw-group-hint">
          Deleting a group removes its saved restoration settings. Its running
          terminals become ungrouped.
        </p>
        <form
          className="tw-group-form"
          onSubmit={(event) => {
            event.preventDefault()
            void act('create', 'group-create', {
              name: name.trim(),
              persistent,
              ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
              ...(shell.trim() ? { shell: shell.trim() } : {}),
            })
          }}
        >
          <h3>New group</h3>
          <TextField
            ref={nameInput}
            label="Group name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={48}
            required
            hint="Letters, numbers, underscores, and hyphens."
          />
          <TextField
            label="Default directory"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder={data.defaults.cwd}
          />
          <TextField
            label="Default shell"
            value={shell}
            onChange={(event) => setShell(event.target.value)}
            placeholder={data.defaults.shell}
          />
          <Checkbox
            label="Save new shells for restoration"
            isSelected={persistent}
            onChange={setPersistent}
          />
          <p className="tw-group-hint">
            Creates an empty group. Existing terminals added later keep their
            current process settings.
          </p>
          <Button
            type="submit"
            loading={busy === 'create'}
            disabled={
              disabled ||
              Boolean(busy) ||
              !/^[A-Za-z0-9_-]{1,48}$/.test(name.trim())
            }
          >
            Create group
          </Button>
        </form>
      </div>
    </Dialog>
  )
}

