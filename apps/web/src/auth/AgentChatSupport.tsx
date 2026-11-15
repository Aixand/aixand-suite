import type { ReactNode } from 'react'
import { Button, Icon } from 'bbb-design'
import type { AgentJob, ProviderInfo } from '../agents/client'
import { isPendingOperation } from '../agents/operationState'
import { providerSdksInstalled } from './agentSetup'

export function AgentChatSupport({ info, operations, disabled, onInstall, onCheck, renderOperation }: {
  info: ProviderInfo
  operations: AgentJob[]
  disabled: boolean
  onInstall: () => void
  onCheck: () => void
  renderOperation: (job?: AgentJob) => ReactNode
}) {
  const sdks = info.sdkInstallations ?? []
  const ready = providerSdksInstalled(info)
  const jobs = operations.filter(job => job.provider === info.provider)
  const pending = jobs.find(isPendingOperation)
  const receipt = jobs.filter(job => job.kind === 'install-sdk').sort((a, b) => b.createdAt - a.createdAt)[0]
  return <div className="setup-section-content">
    <p>{info.provider === 'copilot' ? 'Copilot ACP chat is available with the CLI. Install Copilot SDK to choose models before starting a chat, then select Copilot SDK in Chat settings.'
      : 'Install the provider’s SDK to connect it to Suite chat. This installs on the computer running Suite.'}</p>
    {sdks.map(sdk => <div className="setup-section-content" key={sdk.backend}>
      <p role="status"><Icon name={sdk.available ? 'circle-check' : 'info'} /> {sdk.label}: {sdk.available ? 'Installed' : 'Needs installation'}</p>
      <details className="setup-connection-details"><summary>SDK installation details</summary>
        <p>Package: <code>{sdk.package}</code></p>
        <p>Required version: {sdk.requiredVersion}</p>
        <p>Installed version: {sdk.version ?? 'Not installed'}</p>
      </details>
    </div>)}
    {!ready && <Button disabled={disabled || !!pending} onPress={onInstall}>
      {pending?.kind === 'install-sdk' ? 'Installing chat support…' : 'Install chat support'}
    </Button>}
    {pending && pending.kind !== 'install-sdk' && <p className="setup-note">Finish this provider’s current operation before installing chat support.</p>}
    {(pending || receipt) && renderOperation(pending ?? receipt)}
    {ready && <p className="setup-note">{info.provider === 'copilot' ? 'Copilot SDK is installed and uses your selected profile’s Copilot login.'
      : 'Chat support is installed. Chat account access is configured separately in your profile.'}</p>}
    <Button variant="ghost" size="sm" disabled={disabled || !!pending} onPress={onCheck}><Icon name="refresh-cw" />Check chat support</Button>
  </div>
}
