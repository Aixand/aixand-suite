import { saveProfileChanges } from './accountPresentation'
import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Select, TextField } from 'bbb-design'
import { useContentFieldVariant } from '../branding/ContentTheme'
import type { AgentsModel } from './model'
import type { AgentJob, Profile } from './client'

type Account = {
  id: string; name: string; directory: string; owned: boolean; profiles: string[]; revision: string
  status: { state: string; signedIn: boolean; email?: string; checkedAt?: number }
}
type Inventory = { accounts: Account[]; disconnectedAccounts?: Account[]; migrationRequired: boolean }

export function ClaudeAccounts({ agents, profile, disabled, navigate, onSelectionChange }: {
  agents: AgentsModel; profile: Profile; disabled: boolean; navigate: (route: string) => void
  onSelectionChange?: (accountId: string | null) => void
}) {
  const variant = useContentFieldVariant()
  const [inventory, setInventory] = useState<Inventory>({ accounts: [], migrationRequired: false })
  const [selected, setSelected] = useState(profile.claude_account?.id ?? '')
  const [name, setName] = useState('')
  const [external, setExternal] = useState(false)
  const [directory, setDirectory] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<'logout' | 'remove' | 'migrate' | null>(null)
  const statusChecks = useRef(new Map<string, Promise<unknown>>())
  const completed = agents.operations.filter(job => ['succeeded', 'failed', 'cancelled'].includes(job.status)).map(job => job.id).join(',')

  async function refresh() {
    const value = await agents.request<Inventory>('claude-accounts', {})
    setInventory(value)
    return value
  }
  useEffect(() => {
    let active = true
    void agents.request<Inventory>('claude-accounts', {}).then(async value => {
      if (active) setInventory(value)
      const current = value.accounts.find(row => row.id === profile.claude_account?.id)
      if (current && Date.now() - (current.status.checkedAt ?? 0) > 60_000) {
        let pending = statusChecks.current.get(current.id)
        if (!pending) {
          pending = agents.request('claude-account-check', { accountId: current.id })
          statusChecks.current.set(current.id, pending)
        }
        try { await pending }
        finally { statusChecks.current.delete(current.id) }
        const refreshed = await agents.request<Inventory>('claude-accounts', {})
        if (active) setInventory(refreshed)
      }
    })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load Claude accounts.') })
    return () => { active = false }
  }, [agents.request, completed, profile.claude_account?.id])
  useEffect(() => { setSelected(profile.claude_account?.id ?? '') }, [profile.claude_account?.id])
  const account = inventory.accounts.find(row => row.id === selected)

  async function act(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await work(); await refresh(); await agents.refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Claude account operation failed.') }
    finally { setBusy(false) }
  }
  async function bind(identifier: string | null) {
    if (onSelectionChange) { onSelectionChange(identifier); return }
    await saveProfileChanges(agents, profile, { claudeAccountId: identifier })
  }
  const blocked = disabled || busy
  return <section className="agents-form-section" aria-label="Claude accounts">
    <p>Claude manages sign-in and credentials on the backend machine. Several profiles can use the same account. Existing chats retain their original account.</p>
    {inventory.migrationRequired ? <>
      <p>Saved Claude logins need migration. Chat history will be preserved, Manager’s token copies removed, and official sign-in required again.</p>
      <Button variant="secondary" disabled={blocked} onPress={() => setConfirm('migrate')}>Migrate saved Claude logins</Button>
    </> : <>
      <Select variant={variant} label="Claude account" value={selected} disabled={blocked}
        options={[{ id: '', label: 'No account selected' }, ...inventory.accounts.map(row => ({ id: row.id,
          label: `${row.name}${row.status.email ? ` · ${row.status.email}` : ''}` }))]} onChange={value => { setSelected(value); onSelectionChange?.(value || null); setConfirm(null) }} />
      {!onSelectionChange && <Button variant="secondary" disabled={blocked} onPress={() => void act(async () => {
        await bind(selected || null); setNotice('Account selection saved for new sessions.')
      })}>Use selected account</Button>}
      {onSelectionChange && selected !== (profile.claude_account?.id ?? '') && <p>Save profile to apply this account before signing in.</p>}
      {account && <>
        <p>{({ unchecked: 'Status not checked', 'signed-in': 'Signed in', 'sign-in-required': 'Sign-in required',
          unavailable: 'Status check unavailable', 'identity-unavailable': 'Claude could not confirm the original account identity.',
          'account-mismatch': 'A different account signed in. Create a separate account entry to use it.' } as Record<string, string>)[account.status.state] ?? 'Status not checked'}
          {account.owned ? ' · Aixand-specific login' : ' · Existing login shared with other applications'}</p>
        <p><code>{account.directory}</code></p>
        <div className="agents-actions">
          <Button variant="secondary" disabled={blocked || !!onSelectionChange && account.id !== profile.claude_account?.id} onPress={() => void act(async () => {
            await bind(account.id)
            const current = await agents.request<{ revision: string }>('agent-profile-get', { provider: 'claude', profile: profile.profile })
            const job = await agents.request<AgentJob>('agent-operation-start', { key: crypto.randomUUID(), provider: 'claude',
              profile: profile.profile, kind: 'profile-login', expectedRevision: current.revision })
            if (job.sessionId) navigate(`terminals/${encodeURIComponent(job.sessionId)}`)
            else navigate('agents/operations')
          })}>Sign in through Claude</Button>
          <Button variant="secondary" disabled={blocked} onPress={() => void act(async () => {
            await agents.request('claude-account-check', { accountId: account.id })
          })}>Refresh account status</Button>
          <Button variant="secondary" disabled={blocked} onPress={() => setConfirm('logout')}>Sign out</Button>
          <Button variant="secondary" disabled={blocked || account.profiles.length > 0} onPress={() => setConfirm('remove')}>Disconnect account</Button>
        </div>
      </>}
      <TextField variant={variant} label="New account name" value={name} disabled={blocked} maxLength={128}
        hint="Letters, numbers, hyphens and underscores." onChange={event => setName(event.target.value)} />
      <Checkbox label="Use an existing Claude configuration directory" isSelected={external} onChange={setExternal} disabled={blocked} />
      {external && <TextField variant={variant} label="Existing directory on the backend machine" value={directory} disabled={blocked}
        hint="Use the absolute path. Claude login and history in this directory may be shared with other applications."
        onChange={event => setDirectory(event.target.value)} />}
      <Button variant="secondary" disabled={blocked || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name) || external && !directory.trim()}
        onPress={() => void act(async () => {
          const created = await agents.request<Account>('claude-account-create', { key: crypto.randomUUID(), name,
            ...(external ? { directory: directory.trim() } : {}) })
          await bind(created.id); setSelected(created.id); setName(''); setDirectory('')
          if (external) await agents.request('claude-account-check', { accountId: created.id })
          setNotice(external ? 'Existing Claude account connected.' : 'Account created. Sign in through Claude to continue.')
        })}>{external ? 'Connect existing account' : 'Create account'}</Button>
      {inventory.disconnectedAccounts?.map(account => <Button key={account.id} variant="secondary" disabled={blocked}
        onPress={() => void act(async () => {
          const restored = await agents.request<Account>('claude-account-create', { key: crypto.randomUUID(),
            name: account.name, directory: account.directory })
          await bind(restored.id); setSelected(restored.id)
          await agents.request('claude-account-check', { accountId: restored.id })
          setNotice('Claude account reconnected with its original conversation identity.')
        })}>Reconnect {account.name}</Button>)}
    </>}
    {confirm && <div role="alert">
      <p>{confirm === 'migrate' ? 'Migrate all saved Claude logins and remove their token snapshots? Accounts will need official sign-in again. Stop active Claude sessions first.'
        : confirm === 'logout' ? `Sign out ${account?.name}? ${account?.owned ? 'Profiles and history will remain.' : 'This also signs out other applications using this directory.'}`
          : 'Disconnect this account? Native conversation files will be preserved.'}</p>
      <Button variant="danger" disabled={blocked} onPress={() => void act(async () => {
        if (confirm === 'migrate') await agents.request('claude-account-migrate', { key: crypto.randomUUID(), confirmed: true })
        else if (account) await agents.request(`claude-account-${confirm}`, { key: crypto.randomUUID(), accountId: account.id,
          expectedRevision: account.revision, confirmed: true })
        setConfirm(null)
      })}>Confirm {confirm === 'migrate' ? 'migration' : confirm === 'logout' ? 'sign-out' : 'disconnect'}</Button>
      <Button variant="secondary" disabled={blocked} onPress={() => setConfirm(null)}>Cancel</Button>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="agents-error">{error}</p>}
  </section>
}
