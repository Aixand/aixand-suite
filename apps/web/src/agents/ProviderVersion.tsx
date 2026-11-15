import { Button } from 'bbb-design'
import type { ProviderInfo } from './client'

export function ProviderVersion({ provider, disabled, onRestore }: {
  provider: ProviderInfo; disabled?: boolean; onRestore?: () => void
}) {
  const recommended = provider.recommendedVersion
  const compatibility = provider.compatibility
  if (!recommended) return null
  return <div className="setup-section-content" aria-label="Provider version compatibility">
    <p>Aixand installs version <strong>{recommended}</strong>.</p>
    {provider.installed && compatibility?.compatible && <p className="ws-note">
      Your installed version {provider.version} is compatible{compatibility.tested ? ' and tested with Aixand' : ''}.
    </p>}
    {provider.installed && compatibility && !compatibility.compatible && <p role="status">{compatibility.reason}</p>}
    {provider.installed && provider.chatCompatibility && !provider.chatCompatibility.compatible &&
      provider.chatCompatibility.reason !== compatibility?.reason && <p role="status">Chat integration: {provider.chatCompatibility.reason}</p>}
    {provider.installed && provider.method && ['installer', 'npm'].includes(provider.method) &&
      !provider.software?.bundled && !provider.software?.disabled && provider.version !== recommended && onRestore && <>
      <p className="ws-note">Restoring the tested version changes this shared CLI. Saved accounts and profiles are kept.</p>
      <Button variant="secondary" disabled={disabled} onPress={onRestore}>Restore tested version {recommended}</Button>
    </>}
  </div>
}
