import { randomUUID } from '../uuid'
import { saveProfileChanges, type ProfileChanges } from './accountPresentation'
import { useContentFieldVariant } from '../branding/ContentTheme'
import { useRef, useState } from 'react'
import { Accordion, Button, Checkbox, DescriptionList, Icon, Select, TextField } from 'bbb-design'
import type { AgentJob, Model, Profile, Provider } from './client'
import { requestId } from '../terminals/connection'
import type { AgentsModel } from './model'
import { McpProfileEditor } from './mcp'
import type { McpBinding } from './mcp'
import { providerLabel, type AgentOperation } from './presentation'
import { NewLoginButton } from './SavedLogins'
import { ProfileResourceEditor } from './ResourcePicker'
import { nameError } from './names'
import { AllowanceReadings } from './allowance'
import { SdkCredentials } from './SdkCredentials'
import { ClaudeAccounts } from './ClaudeAccounts'
import { createSetupProfile } from './createSetupProfile'

export function ProfileForm({ agents: a, profile, formId, disabled, error, act, onSaved, allowance, navigate }: {
  agents: AgentsModel
  profile: Profile | 'new'
  formId: string
  disabled: boolean
  error: string
  act: AgentOperation
  onSaved: (notice: string) => void
  allowance: (provider: Provider, auth: string | null) => string
  navigate: (route: string) => void
}) {
  const fieldVariant = useContentFieldVariant()
  const creating = profile === 'new'
  const [provider, setProvider] = useState<Provider>(creating ? 'codex' : profile.provider)
  const [name, setName] = useState(creating ? '' : profile.profile)
  const [loginMethod, setLoginMethod] = useState('')
  const [auth, setAuth] = useState(creating ? '' : profile.auth ?? '')
  const [accountChanges, setAccountChanges] = useState<ProfileChanges>({})
  const [preferred, setPreferred] = useState(creating ? false : !!profile.preferred)
  const [model, setModel] = useState(creating ? '' : profile.model ?? '')
  const [servers, setServers] = useState<string[]>(creating ? [] : profile.mcp?.servers ?? [])
  const [cwd, setCwd] = useState(a.catalog?.cwd ?? '')
  const [free, setFree] = useState(false)
  const [models, setModels] = useState<Model[]>([])
  const [created, setCreated] = useState(false)
  const creation = useRef({ identity: '', key: '' })
  const capability = a.catalog?.capabilities.find((item) => item.provider === provider)
  const logins = a.catalog?.auths.filter((item) => item.provider === provider) ?? []
  const locked = !creating || created
  const validation = creating && !created ? nameError(name, (a.catalog?.profiles ?? [])
    .filter((item) => item.provider === provider).map((item) => item.profile), undefined, true) : ''

  function continueSetup() {
    navigate(`agents/providers?provider=${encodeURIComponent(provider)}&setup=profile&flow=${randomUUID()}${auth ? '&auth=' + encodeURIComponent(auth) : ''}${name ? '&name=' + encodeURIComponent(name) : ''}`)
  }

  async function save() {
    if (validation) return
    let notice = 'Profile saved. Changes apply to new sessions.'
    if (creating && !created) {
      const identity = JSON.stringify([provider, name.trim(), auth, model.trim()])
      if (creation.current.identity !== identity) creation.current = { identity, key: randomUUID() }
      await createSetupProfile(a, provider, name.trim(), auth || undefined, creation.current.key,
        capability?.savedModels && model.trim() ? { model: model.trim() } : {})
      setCreated(true)
      notice = 'Profile created.'
    } else if (!creating) {
      const changes: ProfileChanges = { ...accountChanges }
      if (capability?.authMode !== 'native' && (auth || null) !== profile.auth) changes.auth = auth || null
      if (capability?.savedModels && (model.trim() || null) !== (profile.model ?? null)) changes.model = model.trim() || null
      if (preferred !== !!profile.preferred) changes.preferred = preferred
      if (Object.keys(changes).length) await saveProfileChanges(a, profile, changes)
    }
    const original = creating ? [] : profile.mcp?.servers ?? []
    if (creating && JSON.stringify(servers) !== JSON.stringify(original)) {
      const current = await a.request<McpBinding>('mcp-profile-get', { provider, profile: name.trim() })
      await a.request('mcp-profile-set', {
        provider, profile: name.trim(), servers, expectedRevision: current.revision,
      })
    }
    await a.refresh()
    onSaved(notice)
  }

  return (
    <form id={formId} className="agents-sheet-form" onSubmit={(event) => {
      event.preventDefault()
      if (creating && !created && (!capability?.installed || capability.authMode === 'native' || capability.savedAuth === false)) {
        if (!disabled && !validation) continueSetup()
        return
      }
      void act('profile', save)
    }}>
      {(error || validation && name) && <p role="alert" className="agents-error">{error || validation}</p>}
      {creating && <Select variant={fieldVariant} label="Provider" value={provider} disabled={disabled || locked}
        options={(a.catalog?.capabilities ?? []).map(row => ({ id: row.provider, label: providerLabel(row.provider) }))}
        onChange={(value) => {
          setProvider(value as Provider)
          setAuth('')
          setModel('')
          setModels([])
          setServers([])
        }} />}
      {creating && <TextField variant={fieldVariant} label="Profile name" required autoFocus value={name}
        disabled={disabled || locked} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" maxLength={128}
        hint={validation || 'Letters, numbers, hyphens and underscores. default is reserved.'}
        onChange={(event) => setName(event.target.value)} />}
      {creating && !capability?.installed && <div className="agents-form-section">
        <p className="ws-note">Set up {providerLabel(provider)} to connect an account and finish this profile.</p>
        <Button variant="secondary" disabled={disabled} onPress={continueSetup}>Set up provider<Icon name="arrow-right" /></Button>
      </div>}
      {provider === 'claude' && !creating ? <ClaudeAccounts agents={a} profile={profile} disabled={disabled} navigate={navigate}
        onSelectionChange={claudeAccountId => setAccountChanges(value => ({ ...value, claudeAccountId }))} /> : capability?.authMode === 'native' ? <section className="agents-form-section">
        <p>{capability.homeScope === 'shared'
          ? 'These profiles share the provider’s settings, conversation history, and OS login. Signing in applies to all of them.'
          : 'Sign in to this profile using the provider’s own login.'}</p>
        {(capability.loginMethods?.length ?? 0) > 1 && <Select variant={fieldVariant} label="Sign-in method"
          value={loginMethod || capability.defaultLoginMethod} disabled={disabled}
          options={capability.loginMethods!.map(id => ({ id, label: id === 'device' ? 'Device code' : id === 'browser' ? 'Browser' : id }))}
          onChange={setLoginMethod} />}
        <Button variant="secondary" disabled={disabled || (creating && !created)} onPress={() => { void act('profile-login', async () => {
          const job = await a.request<AgentJob>('agent-operation-start', { key: requestId(), provider, profile: name.trim(), kind: 'profile-login', method: loginMethod || capability.defaultLoginMethod })
          await a.refresh()
          if (job.sessionId) navigate(`terminals/${encodeURIComponent(job.sessionId)}`)
        }) }}>Sign in to profile</Button>
      </section> : <><Select variant={fieldVariant} label="Saved login" value={auth} disabled={disabled}
        options={[
          { id: '', label: 'No saved login assigned' },
          ...logins.map((item) => ({ id: item.auth, label: item.auth })),
        ]} onChange={setAuth} />
      <div className="agents-inline-action"><NewLoginButton agents={a} provider={provider} navigate={navigate} disabled={disabled} onCreated={setAuth} /></div>
      </>}
      {!creating && profile.authentication && <Checkbox label="Preferred profile for new chats" isSelected={preferred} onChange={setPreferred} disabled={disabled} />}
      <section className="agents-form-section" aria-label="Model settings">
        {capability?.savedModels ? <TextField variant={fieldVariant} label="Saved model" value={model} disabled={disabled}
          hint="Leave empty to use the profile default." onChange={(event) => setModel(event.target.value)} />
          : <><h3>Model</h3><p>Profile configuration default</p></>}
        {provider === 'opencode' && !creating && <Accordion items={[{
          id: 'discover', title: 'Choose an available model', content: <div className="agents-sheet-form">
            <TextField variant={fieldVariant} label="Model discovery directory" value={cwd} disabled={disabled}
              onChange={(event) => setCwd(event.target.value)} />
            <Checkbox label="Free models only" isSelected={free} onChange={setFree} disabled={disabled} />
            <Button variant="secondary" disabled={disabled || !cwd.trim()} onPress={() => {
              void act('models', async () => {
                setModels(await a.request<Model[]>('models', { provider, profile: name, cwd: cwd.trim(), free }))
              })
            }}>Discover models</Button>
            {models.length > 0 && <Select variant={fieldVariant} label="Available models" value={model} disabled={disabled}
              onChange={setModel} options={models.map((item) => ({
                id: item.id, label: `${item.name}${item.free ? ' · Free' : ''}`, description: item.id,
              }))} />}
          </div>,
        }]} />}
      </section>
      <Accordion allowsMultipleExpanded items={[
        ...(!creating && typeof profile !== 'string' && ['claude', 'antigravity'].includes(profile.provider) ? [{
          id: 'sdk-credentials', title: profile.provider === 'claude' ? 'SDK authentication' : 'Chat API credentials', content: <SdkCredentials agents={a} profile={profile} disabled={disabled}
            onSelectionChange={changes => setAccountChanges(value => ({ ...value, ...changes }))} />,
        }] : []),
        ...(!creating ? [{ id: 'resources', title: 'Prompt, skills and MCP defaults', content:
          <ProfileResourceEditor agents={a} profile={profile} /> }] : []),
        ...(creating ? [{
          id: 'tools', title: `Tools (MCP) · ${servers.length} attached`,
          content: <McpProfileEditor agents={a} provider={provider} value={servers}
            onChange={setServers} disabled={disabled} />,
        }] : []),
        ...(!creating ? [{
          id: 'details', title: 'Usage and profile details', content: <div className="agents-sheet-form">
            <DescriptionList items={[
              { id: 'type', label: 'Profile type', value: profile.profile === 'default' ? 'Native profile' : 'Custom profile' },
              { id: 'allowance', label: 'Allowance', value: allowance(provider, auth || null) },
            ]} />
            {auth && capability?.budgets && <Button variant="secondary" size="sm"
              disabled={disabled || a.budgetLoading.includes(`${provider}/${auth}`)}
              onPress={() => void a.refreshBudget(provider, auth)}>Check allowance</Button>}
            {auth && <AllowanceReadings rows={a.budgets[`${provider}/${auth}`]} />}
          </div>,
        }] : []),
      ]} />
    </form>
  )
}
