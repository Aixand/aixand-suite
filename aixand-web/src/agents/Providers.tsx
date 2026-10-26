import { useEffect, useId, useState } from 'react'
import { Accordion, Button, Card, DescriptionList, DropdownMenu, EmptyState, Icon, StatusIndicator } from 'bbb-design'
import { PaneForm } from './AgentWorkspace'
import type { WorkspaceRenderer } from './AgentWorkspace'
import type { AgentJob, Provider, ProviderDiagnostics, ProviderInfo } from './client'
import type { AgentsModel } from './model'
import { isPendingOperation, OperationStatus } from './AgentOperations'
import { providerLabel } from './presentation'
import { ProviderSoftware } from './ProviderSoftware'
import { ProviderSetup } from './ProviderSetup'
import type { SetupSnapshot } from '../auth/agentSetup'

function installationMethod(provider: ProviderInfo) {
  if (provider.software?.bundled || provider.method === 'bundled') return 'Bundled with Aixand'
  if (!provider.installed) return 'Not installed'
  return provider.methods.find(item => item.id === provider.method)?.label
    ?? ({ installer: 'Official installer', npm: 'npm', brew: 'Homebrew', standalone: 'Standalone executable' } as Record<string, string>)[provider.method ?? '']
    ?? 'Not detected'
}

function providerStatus(provider: ProviderInfo) {
  if (provider.software?.disabled) return 'Disabled';
  if (provider.sdkInstallations?.length) {
    if (provider.sdkInstallations.some(sdk => sdk.available))
      return provider.installed ? 'Installed for chat and terminal' : 'Installed for chat · Terminal not installed'
    return provider.installed ? 'Installed for terminal · Chat setup required' : 'Not installed'
  }
  if (provider.sdkInstallations?.length) {
    return `SDK ${provider.sdkInstallations.some(sdk => sdk.available) ? 'available' : 'unavailable'} · ${provider.version ? `CLI ${provider.version}` : provider.installed ? 'CLI needs setup check' : 'CLI not installed'}`
  }
  return provider.version ? `Installed · ${provider.version}` : provider.installed ? 'Needs setup check' : 'Not installed'
}

export function Providers({ agents: a, navigate, workspace, route = 'agents/providers' }: { agents: AgentsModel; navigate: (route: string) => void; workspace?: WorkspaceRenderer; route?: string }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<Provider | null>(null)
  const [editing, setEditing] = useState<{ provider: ProviderInfo; mode: 'update' | 'install' | 'repair' | 'details' | 'diagnostics' } | null>(null)
  const [diagnostics, setDiagnostics] = useState<ProviderDiagnostics | null>(null)
  const [environment, setEnvironment] = useState<SetupSnapshot['environment']>()
  const [jobId, setJobId] = useState<string | null>(null)
  const formId = useId()
  const connected = a.status === 'connected'
  const parameters = new URLSearchParams(route.split('?')[1])
  const requestedProvider = parameters.get('provider')
  const completion = a.operations.filter((job) => !isPendingOperation(job)).map((job) => job.id).join(',')
  useEffect(() => {
    if (!connected) return
    let current = true
    setLoading(true)
    void a.request<SetupSnapshot>('providers').then((value) => {
      if (current) { setProviders(value.providers ?? []); setEnvironment(value.environment); setError('') }
    }).catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : 'Provider refresh failed.') })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [connected, completion])
  useEffect(() => {
    const provider = providers.find(row => row.provider === requestedProvider)
    if (provider && editing?.provider.provider !== requestedProvider) setEditing({ provider, mode: 'details' })
  }, [requestedProvider, providers])
  const provider = editing && (providers.find((row) => row.provider === editing.provider.provider) ?? editing.provider)
  const pending = provider && a.operations.some((row) => row.provider === provider.provider && isPendingOperation(row))
  const job = a.operations.find((row) => row.id === jobId)
  const installMode = editing?.mode === 'install'
  const maintenance = editing && ['update', 'repair'].includes(editing.mode)
  const ManagementContainer = editing?.mode === 'details' ? 'details' : 'div'

  async function refreshProviders() {
    const value = await a.request<SetupSnapshot>('providers')
    setProviders(value.providers ?? []); setEnvironment(value.environment)
  }
  function close() {
    setEditing(null)
    if (requestedProvider) navigate('agents/providers')
  }

  function open(provider: ProviderInfo, mode: NonNullable<typeof editing>['mode']) {
    setEditing({ provider, mode }); setDiagnostics(null); setJobId(null); setError('')
    if (mode === 'details') navigate(`agents/providers?provider=${encodeURIComponent(provider.provider)}`)
    if (mode === 'diagnostics') {
      setBusy(provider.provider)
      void a.request<ProviderDiagnostics>('provider-diagnostics', { provider: provider.provider })
        .then(setDiagnostics).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Setup check failed.'))
        .finally(() => setBusy(null))
    }
  }
  async function start() {
    if (!editing || !provider || busy) return
    setBusy(provider.provider); setError('')
    const key = crypto.randomUUID()
    setJobId(key)
    try {
      const result = await a.request<AgentJob>('agent-operation-start', {
        key, provider: provider.provider, kind: editing.mode,
        whenIdle: true,
      })
      setJobId(result.id)
      await a.refreshOperations()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Provider operation failed.')
      void a.refreshOperations()
    } finally { setBusy(null) }
  }
  async function checkUpdates(provider: ProviderInfo) {
    setBusy(provider.provider); setError('')
    try {
      const result = await a.request<ProviderInfo>('provider-check-updates', { provider: provider.provider })
      setProviders((rows) => rows.map((row) => row.provider === result.provider ? result : row))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Update check failed.') }
    finally { setBusy(null) }
  }

  const sdkDetails = provider?.sdkInstallations?.map(sdk => ({
    id: sdk.backend, title: `${sdk.label} installation`, content: <section key={sdk.backend} aria-label={`${sdk.label} installation`} className="agents-sheet-form">

      <StatusIndicator tone={provider?.software?.disabled ? 'neutral' : sdk.available ? 'success' : 'neutral'} label={provider?.software?.disabled ? 'SDK kept · Provider disabled' : sdk.available ? 'Available for chat' : 'Unavailable for chat'}/>
      <DescriptionList items={[
            { id: 'sdk-package', label: 'Package', value: sdk.package },
            { id: 'sdk-version', label: 'Installed version', value: sdk.version ?? 'Not installed' },
            { id: 'sdk-method', label: 'Installation method', value: sdk.installer ? `${sdk.installer} · server environment` : sdk.version ? 'Server environment' : 'Not installed' },
            ...(sdk.version !== sdk.requiredVersion ? [{ id: 'sdk-required', label: 'Required version', value: sdk.requiredVersion }] : []),
        ]}/>
      {sdk.error && <p className="agents-error">{sdk.error}</p>}
      {!sdk.available && <Button variant="secondary" disabled={!connected || !!busy || !!pending} onPress={() => {
                setBusy(provider.provider);
                setError('');
                void a.request<AgentJob>('agent-operation-start', { key: crypto.randomUUID(), provider: provider.provider,
                    kind: 'install-sdk', whenIdle: true }).then(async (job) => {
                    setJobId(job.id);
                    await a.refreshOperations();
                    navigate('agents/operations');
                }).catch(cause => setError(cause instanceof Error ? cause.message : 'Could not install provider SDK.'))
                    .finally(() => setBusy(null));
            }}>Install SDK for chat</Button>}
      <p className="ws-note">SDK packages are managed in the server environment. Check sign-in in profile settings.</p>
    </section>,
})) ?? []
  const details = editing && provider ? <PaneForm inline={!!workspace} title={editing.mode === 'details' ? providerLabel(provider.provider)
        : `${editing.mode === 'diagnostics' ? 'Check setup' : editing.mode === 'update' ? 'Update' : editing.mode === 'repair' ? 'Repair' : 'Install'} ${providerLabel(provider.provider)}`} className="agents-sheet" trigger={<Button hidden>Open provider details</Button>} open onOpenChange={(open) => { if (!open)
    close(); }} footer={<>
        <Button variant="ghost" onPress={close}>{maintenance && !job && !busy ? 'Cancel' : 'Close'}</Button>
        {maintenance && (!job || ['failed', 'cancelled'].includes(job.status)) && <Button form={formId} type="submit" loading={!!busy} disabled={!connected || !!busy || !!pending || (!installMode && editing.mode !== 'repair' && !provider.canUpdate)}>
          {installMode ? 'Install provider' : editing.mode === 'repair' ? 'Repair installation'
                : provider.activeProfiles.length ? 'Update when idle' : 'Update provider'}</Button>}
      </>}>
      {error && <p role="alert" className="agents-error">{error}</p>}
      {(editing.mode === 'details' || installMode) && a.catalog && !provider.software?.disabled && <ProviderSetup key={`${provider.provider}/${parameters.get('setup') ?? ''}/${parameters.get('auth') ?? ''}/${parameters.get('flow') ?? ''}`} agents={a} catalog={a.catalog} info={provider} snapshot={{ providers, environment }} refresh={refreshProviders} navigate={navigate} forceNew={parameters.get('setup') === 'profile'} initialAuth={parameters.get('auth') ?? undefined} initialName={parameters.get('name') ?? undefined} context={parameters.get('flow') ?? undefined}/>}
      <ManagementContainer key={provider.provider} className="provider-maintenance">
      {editing.mode === 'details' && <summary>Software and maintenance<Icon name="chevron-down"/></summary>}
      {editing.mode === 'details' && <ProviderSoftware provider={provider} agents={a} navigate={navigate} refresh={refreshProviders}/>}
      {editing.mode === 'details' && <p className="carrier-muted">{providerStatus(provider)}</p>}
      {workspace && editing.mode === 'details' && <div className="ws-actions">

        {provider.installed && <Button disabled={!connected || !!busy || !!pending || !provider.methods.length || !provider.canUpdate} onPress={() => open(provider, 'update')}>Update</Button>}
        {<DropdownMenu label={`${providerLabel(provider.provider)} actions`} trigger={<Button className="content-utility" variant="ghost" iconOnly aria-label={`${providerLabel(provider.provider)} actions`}><Icon name="ellipsis"/></Button>} items={[
                { id: 'updates', label: 'Check for updates', disabled: !connected || !!busy || !!pending || !provider.methods.length },
                { id: 'diagnostics', label: 'Check setup', disabled: !connected || !!busy },
                { id: 'repair', label: 'Repair installation', disabled: !connected || !!busy || !!pending || !provider.installed || !provider.methods.some(method => method.id === provider.method) },
            ]} onAction={action => { if (action === 'updates')
            void checkUpdates(provider);
        else
            open(provider, action === 'diagnostics' ? 'diagnostics' : 'repair'); }}/>}
      </div>}

      {maintenance && <form id={formId} className="agents-sheet-form" onSubmit={(event) => { event.preventDefault(); void start(); }}>
        <p>{installMode ? `Install ${providerLabel(provider.provider)} on this machine.`
            : `${editing.mode === 'repair' ? 'Repairing' : 'Updating'} ${providerLabel(provider.provider)} affects every profile that uses it.`}</p>
        {provider.activeProfiles.length > 0 && <p className="ws-note">Waiting for agents in {provider.activeProfiles.join(', ')} to finish. The operation starts when the provider is idle.</p>}
        <p className="ws-note">Progress and installer output stay available in its terminal. You can close these details while it runs.</p>
      </form>}
      {editing.mode === 'diagnostics' && <div className="agents-sheet-form">
        {busy && <p role="status">Checking setup…</p>}
        {diagnostics?.checks.map((check) => <div key={check.label} className="agents-diagnostic">
          <StatusIndicator tone={check.status === 'passed' ? 'success' : 'warning'} label={check.label}/>
          <p>{check.message}</p>
        </div>)}
      </div>}
      {!!sdkDetails.length && <Accordion items={sdkDetails}/>}
      <Accordion defaultExpandedKeys={[]} items={[{
            id: 'installation', title: provider.sdkInstallations?.length ? 'CLI installation details' : 'Installation details', content: <div className="agents-sheet-form">
          <DescriptionList items={[
                    { id: 'version', label: 'Installed version', value: provider.version ?? 'Unavailable' },
                    ...(provider.latestVersion ? [{ id: 'latest', label: 'Latest published release', value: provider.latestVersion }] : []),
                    { id: 'method', label: 'Installation method', value: installationMethod(provider) },
                    { id: 'path', label: 'Executable', value: provider.path ?? 'Not found' },
                    ...(provider.checkedAt ? [{ id: 'checked', label: 'Updates checked', value: new Date(provider.checkedAt).toLocaleString() }] : []),
                ]}/>
          {provider.error && <p className="agents-error">{provider.error}</p>}
          {provider.maintenanceNote && <p className="ws-note">{provider.maintenanceNote}</p>}
          {provider.method === 'brew' && <p className="ws-note">Updates use Homebrew and respect package pins. Its available release may differ from the latest published version.</p>}
        </div>,
        }]}/>
      </ManagementContainer>
      {job && <OperationStatus job={job} agents={a} navigate={navigate}/>}
    </PaneForm> : null
  if (workspace) return workspace({ title: 'Providers', description: `${providers.length} providers`, selected: !!editing, onBack: close,
    list: <div className="carrier-message-scroll">{providers.map((item) => <Button key={item.provider} variant="ghost" className="carrier-message-row"
      aria-label={providerLabel(item.provider)} aria-pressed={editing?.provider.provider === item.provider} onPress={() => open(item, 'details')}>
      <span className="carrier-row-title">{providerLabel(item.provider)}</span><span className="carrier-row-preview">{providerStatus(item)}</span>
    </Button>)}{loading && <p role="status" className="carrier-navigation-note">Checking installed providers…</p>}{error && !editing && <p role="alert" className="agents-error">{error}</p>}</div>,
    reader: details ?? <div className="carrier-reader-empty"><EmptyState headingLevel={2} icon="box" title="Select a provider" description="Install a provider, connect an account, and create a profile. You can continue unfinished setup here." /></div>,
  })
  return <div className="agents-collection">
    <div className="agents-section-heading"><p>Manage the apps used by all your agent profiles.</p>
      <Button variant="ghost" size="sm" disabled={!connected || loading || !!busy} loading={loading}
        onPress={() => {
          setLoading(true); setError('')
          void a.request<{ providers: ProviderInfo[] }>('providers').then((value) => setProviders(value.providers ?? []))
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Provider refresh failed.'))
            .finally(() => setLoading(false))
        }}><Icon name="refresh-cw" />Refresh providers</Button>
    </div>
    {error && !editing && <p role="alert" className="agents-error">{error}</p>}
    {loading && !providers.length && <p role="status" className="ws-note">Checking installed providers…</p>}
    <div className="agents-provider-grid">
      {providers.map((provider) => {
        const active = a.operations.find((row) => row.provider === provider.provider && isPendingOperation(row))
        const disabled = !connected || !!busy || !!active
        const tone = provider.sdkInstallations?.length ? provider.sdkInstallations.some(sdk => sdk.available) ? 'success' : 'warning'
          : provider.installed && provider.version ? 'success' : provider.installed ? 'warning' : 'neutral'
        return <Card as="section" aria-label={providerLabel(provider.provider)} className="agents-provider" key={provider.provider}>
          <div className="agents-provider-heading"><h2>{providerLabel(provider.provider)}</h2>
            <DropdownMenu label={`${providerLabel(provider.provider)} actions`} trigger={<Button iconOnly variant="ghost" size="sm"
              aria-label={`${providerLabel(provider.provider)} actions`}><Icon name="ellipsis" /></Button>}
              items={[{ id: 'updates', label: 'Check for updates', disabled: disabled || !provider.methods.length },
                { id: 'diagnostics', label: 'Check setup', disabled: !connected || !!busy },
                { id: 'repair', label: 'Repair installation', disabled: disabled || !provider.installed || !provider.methods.some(method => method.id === provider.method) },
                { id: 'details', label: 'Installation details' }]}
              onAction={(action) => action === 'updates' ? void checkUpdates(provider)
                : open(provider, action as 'diagnostics' | 'repair' | 'details')} />
          </div>
          <StatusIndicator tone={active ? 'neutral' : tone}
            label={active ? active.status === 'queued' ? 'Operation queued' : 'Operation in progress'
              : providerStatus(provider)} />
          {provider.latestVersion && <p className="ws-note">Latest published release: {provider.latestVersion}
            {provider.latestVersion === provider.version ? ' · Up to date' : ''}</p>}
          {provider.updateError && <p role="alert" className="agents-error">{provider.updateError}</p>}
          {provider.installed && !provider.canUpdate && <p className="ws-note">{provider.maintenanceNote ?? 'Automatic updates are unavailable. Open installation details for the next step.'}</p>}
          <div className="agents-provider-footer">
            {provider.installed && <Button variant="secondary" size="sm" disabled={disabled || !provider.methods.length} loading={busy === provider.provider}
              onPress={() => void checkUpdates(provider)}>Check for updates</Button>}
            <Button disabled={disabled || !provider.methods.length || provider.installed && !provider.canUpdate}
              onPress={() => open(provider, provider.installed ? 'update' : 'install')}>{provider.installed ? 'Update' : 'Install'}</Button>
          </div>
        </Card>
      })}
    </div>
    {details}
  </div>
}
