import { useState, type ReactNode } from 'react'
import { Button, CopyButton, DropdownMenu, Icon, Select } from 'bbb-design'
import type { AgentJob } from '../agents/client'
import { isPendingOperation } from '../agents/operationState'
import { providerUsable, setupName, type SetupProvider, type SetupSnapshot } from './agentSetup'

export function AgentInstallation({ provider, snapshot, operations, disabled, preview, onInstall, onCheck, renderOperation }: {
  provider: SetupProvider
  snapshot: SetupSnapshot
  operations: AgentJob[]
  disabled: boolean
  preview: boolean
  onInstall: (method?: string) => void
  onCheck: () => void
  renderOperation: (job?: AgentJob) => ReactNode
}) {
  const [manual, setManual] = useState(false)
  const [chosen, setChosen] = useState('')
  const info = snapshot.providers.find(row => row.provider === provider)
  const installed = providerUsable(info)
  const receipt = operations.filter(row => row.provider === provider && row.kind === 'install').sort((a, b) => b.createdAt - a.createdAt)[0]
  const pending = operations.find(row => row.provider === provider && isPendingOperation(row))
  const available = info?.methods.filter(method => !method.error) ?? []
  const methods = info?.setup?.methods ?? []
  const method = methods.some(row => row.id === chosen) || available.some(row => row.id === chosen) ? chosen : available[0]?.id ?? methods[0]?.id ?? ''
  const guide = methods.find(row => row.id === method) ?? methods[0]
  const automatic = (snapshot.environment?.managedSupported ?? available.length > 0) && available.some(row => row.id === method)
  const choices = methods.length ? methods : info?.methods ?? []

  return <div className="setup-section-content">
    {!installed && <>
        <DropdownMenu label={`${setupName(provider, snapshot)} installation options`}
          trigger={<Button disabled={disabled || !!pending} aria-label={`Install ${setupName(provider, snapshot)}`}>{pending ? 'Installation in progress…' : 'Install'}<Icon name="chevron-down" /></Button>}
          items={[
            { id: 'automatic', label: 'Install automatically', disabled: !automatic, leading: <Icon name="arrow-down" /> },
            { id: 'manual', label: 'Install manually', disabled: !info?.setup, leading: <Icon name="square-terminal" /> },
            { id: 'check', label: 'Check existing install', leading: <Icon name="refresh-cw" /> },
          ]}
          onAction={action => {
            if (action === 'automatic') onInstall(method)
            if (action === 'manual') setManual(true)
            if (action === 'check') onCheck()
          }} />
        {!automatic && <p className="setup-note">{info?.setup ? 'Manual installation is required on this machine.'
          : 'This agent is unavailable on the Suite host. Check its Agent Manager configuration, then check the installation again.'}</p>}
        {choices.length > 1 && <Select variant="outlined" label="Installation method" value={method} disabled={disabled || !!pending}
          options={choices.map(row => ({ id: row.id, label: row.label, description: row.error ?? undefined, disabled: !!row.error }))} onChange={setChosen} />}
        {manual && info?.setup && <section className="setup-manual" aria-label="Manual installation steps">
          <h4>Install {setupName(provider, snapshot)} manually</h4>
          <ol>
            <li>Open {snapshot.environment?.os === 'windows' ? 'PowerShell' : snapshot.environment?.wsl ? 'your WSL terminal' : 'a terminal'} on the Suite host{snapshot.environment ? ` (${snapshot.environment.label})` : ''}. Use the OS account that runs Suite.</li>
            <li>{guide ? <>Run this command.{guide.error && <p>{guide.error}</p>}<pre><code>{guide.command}</code></pre><CopyButton text={guide.command} label="Copy installation command" /></>
              : <>Follow the provider’s installation guide.</>}
              <p><a href={info.setup.docs} target="_blank" rel="noopener noreferrer">Official {setupName(provider, snapshot)} installation guide</a></p></li>
            <li>Open a new terminal and check the version.<pre><code>{info.setup.verifyCommand}</code></pre><CopyButton text={info.setup.verifyCommand} label="Copy verification command" /></li>
            <li>Return here and check the installation.</li>
          </ol>
          <Button variant="secondary" disabled={disabled || !!pending} onPress={onCheck}>Check installation</Button>
          {preview && <Button variant="ghost" disabled={disabled || !!pending} onPress={() => onInstall()}>Simulate manual installation</Button>}
        </section>}
      </>}
    {(pending || receipt && !installed) && renderOperation(pending ?? receipt)}
    <details className="setup-connection-details">
      <summary>Installation details</summary>
      {info?.path && <p>Executable: <code>{info.path}</code></p>}
      {info?.error && <p>{info.error}</p>}
      {installed && receipt && renderOperation(receipt)}
      <Button variant="ghost" size="sm" disabled={disabled || !!pending} onPress={onCheck}><Icon name="refresh-cw" />Check installation</Button>
    </details>
  </div>
}
