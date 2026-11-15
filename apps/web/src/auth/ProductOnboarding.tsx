import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Checkbox, Icon, Progress, RadioGroup, type IconName } from 'bbb-design'
import { AuthError, authRequest } from './client'
import { OnboardingScreen } from './OnboardingScreen'
import { SetupActivity } from './SetupCheck'
import { OnboardingActions } from './OnboardingActions'
import './product-onboarding.css'

type CommandCandidate = { path: string; version: string | null; managed: boolean }
type CommandReport = {
  userPathSupported: boolean
  registered?: boolean
  policy?: 'keep' | 'prefer'
  profileNotice?: string
  commands: { name: string; suiteVersion?: string; installedVersion?: string | null;
    installedPath: string; default: CommandCandidate | null; conflict: boolean; candidates: CommandCandidate[] }[]
}

type Installation = {
  available: boolean
  ready: boolean
  edition?: 'standalone' | 'distributed'
  prefix?: string
  cliDirectory?: string
  starting?: boolean
  launchError?: string
  commandSetupRequired?: boolean
  connectionSetupRequired?: boolean
  ucConnection?: { profile: string; activeProfile: string; home: string; verified: boolean } | null
  assemblies?: { id: string; name: string; versions: string[]; installed: boolean }[]
  licenses?: { product: string; sha256: string; text: string }[]
  job?: { status: string; product?: string; message?: string; cliDirectory?: string; retained?: string[]; terminal?: CommandReport } | null
}

const products: Record<string, { icon: IconName; description: string; members?: string[] }> = {
  undercurrent: { icon: 'square-terminal', description: 'Keep terminals and processes running across sessions.' },
  runner: { icon: 'workflow', description: 'Run workflows and follow their progress.' },
  carrier: { icon: 'inbox', description: 'Exchange messages between agents and programs.' },
  'manager-suite': { icon: 'layers', description: 'Manage agents, prompts, skills, and connections.',
    members: ['agent-manager', 'mcp-manager', 'prompt-manager', 'server-manager', 'skill-manager', 'orchestration-mcp', 'resource-sources'] },
}

function ProductSetupSteps({ complete }: { complete: boolean }) {
  return <nav className="product-setup-steps" aria-label="Setup progress">
    <ol>{['Password', 'Tools', 'Agents', 'Projects'].map((label, index) => <li key={label}
      aria-current={index === 1 ? 'step' : undefined} data-complete={index === 0 || index === 1 && complete}>
      <span className="product-step-number" aria-hidden="true">{index === 0 || index === 1 && complete ? <Icon name="check" /> : index + 1}</span>
      <span>{label}</span>
    </li>)}</ol>
  </nav>
}

function ProductCommandDetails({ report, complete = false }: { report: CommandReport; complete?: boolean }) {
  const commands = report.commands.filter(row =>
    ['uc', 'runner', 'carrier', 'agent', 'prompt-manager', 'skill-manager', 'mcp-manager', 'server-manager', 'orchestration-mcp'].includes(row.name))
  return <details className="product-disclosure product-command-details">
    <summary>Compare versions and locations<Icon name="chevron-down" /></summary>
    <div>
      <ul className="product-command-versions">{commands.filter(row => complete || row.conflict).map(row => <li key={row.name}>
        <strong><code>{row.name}</code></strong>
        <p>Suite: {row.suiteVersion || row.installedVersion || 'included version'} — <code>{row.installedPath}</code></p>
        <p>New terminal default (PATH): {row.default
          ? <>{row.default.version || 'version unavailable'} — <code>{row.default.path}</code></>
          : 'command is not on PATH yet'}</p>
        {row.candidates.filter(candidate => candidate.path !== row.default?.path).map(candidate =>
          <p key={candidate.path}>Also available: {candidate.version || 'version unavailable'} — <code>{candidate.path}</code></p>)}
        {complete && row.conflict && !row.default?.managed && <p>{report.policy === 'prefer'
          ? 'A system PATH entry takes precedence over your user PATH choice. Suite uses its installed copy directly.'
          : 'Your existing command remains the terminal default. Suite uses its installed copy directly.'}</p>}
      </li>)}</ul>
      {report.profileNotice && <p className="product-installation-note">{report.profileNotice}</p>}
    </div>
  </details>
}

export function ProductOnboarding({ csrfToken, children }: { csrfToken: string; children: ReactNode }) {
  const [status, setStatus] = useState<Installation>()
  const [error, setError] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [starting, setStarting] = useState(false)
  const [continued, setContinued] = useState(false)
  const [commands, setCommands] = useState<CommandReport>()
  const [commandError, setCommandError] = useState('')
  const [checkingCommands, setCheckingCommands] = useState(false)
  const [terminalPolicy, setTerminalPolicy] = useState<'keep' | 'prefer'>('keep')
  const initiated = useRef(false)
  useEffect(() => {
    if (continued) return
    let active = true
    let pending = false
    const poll = async () => {
      if (pending) return
      pending = true
      try {
        const value = await authRequest<Installation>('installation/status')
        if (active) {
          setStatus(value); setError('')
          if (!value.available || value.ready && !value.commandSetupRequired && !value.connectionSetupRequired && !value.starting && !initiated.current &&
            (!value.job || value.job.status === 'complete')) setContinued(true)
          if (value.job && ['complete', 'error', 'interrupted'].includes(value.job.status) && !value.starting) setStarting(false)
          if (value.launchError) { setStarting(false); setError(value.launchError) }
        }
      } catch (cause) {
        if (active) {
          if (cause instanceof AuthError && cause.status === 404) setStatus({ available: false, ready: true })
          else setError(cause instanceof Error ? cause.message : 'Could not check product setup.')
        }
      } finally { pending = false }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1500)
    return () => { active = false; window.clearInterval(timer) }
  }, [continued])
  useEffect(() => {
    if (status?.edition !== 'distributed' || continued) return
    let active = true
    setCheckingCommands(true)
    void authRequest<CommandReport>('installation/commands').then(value => {
      if (active) { setCommands(value); setCommandError('') }
    }).catch(() => {
      if (active) setCommandError('Could not check existing terminal commands. Retry the check before installing.')
    }).finally(() => { if (active) setCheckingCommands(false) })
    return () => { active = false }
  }, [status?.edition, continued])
  if (!status) return <OnboardingScreen title="Checking your installation" loading={!error} loadingLabel="Checking your installation…" skipIntro>
    {error && <p role="alert" className="auth-error">{error}</p>}
  </OnboardingScreen>
  if (status && (!status.available || status.ready && !status.commandSetupRequired && !status.connectionSetupRequired && !status.job && !starting || continued)) return children
  const distributed = status?.edition === 'distributed'
  const busy = Boolean(starting || status.starting || ['running', 'activating', 'starting'].includes(status.job?.status ?? ''))
  const licenses = status?.licenses ?? []
  const failed = ['error', 'interrupted'].includes(status.job?.status ?? '')
  const complete = status.ready && !status.commandSetupRequired && !status.connectionSetupRequired && !busy && !failed
  const commandReport = complete && status.job?.terminal ? status.job.terminal : commands
  const hasExistingCommands = commandReport?.commands.some(row => row.conflict) ?? false
  const selectedTerminalPolicy = !commandReport?.userPathSupported ? 'keep'
    : hasExistingCommands ? terminalPolicy : 'prefer'
  const assemblies = status.assemblies ?? []
  const installedCount = assemblies.filter(row => row.installed).length
  const title = complete ? 'Your tools are ready' : busy ? 'Setting up your tools' : distributed ? 'Install your tools' : 'Your included tools'
  async function retryCommands() {
    setCheckingCommands(true); setCommandError('')
    try { setCommands(await authRequest<CommandReport>('installation/commands')) }
    catch { setCommandError('Could not check existing terminal commands. Retry the check before installing.') }
    finally { setCheckingCommands(false) }
  }
  async function install() {
    initiated.current = true
    setStarting(true); setError('')
    try {
      await authRequest('installation/install', { acceptedLicenses: licenses.map(row => row.sha256),
        ...(distributed ? { terminalPolicy: selectedTerminalPolicy } : {}) }, csrfToken)
    } catch (cause) { setStarting(false); setError(cause instanceof Error ? cause.message : 'Could not start installation.') }
  }
  return <OnboardingScreen title={title} wide layout="setup" skipIntro steps={<ProductSetupSteps complete={complete} />}>
    <div className="product-onboarding" data-state={complete ? 'complete' : busy ? 'installing' : 'review'}>
      <div className="product-onboarding-body" role="region" aria-label="Tool setup" tabIndex={0}>
        <p className="product-onboarding-intro">{complete ? 'All included products are ready. Next, choose your agents and connect your accounts.'
          : busy ? 'Follow the installation below. Your tools will be ready for agent setup next.'
          : distributed ? 'Set up the products that power your Suite. They’re installed for your user account and stay available when you remove Suite.'
          : 'All product files are included. Activate them for this Suite; their commands stay private to Aixand.'}</p>
        <section className="product-panel" aria-label="Included products">
          <header className="product-panel-heading">
            <h2>Included products</h2>
            <span>{installedCount} of {assemblies.length} {distributed ? 'installed' : 'activated'}</span>
          </header>
          <ul className="product-onboarding-list" aria-label="Aixand products">
            {assemblies.map(row => {
              const product = products[row.id]
              const current = status.job?.product === row.id || status.job?.product?.startsWith(row.id + '/')
                || product?.members?.includes(status.job?.product ?? '')
              const state = row.installed ? 'installed' : current && busy ? 'installing' : current && failed ? 'failed' : busy ? 'waiting' : 'included'
              return <li key={row.id} data-state={state}>
                <span className="product-symbol" aria-hidden="true"><Icon name={product?.icon ?? 'box'} /></span>
                <div className="product-copy">
                  <div className="product-name"><strong>{row.name}</strong><small>{[...new Set(row.versions)].join(', ')}</small></div>
                  {product?.description && <p>{product.description}</p>}
                </div>
                <span className="product-state">
                  {state === 'installed' ? <Icon name="circle-check" /> : state === 'failed' ? <Icon name="triangle-alert" />
                    : state === 'installing' ? <span className="product-spinner" aria-hidden="true" /> : null}
                  {state === 'installed' ? 'Installed' : state === 'installing' ? distributed ? 'Installing…' : 'Activating…'
                    : state === 'failed' ? 'Needs attention' : state === 'waiting' ? 'Waiting' : distributed ? 'Ready to install' : 'Included'}
                </span>
              </li>
            })}
          </ul>
          {busy && <div className="product-install-progress" role="status">
            <Progress label={status.job?.message || 'Preparing your tools…'} />
            <p>{installedCount} of {assemblies.length} products {distributed ? 'installed' : 'activated'}</p>
          </div>}
          {complete && <div className="product-ready" role="status"><Icon name="circle-check" />
            <span>{distributed ? 'Your independent tools are ready.' : 'Your included tools are ready.'}</span>
          </div>}
        </section>
        {distributed && !busy && !complete && <section className="product-panel product-terminal-commands" aria-label="Terminal commands">
          <header className="product-panel-heading"><h2><Icon name="square-terminal" />Terminal commands</h2></header>
          {checkingCommands && <SetupActivity label="Checking existing terminal commands…" description="Looking for tools already installed on this computer." />}
          {commandError && <div className="product-command-error"><p role="alert">{commandError}</p>
            <Button variant="secondary" onPress={() => void retryCommands()} disabled={checkingCommands}><Icon name="refresh-cw" />Retry command check</Button></div>}
          {!checkingCommands && !commandError && commandReport && <>
            {commandReport.userPathSupported && hasExistingCommands ? <>
              <p className="product-installation-note">We found tools already installed on this computer.</p>
              <RadioGroup className="product-command-choices" label="Which commands should your terminal use?" name="terminal-policy"
                value={selectedTerminalPolicy} onChange={value => setTerminalPolicy(value as 'keep' | 'prefer')}
                options={[
                  { value: 'keep', label: 'Use existing commands', description: 'Keep the commands your terminal currently uses. Your existing tools stay installed.' },
                  { value: 'prefer', label: 'Use newly installed commands', description: 'Make the tools installed by Aixand the defaults in new terminals.' },
                ]} />
              <p className="product-installation-note">Suite uses its installed tools whichever option you choose.</p>
            </> : <div className="product-command-automatic"><Icon name="circle-check" /><div>
              <strong>{commandReport.userPathSupported ? 'Your terminal commands will be set up automatically.' : 'Suite will use its installed tools directly.'}</strong>
              <p>{hasExistingCommands ? 'Your existing terminal commands will stay as they are.' : 'No other installed commands were found.'}</p>
            </div></div>}
            {hasExistingCommands && <ProductCommandDetails report={commandReport} />}
          </>}
        </section>}
        {(error || failed) && !busy && <div role="alert" className="product-install-error">
          <Icon name="triangle-alert" /><div><strong>Let’s finish setting up your tools</strong>
            <p>{error || status.job?.message || 'Setup was interrupted. Retry setup to continue.'}</p>
            <p>Installed products are kept. Retry setup when you’re ready.</p>
          </div>
        </div>}
        {busy && <details className="product-disclosure product-installation-details">
          <summary>Installation details<Icon name="chevron-down" /></summary>
          <div>{status.job?.message && <p>{status.job.message}</p>}{status.prefix && <p>Installation location: <code>{status.prefix}</code></p>}</div>
        </details>}
        {complete && <>
          {distributed && <p className="product-terminal-reminder"><Icon name="info" />Open a new terminal to use your tools outside Suite.</p>}
          <details className="product-disclosure product-installation-details">
            <summary>Installation summary<Icon name="chevron-down" /></summary>
            <div>
              {(status.job?.cliDirectory || status.cliDirectory) ? <p>Commands are installed in <code>{status.job?.cliDirectory || status.cliDirectory}</code>.</p>
                : status.prefix && <p>Installation location: <code>{status.prefix}</code>.</p>}
              {distributed && commandReport && <section className="product-terminal-commands" aria-label="Terminal commands">
                <h2>Terminal commands</h2>
                {commandReport.registered && <p>Your user PATH is configured. The command list below shows the selection after setup.</p>}
                <ProductCommandDetails report={commandReport} complete />
              </section>}
              {distributed && status.ucConnection?.verified && <p>
                Undercurrent connection profile: <code>{status.ucConnection.profile}</code>.
                {' '}CLI selection after setup: <code>{status.ucConnection.activeProfile}</code>.
                {' '}Use <code>uc settings set profile default</code> for your independent instance,
                {' '}or <code>uc settings set profile aixand-suite</code> for this workspace.
              </p>}
              {!!status.job?.retained?.length && <p>Existing commands were preserved. Suite uses its installed tool paths directly.</p>}
            </div>
          </details>
        </>}
        {!!licenses.length && !complete && !busy && <div className="product-terms">
          <Checkbox label="I have reviewed and accept the product terms" isSelected={accepted} onChange={setAccepted} />
          <details className="product-disclosure">
            <summary>View product terms<Icon name="chevron-down" /></summary>
            <div>{licenses.map(row => <section key={row.product + row.sha256}>
              <h3>{row.product}</h3><pre className="product-license" tabIndex={0}>{row.text}</pre>
            </section>)}</div>
          </details>
        </div>}
      </div>
      <OnboardingActions className="product-onboarding-footer">
        <p><Icon name={complete ? 'sparkles' : 'monitor'} /><span>{complete ? 'Next: agents and accounts' : 'Installs on the computer running Suite.'}</span></p>
        {complete ? <Button onPress={() => setContinued(true)}>Continue to agent setup<Icon name="arrow-right" /></Button>
          : <Button disabled={busy || !!licenses.length && !accepted || distributed && (!commands || checkingCommands || !!commandError)} loading={busy} onPress={() => void install()}>
            {busy ? 'Setting up tools…' : failed ? 'Retry setup' : distributed ? 'Install tools' : 'Activate included tools'}
            {!busy && <Icon name={failed ? 'refresh-cw' : 'arrow-right'} />}
          </Button>}
      </OnboardingActions>
    </div>
  </OnboardingScreen>
}
