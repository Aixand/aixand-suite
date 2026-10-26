import { useState } from 'react'
import { Button, type ThemeMode } from 'bbb-design'
import { OnboardingScreen } from './OnboardingScreen'
import { PasswordForm, type PasswordInput } from './PasswordForm'
import { AgentOnboarding } from './AgentOnboarding'

// This preview deliberately has no authentication client or workspace mutations.
export function OnboardingPreview({
  mode,
  onClose,
}: {
  mode: ThemeMode
  onClose: () => void
}) {
  const [screen, setScreen] = useState<'setup' | 'login' | 'agents'>('setup')
  const [formVersion, setFormVersion] = useState(0)
  const [error, setError] = useState('')
  const [agentTitle, setAgentTitle] = useState('Set up your agents')
  function reset(next: 'setup' | 'login') {
    setScreen(next)
    setFormVersion((value) => value + 1)
    setError('')
  }
  function submit({ password, confirmation }: PasswordInput) {
    setError('')
    if (screen === 'setup') {
      if ([...password].length < 15 || [...password].length > 128) {
        setError('Use 15–128 characters and avoid common passwords.')
        return false
      }
      if (password !== confirmation) {
        setError('Passwords must match.')
        return false
      }
    }
    setScreen('agents')
    return true
  }
  return (
    <OnboardingScreen
      title={
        screen === 'agents' ? agentTitle : screen === 'setup' ? 'Set up your password' : 'Sign in to your Suite'
      }
      mode={mode}
      preview
      wide={screen === 'agents'}
      layout={screen === 'agents' ? 'setup' : 'auth'}
      onClose={onClose}
      onReplay={() => reset('setup')}
    >
      {screen === 'agents' ? <AgentOnboarding key={formVersion} embedded preview onClose={onClose} onTitleChange={setAgentTitle} /> : <>
      <p className="onboarding-description">
        {screen === 'setup'
          ? 'Choose one password for your Suite. Then continue to set up your agents.'
          : 'Enter your password to access this workspace.'}
      </p>
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      <PasswordForm
        key={formVersion}
        setup={screen === 'setup'}
        preview
        onSubmit={submit}
      />
      <div className="onboarding-preview-switch">
        <Button
          variant="ghost"
          onPress={() => reset(screen === 'setup' ? 'login' : 'setup')}
        >
          {screen === 'setup' ? 'View sign in' : 'View password setup'}
        </Button>
      </div>
      </>}
    </OnboardingScreen>
  )
}
