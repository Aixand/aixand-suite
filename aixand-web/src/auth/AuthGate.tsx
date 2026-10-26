import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Button, type ThemeMode } from 'bbb-design'
import { OnboardingScreen } from './OnboardingScreen'
import { OnboardingPreview } from './OnboardingPreview'
import { ProductOnboarding } from './ProductOnboarding'
import { PasswordForm, type PasswordInput } from './PasswordForm'
import { AuthError, authRequest } from './client'
import { recoveryPrompt } from './recovery'
import type { SetupProgress, SetupState } from './agentSetup'
import { acknowledgeResetOnboarding, resetOnboardingRequested } from '../settings/reset'

type Session = { authenticated: true; csrfToken: string; expiresAt: number; onboardingPending?: boolean; onboardingStep?: SetupProgress['step'] }
const AuthContext = createContext<{
  signOut: () => Promise<void>
  openOnboarding: (returnFocus?: HTMLElement, mode?: ThemeMode) => void
  onboardingPending: boolean
  onboardingStep?: SetupProgress['step']
  reconcileOnboarding: () => Promise<SetupState | null>
  startOnboarding: (manual?: boolean) => Promise<SetupState | null>
  completeOnboarding: (revision: number, skipProjects: boolean) => Promise<SetupState>
  saveOnboarding: (progress: SetupProgress, expectedRevision: number) => Promise<SetupState>
}>({
  signOut: async () => {},
  openOnboarding: () => {},
  onboardingPending: false,
  reconcileOnboarding: async () => null,
  startOnboarding: async () => null,
  completeOnboarding: async () => { throw new Error('Sign in before completing setup.') },
  saveOnboarding: async () => { throw new Error('Sign in before setting up agents.') },
})
export const useAuth = () => useContext(AuthContext)
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<
    | 'loading'
    | 'setup_pending'
    | 'setup_blocked'
    | 'login'
    | 'authenticated'
    | 'unavailable'
  >('loading')
  const [recovery, setRecovery] = useState(false)
  const [tab, setTab] = useState<'manual' | 'agent'>('manual')
  const [preview, setPreview] = useState<ThemeMode | null>(null)
  const [onboardingPending, setOnboardingPending] = useState(false)
  const [onboardingStep, setOnboardingStep] = useState<SetupProgress['step']>()
  const reconciliation = useRef<Promise<SetupState | null> | null>(null)
  const previewReturnFocus = useRef<HTMLElement | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const session = useRef<Session | null>(null)
  const generation = useRef(0)
  const checking = useRef(false)
  const mounted = useRef(true)
  async function check() {
    if (checking.current) return
    checking.current = true
    const version = generation.current
    try {
      const value = await authRequest<Session>('session')
      if (version !== generation.current) return
      if (resetOnboardingRequested()) {
        // Reset is a direct request to start setup, independent of inventory
        // discovery or an older session response's optional onboarding fields.
        const setup = await authRequest<SetupState>('onboarding/start', { manual: true }, value.csrfToken)
        if (version !== generation.current) return
        if (setup?.status !== 'pending') throw new Error('Could not restart agent setup. Reconnect to try again.')
        value.onboardingPending = true
        value.onboardingStep = setup.step
        acknowledgeResetOnboarding()
      }
      session.current = value
      setOnboardingPending(value.onboardingPending === true)
      setOnboardingStep(value.onboardingStep)
      setState('authenticated')
      setError('')
    } catch (cause) {
      if (version !== generation.current) return
      session.current = null
      setPreview(null)
      if (cause instanceof AuthError && cause.status === 401) {
        try {
          const status = await authRequest<{
            state: 'setup_pending' | 'configured'
            setupAllowed?: boolean
          }>('status')
          if (version === generation.current) {
            setState(
              status.state === 'setup_pending'
                ? status.setupAllowed === false
                  ? 'setup_blocked'
                  : 'setup_pending'
                : 'login',
            )
            setError('')
          }
        } catch (failure) {
          if (version === generation.current) {
            setState('unavailable')
            setError(
              failure instanceof Error
                ? failure.message
                : 'Authentication unavailable',
            )
          }
        }
      } else {
        setState('unavailable')
        setError(
          cause instanceof Error ? cause.message : 'Authentication unavailable',
        )
      }
    } finally {
      checking.current = false
      if (mounted.current && version !== generation.current) void check()
    }
  }
  useEffect(() => {
    mounted.current = true
    void check()
    const refresh = () => {
      void check()
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('aixand-auth-check', refresh)
    const timer = window.setInterval(refresh, 15_000)
    return () => {
      mounted.current = false
      generation.current++
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('aixand-auth-check', refresh)
    }
  }, [])
  async function submit({ password, confirmation }: PasswordInput) {
    setBusy(true)
    setError('')
    generation.current++
    try {
      if (state === 'setup_pending') {
        await authRequest('setup', { password, confirmation })
        window.location.hash = '/agents/providers'
      } else {
        await authRequest('login', { password })
      }
      setNotice('')
      await check()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign in failed')
      return false
    } finally {
      setBusy(false)
    }
  }
  async function signOut() {
    if (!session.current) return
    setError('')
    try {
      await authRequest('logout', {}, session.current.csrfToken)
      generation.current++
      session.current = null
      setState('login')
      setNotice('Signed out.')
      setRecovery(false)
      setPreview(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign out failed')
      await check()
    }
  }
  function openOnboarding(
    returnFocus?: HTMLElement,
    mode: ThemeMode = 'system',
  ) {
    previewReturnFocus.current = returnFocus
    // Let the account menu release its overlay before opening the full-page modal.
    requestAnimationFrame(() => {
      if (mounted.current && session.current) setPreview(mode)
    })
  }
  function closeOnboarding() {
    setPreview(null)
    requestAnimationFrame(() => requestAnimationFrame(() => previewReturnFocus.current?.focus()))
  }
  async function saveOnboarding(progress: SetupProgress, expectedRevision: number) {
    if (!session.current) throw new Error('Sign in before setting up agents.')
    const saved = await authRequest<SetupState>('onboarding', { progress, expectedRevision }, session.current.csrfToken)
    setOnboardingPending(saved.status === 'pending')
    setOnboardingStep(saved.step)
    return saved
  }
  async function startOnboarding(manual = false) {
    const saved = await authRequest<SetupState | null>('onboarding/start', { manual }, session.current?.csrfToken)
    setOnboardingPending(saved?.status === 'pending')
    setOnboardingStep(saved?.step)
    return saved
  }
  async function completeOnboarding(expectedRevision: number, skipProjects: boolean) {
    const saved = await authRequest<SetupState>('onboarding/complete', { expectedRevision, skipProjects }, session.current?.csrfToken)
    setOnboardingPending(saved.status === 'pending')
    setOnboardingStep(saved.step)
    return saved
  }
  function reconcileOnboarding() {
    if (reconciliation.current) return reconciliation.current
    const version = generation.current
    const task = (async () => {
      let saved = await authRequest<SetupState | null>('onboarding')
      if (saved?.status === 'pending') saved = await authRequest<SetupState>('onboarding/reconcile', { expectedRevision: saved.revision }, session.current?.csrfToken)
      if (version === generation.current) {
        setOnboardingPending(saved?.status === 'pending')
        setOnboardingStep(saved?.step)
      }
      return saved
    })()
    reconciliation.current = task
    void task.finally(() => { if (reconciliation.current === task) reconciliation.current = null }).catch(() => {})
    return task
  }
  if (state === 'authenticated')
    return (
      <AuthContext value={{ signOut, openOnboarding, onboardingPending, onboardingStep, reconcileOnboarding, saveOnboarding, startOnboarding, completeOnboarding }}>
        {error && (
          <p className="auth-global-error" role="alert">
            {error}
          </p>
        )}
        <ProductOnboarding csrfToken={session.current?.csrfToken ?? ''}>{children}</ProductOnboarding>
        {preview && (
          <OnboardingPreview mode={preview} onClose={closeOnboarding} />
        )}
      </AuthContext>
    )
  const title = recovery
    ? 'Recover your password'
    : state === 'setup_pending'
      ? 'Set up your password'
      : state === 'setup_blocked'
        ? 'Local setup required'
        : state === 'unavailable'
          ? 'Suite unavailable'
          : 'Sign in to your Suite'
  return (
    <OnboardingScreen
      title={title}
      loading={state === 'loading'}
      loadingLabel={
        state === 'loading' ? 'Checking your session…' : 'Welcome to Aixand'
      }
      wide={recovery}
    >
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="auth-notice">
          {notice}
        </p>
      )}
      {recovery ? (
        <>
          <p>
            Recovery requires terminal or SSH access to the machine hosting this
            Suite. Ask the host owner if you do not have that access.
          </p>
          <div
            className="auth-tabs"
            role="group"
            aria-label="Recovery instructions"
          >
            <Button
              variant={tab === 'manual' ? 'primary' : 'ghost'}
              onPress={() => setTab('manual')}
            >
              Manual instructions
            </Button>
            <Button
              variant={tab === 'agent' ? 'primary' : 'ghost'}
              onPress={() => setTab('agent')}
            >
              AI agent instructions
            </Button>
          </div>
          {tab === 'manual' ? (
            <>
              <ol>
                <li>On the host, stop the Suite backend.</li>
                <li>
                  Read <code>aixand-server/docs/authentication.md</code> and
                  back up the configured authentication database. Its default is{' '}
                  <code>~/.aixand/suite/auth/auth.db</code>.
                </li>
                <li>
                  From <code>aixand-server</code>, run{' '}
                  <code>npm run auth:recover</code>. Enter and confirm the new
                  password in its hidden terminal prompt.
                </li>
                <li>
                  Restart the backend, then sign in. All previous browser
                  sessions will be revoked.
                </li>
              </ol>
              <p>
                The guide also provides manual SQL recovery. Replace the
                password hash and revoke sessions together; deleting the
                credential record leaves access locked.
              </p>
            </>
          ) : (
            <>
              <pre className="auth-prompt">{recoveryPrompt}</pre>
              <Button
                onPress={() => {
                  void navigator.clipboard.writeText(recoveryPrompt).then(
                    () => setNotice('Instructions copied.'),
                    () =>
                      setError(
                        'Copy unavailable. Select and copy the instructions above.',
                      ),
                  )
                }}
              >
                Copy instructions
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            onPress={() => {
              setRecovery(false)
              setNotice('')
              setError('')
            }}
          >
            Back to sign in
          </Button>
        </>
      ) : state === 'setup_blocked' ? (
        <>
          <p>
            Open this Suite on localhost on the machine where it is installed to
            create its first password. You can sign in here after setup is
            complete.
          </p>
          <Button
            onPress={() => {
              void check()
            }}
          >
            Check again
          </Button>
        </>
      ) : state === 'unavailable' ? (
        <Button
          onPress={() => {
            void check()
          }}
        >
          Retry connection
        </Button>
      ) : (
        <>
          <p className="onboarding-description">
            {state === 'setup_pending'
              ? 'Choose one password for your Suite. Then continue to set up your agents.'
              : 'Enter your password to access this workspace.'}
          </p>
          <PasswordForm
            key={state}
            setup={state === 'setup_pending'}
            busy={busy}
            onSubmit={submit}
          />
          {state === 'login' && (
            <Button
              variant="ghost"
              disabled={busy}
              onPress={() => {
                setRecovery(true)
                setError('')
                setNotice('')
              }}
            >
              Forgot password?
            </Button>
          )}
        </>
      )}
    </OnboardingScreen>
  )
}
