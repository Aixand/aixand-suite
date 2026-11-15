import { randomUUID } from '../uuid'
import { useState } from 'react'
import { Button, CopyButton, DropdownMenu, Icon } from 'bbb-design'
import type { AgentJob, ProviderInfo } from './client'
import type { AgentsModel } from './model'
import { isPendingOperation, OperationStatus } from './AgentOperations'
import { providerLabel } from './presentation'
import { ProviderTerminalCommand } from './ProviderTerminalCommand'
import { ProviderVersion } from './ProviderVersion'

export function ProviderSoftware({ provider, agents, navigate, refresh }: {
  provider: ProviderInfo; agents: AgentsModel; navigate: (route: string) => void
  refresh: () => Promise<void>
}) {
  const [mode, setMode] = useState<'uninstall' | 'manual' | 'disable' | 'enable' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState<AgentJob | null>(null)
  const software = provider.software
  if (!software) return null
  const pending = agents.operations.some(row => row.provider === provider.provider && isPendingOperation(row))
  const blocked = busy || pending || agents.status !== 'connected'
  const title = mode === 'uninstall' ? `Uninstall ${providerLabel(provider.provider)} CLI`
    : mode === 'manual' ? `Manually uninstall ${providerLabel(provider.provider)}`
      : mode === 'disable' ? `Disable ${providerLabel(provider.provider)}` : `Restore ${providerLabel(provider.provider)}`
  function review(value: NonNullable<typeof mode>) { setMode(value); setJob(null); setError('') }
  async function check() {
    setBusy(true); setError('')
    try { await refresh(); setMode(null); setJob(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check installation.') }
    finally { setBusy(false) }
  }
  async function confirm() {
    if (blocked || !mode || mode === 'manual') return
    setBusy(true); setError('')
    try {
      setJob(await agents.request<AgentJob>('agent-operation-start', {
        key: randomUUID(), provider: provider.provider, kind: mode,
        installationRevision: software!.revision, confirmed: true, whenIdle: true,
      }))
      await agents.refreshOperations()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Provider operation failed. Refresh installation before retrying.')
    } finally { setBusy(false) }
  }
  async function setupCommand(terminalPolicy: 'keep' | 'prefer') {
    setBusy(true); setError('')
    try {
      setJob(await agents.request<AgentJob>('agent-operation-start', {
        key: randomUUID(), provider: provider.provider, kind: 'setup-command', terminalPolicy, whenIdle: true,
      }))
      await agents.refreshOperations()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not set up terminal command.') }
    finally { setBusy(false) }
  }
  async function restoreVersion() {
    setBusy(true); setError('')
    try {
      setJob(await agents.request<AgentJob>('agent-operation-start', {
        key: randomUUID(), provider: provider.provider, kind: 'repair', versionTarget: 'recommended', whenIdle: true,
      }))
      await agents.refreshOperations()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore the tested version.') }
    finally { setBusy(false) }
  }
  return <section className="agents-sheet-form" aria-label="Provider software management">
    <ProviderVersion provider={provider} disabled={blocked} onRestore={() => void restoreVersion()} />
    <div className="ws-actions">
      <Button variant="ghost" disabled={blocked} onPress={() => review(software.disabled ? 'enable' : 'disable')}>
        {software.disabled ? 'Restore provider' : software.bundled ? 'Disable bundled provider' : 'Disable provider'}
      </Button>
      {provider.installed && !software.bundled && <DropdownMenu label={`${providerLabel(provider.provider)} uninstall options`}
        trigger={<Button variant="ghost" disabled={blocked}>Uninstall CLI<Icon name="chevron-down" /></Button>}
        items={[
          { id: 'automatic', label: 'Uninstall automatically', disabled: !software.automatic },
          { id: 'manual', label: 'Uninstall manually' },
        ]} onAction={action => review(action === 'automatic' ? 'uninstall' : 'manual')} />}
    </div>
    {software.disabled && <p role="status">This provider is disabled in this workspace. Its installed SDKs, accounts and profiles are preserved.</p>}
    {software.disabled && <ProviderTerminalCommand provider={provider} disabled={blocked} onSetup={policy => void setupCommand(policy)} />}
    {!mode && job && <OperationStatus job={job} agents={agents} navigate={navigate} />}
    {software.bundled && <p className="ws-note">This CLI is included with Aixand. Disabling the provider keeps its bundled files for restoration.</p>}
    {!software.bundled && provider.installed && !software.automatic && <p className="ws-note">{software.reason}</p>}
    {mode && <section className="agents-sheet-form" aria-label={title}>
      <h3>{title}</h3>
      {software.path && <p>CLI location: <code>{software.path}</code></p>}
      {mode === 'manual' ? <>
        <ol>{software.manualSteps.map(step => <li key={step}>{step}</li>)}</ol>
        {software.manualCommands.map(command => <div key={command}><pre><code>{command}</code></pre><CopyButton text={command} label="Copy uninstall command" /></div>)}
        {software.docs && <a href={software.docs} target="_blank" rel="noopener noreferrer">Official {providerLabel(provider.provider)} instructions</a>}
        <p>CLI removal keeps saved accounts, profiles, provider settings and project files.</p>
        <Button variant="secondary" disabled={blocked} onPress={() => void check()}>Check installation</Button>
      </> : <>
        <p>{mode === 'uninstall' ? 'Remove this separately installed CLI from the Suite host. This affects other applications using this installation.'
          : mode === 'disable' ? 'Prevent new agent sessions with this provider. Installed SDK and CLI files stay on this computer.'
            : 'Allow this provider to run again using its existing installation.'}</p>
        {mode === 'uninstall' && software.targets.length > 0 && <ul>{software.targets.map(path => <li key={path}><code>{path}</code></li>)}</ul>}
        <p>Saved accounts, profiles and project files are preserved. Active agents must finish before this action runs.</p>
        {!job && <Button disabled={blocked || mode === 'uninstall' && !software.automatic} loading={busy} onPress={() => void confirm()}>
          {mode === 'uninstall' ? 'Confirm uninstall CLI' : mode === 'disable' ? 'Confirm disable provider' : 'Confirm restore provider'}
        </Button>}
      </>}
      {job && <OperationStatus job={job} agents={agents} navigate={navigate} />}
      {job && <Button variant="secondary" disabled={blocked} onPress={() => void check()}>Refresh installation</Button>}
      <Button variant="ghost" onPress={() => setMode(null)}>Close</Button>
    </section>}
    {error && <p role="alert">{error}</p>}
  </section>
}
