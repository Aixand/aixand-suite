import { Button, Icon, LoadingIndicator, type IconName } from 'bbb-design'
import { providerUsable, type SetupSnapshot } from './agentSetup'
import './setup-check.css'

export function SetupActivity({ label, description }: { label: string; description?: string }) {
  return <div className="setup-activity">
    <LoadingIndicator label={label} />
    {description && <p>{description}</p>}
  </div>
}

export function SetupCheck({ connected, connecting, restored, detected, snapshot, error, onRetry, onReconnect }: {
  connected: boolean
  connecting: boolean
  restored: boolean
  detected: boolean
  snapshot: SetupSnapshot
  error: string
  onRetry: () => void
  onReconnect: () => void
}) {
  const paused = Boolean(error) || !connected && !connecting
  const installed = snapshot.providers.filter(providerUsable).length
  const checks: { title: string; detail: string; icon: IconName; complete: boolean; active: boolean }[] = [
    { title: 'Workspace connection', icon: 'monitor', complete: connected, active: !connected,
      detail: connected ? 'Connected to the computer running Suite' : 'Connecting to the computer running Suite' },
    { title: 'Saved setup', icon: 'rotate-ccw-clock', complete: restored, active: connected && !restored,
      detail: restored ? 'Your setup progress is loaded' : 'Looking for your previous progress' },
    { title: 'Agent tools', icon: 'square-terminal', complete: detected, active: connected && restored && !detected,
      detail: detected ? `${installed} installed ${installed === 1 ? 'agent' : 'agents'} found` : 'Detecting installed agents and available tools' },
  ]
  const active = checks.find(check => !check.complete && check.active)
  return <section className="setup-check" aria-label="Workspace checks" tabIndex={0} data-paused={paused || undefined}>
    <div className="setup-check-intro">
      <div className="setup-check-machine" aria-hidden="true">
        <span className="setup-check-orbit" />
        <span className="setup-check-device"><Icon name="monitor" /><span /></span>
        <span className="setup-check-spark"><Icon name={paused ? 'info' : 'sparkles'} /></span>
      </div>
      <span className="setup-check-eyebrow">Getting ready</span>
      <h2>{paused ? 'Let’s finish checking your setup' : 'Checking your setup'}</h2>
      <p>Finding your tools and picking up where you left off.</p>
    </div>
    <ul className="setup-check-list">
      {checks.map(check => {
        const state = check.complete ? 'complete' : check.active ? paused ? 'paused' : 'checking' : 'waiting'
        return <li key={check.title} data-state={state}>
          <span className="setup-check-icon" aria-hidden="true"><Icon name={check.icon} /></span>
          <div className="setup-check-copy"><strong>{check.title}</strong><span>{check.detail}</span></div>
          <span className="setup-check-state">
            {state === 'complete' ? <Icon name="circle-check" /> : state === 'checking' ? <span className="setup-check-spinner" aria-hidden="true" /> : null}
            {state === 'complete' ? 'Ready' : state === 'checking' ? 'Checking' : state === 'paused' ? 'Paused' : 'Waiting'}
          </span>
        </li>
      })}
    </ul>
    <p className="bbb-visually-hidden" role="status">{paused ? 'Setup checks paused.' : active ? `${active.title}: ${active.detail}.` : 'Setup checks complete.'}</p>
    {paused ? <div className="setup-check-retry">
      <p role="alert">{error || 'The connection was interrupted. Reconnect to continue checking your setup.'}</p>
      <Button variant="secondary" onPress={connected ? onRetry : onReconnect}>
        <Icon name="refresh-cw" />{connected ? 'Refresh setup' : 'Reconnect to Agent Manager'}
      </Button>
    </div> : <div className="setup-check-footer"><Icon name="info" />
      <span>{snapshot.environment && detected ? `${snapshot.environment.label} · ${snapshot.environment.architecture}` : 'Checking the computer running Aixand Suite.'}</span>
    </div>}
  </section>
}
