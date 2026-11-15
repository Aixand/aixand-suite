import { useState } from 'react'
import { Button, Select } from 'bbb-design'
import type { ProviderInfo } from './client'

export function ProviderTerminalCommand({ provider, disabled, onSetup }: {
  provider: ProviderInfo; disabled: boolean; onSetup?: (policy: 'keep' | 'prefer') => void
}) {
  const [choice, setChoice] = useState<'keep' | 'prefer' | null>(null)
  const command = provider.terminalCommand
  if (!command || !provider.installed) return null
  const preference = command.hasExisting ? choice ?? command.policy : 'prefer'
  return <section className="agents-sheet-form" aria-label={`${provider.label ?? provider.provider} terminal command`}>
    <h4>Use in your terminal</h4>
    <p role="status">{command.ready ? <><code>{command.command}</code> is available in your terminal.</>
      : 'CLI installed; terminal command setup needs attention.'}</p>
    {command.ready && <>
      {command.usingExisting && command.hasExisting && <p>Your current <code>{command.command}</code> command is selected. Use <code>{command.alias}</code> to run the Aixand-installed copy.</p>}
      <p>Open a new terminal window on the Aixand host after setup. Terminal commands use the provider’s normal account settings; Aixand keeps its selected profile.</p>
      {command.path && <p>Managed command: <code>{command.path}</code></p>}
    </>}
    {!command.ready && command.error && <p>{command.error}</p>}
    {(!command.ready || command.hasExisting) && onSetup && <>
      <Select label="Terminal command preference" variant="outlined" value={preference} disabled={disabled}
        options={[
          { id: 'keep', label: 'Use currently installed commands', disabled: !command.hasExisting },
          { id: 'prefer', label: 'Use newly installed commands' },
        ]} onChange={value => setChoice(value as 'keep' | 'prefer')} />
      {command.existingPaths?.map(path => <p key={path}>Existing command: <code>{path}</code></p>)}
    </>}
    {onSetup && <Button variant="secondary" disabled={disabled} onPress={() => onSetup(preference)}>
      {command.ready ? 'Repair terminal command' : 'Set up terminal command'}
    </Button>}
  </section>
}
