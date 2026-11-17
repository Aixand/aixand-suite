import { CapabilitiesProvider, useCapabilities } from './capabilities'
import { requestResourceNavigation } from './resources/editor/drafts'
import { AuthGate, useAuth } from './auth/AuthGate'
import { OnboardingStartup } from './auth/OnboardingStartup'
import { AgentOnboarding } from './auth/AgentOnboarding'
import { readStorage } from './storage'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, EmptyState, ThemeProvider } from 'bbb-design'
import type { ThemeMode } from 'bbb-design'
import { aixandBrand, aixandCanvas, aixandWorkspaceTokens } from './brand'
import { ContentTheme } from './branding/ContentTheme'
import { NavigationRail } from './components/NavigationRail'
import { NavigationUtilities } from './components/NavigationUtilities'
import { PageLoading } from './components/PageLoading'
import {
  Home,
  ChatPage,
  Carrier,
} from './workspace/Pages'
import { useWorkspace } from './workspace/model'
import { rememberWorkRoute } from './workspace/home/history'
import { WorkspaceSearch } from './workspace/WorkspaceSearch'
import { AgentsPage } from './agents/AgentsPage'
import { agentSection, canonicalAgentRoute, rememberAgentRoute } from './agents/routes'
import { Workflows } from './pages/Workflows'
import { SupervisionLink } from './command/SupervisionControls'
import { useWorkflowLibrary } from './workflows/library'
import { Vox } from './vox/Vox'
import { SettingsPage } from './settings/SettingsPage'
import { finishReset, isPendingReset } from './settings/reset'
import { RecoveryHost, WorkspaceBoundary } from './recovery/RecoveryHost'

const Terminals = lazy(() =>
  import('./pages/Terminals').then((module) => ({ default: module.Terminals })),
)
const WorkflowBuilder = lazy(() =>
  import('./pages/WorkflowBuilder').then((module) => ({ default: module.WorkflowBuilder })),
)
const WorkflowRun = lazy(() => import('./workflows/WorkflowRun').then((module) => ({ default: module.WorkflowRun })))

const destinations = [
  { id: 'home', label: 'Home', href: '#/home', icon: 'house' as const },
  {
    id: 'chat',
    label: 'Chat',
    href: '#/chat',
    icon: 'messages-square' as const,
  },
  {
    id: 'terminals',
    label: 'Terminals',
    href: '#/terminals',
    icon: 'square-terminal' as const,
  },
  { id: 'workflows', label: 'Workflows', href: '#/workflows', icon: 'workflow' as const },
  { id: 'carrier', label: 'Carrier', href: '#/carrier', icon: 'mail' as const },
  { id: 'agents', label: 'Agents', href: '#/agents', icon: 'bot' as const },
]
function readRoute() {
  let route = window.location.hash.replace(/^#\/?/, '') || 'home'
  // Preserve bookmarks while the former Command page moves to Chat.
  if (route === 'command' || route.startsWith('command/monitors/')) {
    route = route === 'command' ? 'chat/supervising' : route.replace('command/monitors/', 'chat/supervision/')
    window.history.replaceState(window.history.state, '', `#/${route}`)
  } else if (/^command\/[a-f0-9-]{36}$/i.test(route)) {
    route = `chat${route.slice('command'.length)}`
    window.history.replaceState(window.history.state, '', `#/${route}`)
  }
  const canonical = canonicalAgentRoute(route)
  if (canonical !== route) {
    route = canonical
    window.history.replaceState(window.history.state, '', `#/${route}`)
  }
  return route === 'terminal' || route.startsWith('terminal/')
    ? 'terminals'
    : route
}
function terminalSession(route: string): string | undefined {
  try { return route.startsWith('terminals/') ? decodeURIComponent(route.slice('terminals/'.length)) || undefined : undefined }
  catch { return undefined }
}
function workflowId(route: string): string | undefined {
  try { return route.startsWith('workflows/') ? decodeURIComponent(route.slice('workflows/'.length)) || undefined : undefined }
  catch { return undefined }
}
function workflowRunKey(route: string): string | undefined {
  try { return route.startsWith('workflows/runs/') ? decodeURIComponent(route.slice('workflows/runs/'.length)) || undefined : undefined }
  catch { return undefined }
}
function chatSession(route: string): string | undefined {
  const id = route.startsWith('chat/') ? route.split('/')[1] : ''
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) ? id : undefined
}
function commandMonitor(route: string): string | undefined {
  const id = route.startsWith('chat/supervision/') ? route.slice('chat/supervision/'.length) : route.split('/')[2] === 'supervision' ? route.split('/')[3] : ''
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) ? id : undefined
}
function readMode(): ThemeMode {
  try {
    const stored = readStorage('aixand.appearance')
    return stored === 'dark' || stored === 'light' ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function App() {
  return <AuthGate><RecoveryHost><WorkspaceBoundary><CapabilitiesProvider><WorkspaceApp /></CapabilitiesProvider></WorkspaceBoundary></RecoveryHost></AuthGate>
}

function WorkspaceApp() {
  const capabilities = useCapabilities()
  const auth = useAuth()
  const workspace = useWorkspace()
  const [setupDismissed, setSetupDismissed] = useState(false)
  const setupReturnFocus = useRef<HTMLElement | null>(null)
  const [resetError, setResetError] = useState('')
  useEffect(() => workspace.agents.subscribe((value) => {
    const event = value as { type?: string; scope?: string; key?: string }
    if (event.type !== 'workspace-reset' || !event.key || isPendingReset(event.key)
      || (event.scope !== 'chats' && event.scope !== 'everything')) return
    try { finishReset(event.scope) }
    catch { setResetError('The workspace was reset in another tab. Browser storage could not be cleared; retry the reset in Settings.') }
  }), [])
  const workflows = useWorkflowLibrary()
  const [route, setRoute] = useState(readRoute)
  const [searchOpen, setSearchOpen] = useState(false)
  const currentRoute = useRef(route); currentRoute.current = route
  useEffect(() => {
    rememberWorkRoute(route)
    rememberAgentRoute(route)
    return () => rememberWorkRoute(route)
  }, [route])
  const [mode, setMode] = useState<ThemeMode>(readMode)
  useEffect(() => {
    const deviceTheme = window.matchMedia('(prefers-color-scheme: dark)')
    const updateThemeColor = () => {
      const resolved =
        mode === 'system' ? (deviceTheme.matches ? 'dark' : 'light') : mode
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', aixandCanvas[resolved])
    }
    updateThemeColor()
    deviceTheme.addEventListener('change', updateThemeColor)
    return () => deviceTheme.removeEventListener('change', updateThemeColor)
  }, [mode])
  const changeMode = (value: ThemeMode) => {
    setMode(value)
    try {
      localStorage.setItem('aixand.appearance', value)
    } catch {
      // Appearance still works for this visit.
    }
  }
  const mainRef = useRef<HTMLElement>(null)
  const pagePath = route.split('?')[0]
  const previousPagePath = useRef(pagePath)
  useLayoutEffect(() => {
    if (previousPagePath.current === pagePath) return
    previousPagePath.current = pagePath
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // Animate the existing container so navigation preserves mounted page state.
    const animation = mainRef.current?.animate(
      [{ opacity: 0.86, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    )
    return () => animation?.cancel()
  }, [pagePath])
  const initialRoute = useRef(true)
  const focusedPage = useRef('')
  useEffect(() => {
    const listener = () => {
      const next = readRoute()
      if (next === currentRoute.current) return
      const previous = currentRoute.current
      if (!requestResourceNavigation(() => { window.history.replaceState(window.history.state, '', `#/${next}`); currentRoute.current = next; setRoute(next) }))
        window.history.replaceState(window.history.state, '', `#/${previous}`)
    }
    window.addEventListener('hashchange', listener)
    return () => window.removeEventListener('hashchange', listener)
  }, [])
  const page = route.split(/[/?]/)[0]
  const focusedChat = page === 'chat' && (route === 'chat' || route === 'chat/supervising' || Boolean(chatSession(route)))
  const workflow = workflows.workflows.find((item) => item.id === workflowId(route))
  const runKey = workflowRunKey(route)
  const activeTitle =
    page === 'settings' ? 'Settings' : destinations.find((d) => d.id === page)?.label ?? 'Not found'
  useEffect(() => {
    document.title = `Aixand · ${activeTitle}`
    const section = agentSection(route)
    const focusScope = section ? `agents/${section.id}` : page
    const browsingAgents = Boolean(section) && focusedPage.current === focusScope
    focusedPage.current = focusScope
    if (initialRoute.current) {
      initialRoute.current = false
      return
    }
    // Chat manages focus on its composer when opening or switching sessions.
    if (browsingAgents || focusedChat) return
    const frame = requestAnimationFrame(() => {
      const heading = mainRef.current?.querySelector<HTMLElement>('h1')
      ;(heading ?? mainRef.current)?.focus({ preventScroll: true })
      mainRef.current?.scrollTo(0, 0)
    })
    return () => cancelAnimationFrame(frame)
  }, [route, activeTitle, focusedChat])
  const navigate = (destination: string) => requestResourceNavigation(() => {
    window.location.hash = `/${destination}`
    // Controlled filters must update in the input event, before hashchange fires.
    const next = readRoute(); currentRoute.current = next; setRoute(next)
  })
  const openWorkflow = (id: string) => navigate(`workflows/${encodeURIComponent(id)}`)
  return (
    <ThemeProvider brand={aixandBrand} mode={mode} tokens={aixandWorkspaceTokens} className={`aixand-app${focusedChat ? ' aixand-app--chat' : ''}`}>
      <a
        href="#main-content"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault()
          mainRef.current?.focus()
        }}
      >
        Skip to content
      </a>
      <NavigationRail
        destinations={destinations}
        currentId={page}
        onNavigate={navigate}
        utilities={<NavigationUtilities mode={mode} onModeChange={changeMode} onNavigate={navigate} onSignOut={auth.signOut} />}
      />
      <ContentTheme className="app-body" enabled={page !== 'terminals'}>
        <OnboardingStartup connected={workspace.agents.status === 'connected'} setupOpen={auth.onboardingPending && !setupDismissed}
          workspaceVersion={JSON.stringify({
            profiles: workspace.agents.catalog?.profiles.map(profile => [profile.id, profile.identity, profile.auth, profile.readiness?.ready]),
            projects: workspace.projects.projects.map(project => [project.id, project.name, project.path]),
            operations: workspace.agents.operations.map(operation => [operation.id, operation.provider, operation.status]),
          })} />
        {auth.onboardingPending && setupDismissed && <div className="app-notice">
          <p role="status">{auth.onboardingStep === 'projects' ? 'Your agents are ready. Add your initial projects or skip this step.' : 'Finish agent setup to use agent-powered features.'}</p>
          <Button variant="secondary" size="sm" onPress={() => setSetupDismissed(false)}>{auth.onboardingStep === 'projects' ? 'Choose projects' : 'Continue setup'}</Button>
        </div>}
        {resetError && <div className="app-notice" role="alert"><p>{resetError}</p></div>}
        <main
          ref={mainRef}
          id="main-content"
          tabIndex={0}
          className={`main-content${page === 'chat' ? ' main-content--chat' : ''}${page === 'terminals' ? ' main-content--terminals' : ''}${workflow || runKey ? ' main-content--workflow-builder' : ''}`}
        >
          {page === 'terminals' ? (
            <Suspense fallback={<PageLoading label="Loading terminals…" />}>
              <Terminals sessionId={terminalSession(route)} />
            </Suspense>
          ) : route === 'workflows' ? (
            <Workflows workflows={workflows.workflows} onOpen={openWorkflow}
              agents={workspace.agents} projects={workspace.projects.projects}
              create={workflows.create} notice={workflows.storageError || workflows.notice}
              runs={workspace.chats.workflowRuns} onOpenRun={(key) => navigate(`workflows/runs/${encodeURIComponent(key)}`)}
              runError={workspace.chats.workflowError} runLoading={workspace.chats.workflowLoading}
              nextOffset={workspace.chats.workflowNextOffset} loadRuns={workspace.chats.loadWorkflowRuns} />
          ) : page === 'workflows' && runKey ? (
            <Suspense fallback={<PageLoading label="Loading workflow run…" />}>
              <WorkflowRun key={runKey} runKey={runKey} workspace={workspace} navigate={navigate} library={workflows} />
            </Suspense>
          ) : page === 'workflows' && workflow ? (
            <Suspense fallback={<PageLoading label="Loading workflow builder…" />}>
              <WorkflowBuilder key={workflow.id} workflow={workflow} onSave={workflows.save} agents={workspace.agents}
                workspace={workspace} navigate={navigate}
                create={workflows.create} onCreated={openWorkflow} onBack={() => navigate('workflows')}
                storageError={workflows.storageError} notice={workflows.notice} />
            </Suspense>
          ) : page === 'workflows' ? (
            <EmptyState headingLevel={2} title="Workflow not found"
              description="Open your workflow list to choose a saved workflow."
              action={<Button onPress={() => navigate('workflows')}>Back to workflows</Button>} />
          ) : route === 'home' ? (
            <Home workspace={workspace} workflows={workflows.workflows} navigate={navigate} onSearch={() => setSearchOpen(true)} />
          ) : route.startsWith('chat/supervision/') && commandMonitor(route) ? (
            <SupervisionLink workspace={workspace} navigate={navigate} monitorId={commandMonitor(route)!} />
          ) : page === 'chat' && (route === 'chat' || route === 'chat/supervising' || chatSession(route)) ? (
            <ChatPage workspace={workspace} navigate={navigate} chatId={chatSession(route)} supervisionId={commandMonitor(route)} supervisingOnly={route === 'chat/supervising'} workflows={workflows.workflows} />
          ) : route === 'carrier' ? (
            <Carrier workspace={workspace} navigate={navigate} />
          ) : page === 'agents' && agentSection(route) ? (
            <AgentsPage agents={workspace.agents} projects={workspace.projects.projects} navigate={navigate} route={route} />
          ) : page === 'settings' ? (
            <SettingsPage agents={workspace.agents} route={route} navigate={navigate} onSetup={async () => {
              setupReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
              try {
                const setup = await auth.startOnboarding(true)
                if (setup?.status !== 'pending') throw new Error('Could not open workspace setup. Try again.')
                setSetupDismissed(false)
              } catch (cause) { setupReturnFocus.current = null; throw cause }
            }} />
          ) : (
            <EmptyState
              headingLevel={2}
              title="This page isn’t here"
              description="This link is no longer available. Return Home to find your way around."
              action={
                <Button onPress={() => navigate('home')}>Back to Home</Button>
              }
            />
          )}
        </main>
        <WorkspaceSearch workspace={workspace} workflows={workflows.workflows} destinations={destinations}
          route={route} navigate={navigate} open={searchOpen} onOpenChange={setSearchOpen} />
      </ContentTheme>
      {capabilities.vox && <Vox agents={workspace.agents} />}
      {auth.onboardingPending && !setupDismissed && <AgentOnboarding agents={workspace.agents} mode={mode} onModeChange={changeMode}
        onClose={() => {
          setSetupDismissed(true)
          const target = setupReturnFocus.current
          setupReturnFocus.current = null
          requestAnimationFrame(() => requestAnimationFrame(() => { if (target?.isConnected) target.focus() }))
        }} navigate={navigate} />}
    </ThemeProvider>
  )
}
