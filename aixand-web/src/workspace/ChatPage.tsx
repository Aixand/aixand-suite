import { ResourcePicker, ResourceReportView, launchResourceArgs } from '../agents/ResourcePicker'
import type { ResourceRequest } from '../agents/ResourcePicker'
import type { ManagementAction } from '../agents/AgentManagementCard'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { PageLoading } from '../components/PageLoading'
import { Button, CommandPalette, Dialog, Icon, Sheet, SidebarToggle, TextField, Tooltip, useThemeAttributes } from 'bbb-design'
import type { IconName, SelectOption } from 'bbb-design'
import { ListBox, ListBoxItem, Popover, Select, SelectValue } from 'react-aria-components'
import { Mark } from '../components/Mark'
import { CarrierConnectionPanel } from '../carrier/CarrierPage'
import type { Conversation } from '../carrier/client'
import { requestId } from '../terminals/connection'
import { labelText } from '../terminals/context'
import { Conversation as LiveConversation } from '../chats/Conversation'
import { ChatStatus, chatActivity, type ChatActivity } from '../chats/ChatStatus'
import { QueuedMessages } from '../chats/QueuedMessages'
import { AgentError } from '../agents/client'
import { preferredBackend } from '../agents/backends'
import { ConversationInfo } from '../chats/ConversationInfo'
import { DeleteConversation } from '../chats/DeleteConversation'
import { CopyButton, MessageContent } from '../chats/MessageContent'
import type { Workspace } from './model'
import { NewProject } from '../projects/NewProject'
import { ProjectFilesPane, ProjectFilesResize } from '../projects/ProjectFilesPane'
import { projectFilesCompact, subscribeProjectFilesLayout } from '../projects/files'
import { RemoteChatDialog } from '../connect/RemoteChatDialog'
import { DiscoverProjects } from '../projects/DiscoverProjects'
import { McpConnections, McpServerList, McpSummary } from '../agents/mcp'
import { useBackendDiscovery } from '../agents/useBackendDiscovery'
import { conversationPermission, permissionLabel } from '../agents/permissions'
import { readStorage } from '../storage'
import { terminalIsActive } from '../chats/model'
import { useVoice } from '../chats/voice'
import { VoiceButton, VoicePanel } from '../chats/VoiceControls'
import { ChatComposer, EmptyChatDraft } from '../chats/ChatComposer'
import { ChatModelPicker } from '../chats/ChatModelPicker'
import type { ChatAttempt } from '../chats/composer'
import type { ComposerMentionGroup } from '../chats/InboxComposerInput'
import { useMentionResources } from '../chats/MentionResources'
import { findModelSetting, modelSettingMentions, modelSettingShortcuts } from '../chats/modelSettingMentions'
import type { SavedWorkflow } from '../workflows/library'
import { resolvePromptReferences } from '../chats/fileReferences'
import { commandInput, configOptions, settingValue, type ChatCommand, type SessionConfig } from '../chats/commands'
import { CommandDialog, type CommandPanel } from '../chats/CommandDialog'
import type { ChatDeletionChoice, ChatSnapshot } from '../chats/model'
import { ChatHistory, groupHistory, recentHistoryLimit, type Preview } from '../chats/ChatHistory'
import { openMainInbox } from '../carrier/navigation'
import './chat.css'
import { reportRecovery } from '../recovery/events'
import { useChatRecovery } from '../chats/useChatRecovery'
import { SupervisionControl } from '../command/SupervisionControls'
import { chatSupervision, supervisionActive, supervisionChat } from '../command/supervision'
import { chatMentionLink } from '../chats/composerMentions'
import { WorkspaceTheme, useContentFieldVariant } from '../branding/ContentTheme'

type ChatMode = 'chat' | 'work'
type Suggestion = { label: string; icon: IconName; prompt: string }

function orderRecentConversations(items: Preview[], addedAt: Record<string, number>) {
  // A conversation's position changes only when it enters Recent.
  return [...items].sort((a, b) =>
    (addedAt[b.id] ?? b.createdAt ?? 0) - (addedAt[a.id] ?? a.createdAt ?? 0) || a.id.localeCompare(b.id))
}

function ComposerPicker({ label, icon, value, options, disabled, active = false, showValue = false, displayValue, summary = '', onChange }: {
  label: string
  icon?: IconName
  value: string
  options: SelectOption[]
  disabled: boolean
  active?: boolean
  showValue?: boolean
  displayValue?: string
  summary?: string
  onChange: (value: string) => void
}) {
  const theme = useThemeAttributes()
  const current = options.find((option) => option.id === value)
  const caption = `${label}: ${displayValue ?? current?.label ?? (value || 'Choose an option')}${summary}`
  return (
    <Select className={`command-context-picker command-context-picker--${label.toLowerCase()}`} aria-label={label} selectedKey={value} isDisabled={disabled}
      disabledKeys={options.filter((option) => option.disabled).map((option) => option.id)}
      onSelectionChange={(key) => { if (key !== null) onChange(String(key)) }}>
      <span className="command-context-picker-label">{label}</span>
      <Tooltip content={caption} className="command-picker-tooltip">
        <Button variant="ghost" size="sm" iconOnly={!showValue} className={`command-context-button${showValue ? ' command-model-button' : ''}`} data-active={active || undefined} aria-label={label} disabled={disabled}>
          {icon && <Icon name={icon} />}
          <SelectValue className={showValue ? 'command-model-value' : 'bbb-visually-hidden'}>{() => <>
            <span className="command-model-name">{displayValue ?? current?.label ?? value}</span>
            {summary && <span className="command-model-summary">{summary}</span>}
          </>}</SelectValue>
          {showValue && !disabled && <Icon name="chevron-down" className="command-picker-chevron" />}
        </Button>
      </Tooltip>
      <Popover {...theme} placement="top start" className="bbb-theme bbb-floating-surface bbb-dropdown-surface command-context-options">
        <p className="command-context-options-label">{label}</p>
        <ListBox className="bbb-option-list" items={options}>
          {(option) => (
            <ListBoxItem id={option.id} textValue={option.label} className="bbb-option">
              {({ isSelected }) => (
                <>
                  <span className="bbb-option__content">
                    <span>{option.label}{option.description && <span className="bbb-option__description">{option.description}</span>}</span>
                  </span>
                  {isSelected && <Icon name="check" />}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  )
}

const suggestions: Record<ChatMode, Suggestion[]> = {
  chat: [
    { label: 'Explore an idea', icon: 'sparkles', prompt: 'Help me think through this idea:\n' },
    { label: 'Help me write', icon: 'file-text', prompt: 'Help me write a clear first draft of:\n' },
    { label: 'Explain something', icon: 'scan', prompt: 'Explain this in simple terms:\n' },
    { label: 'Make a plan', icon: 'calendar', prompt: 'Help me make a practical plan for:\n' },
    { label: 'Supervise ongoing work', icon: 'eye', prompt: 'Supervise the following work until its requirements are verified. Keep monitoring after your reply ends, coordinate follow-ups and independent verification, and report progress here:\n' },
  ],
  work: [
    { label: 'Implement a specification', icon: 'layers', prompt: 'Implement the following specification. Include validation and summarize the changes:\n' },
    { label: 'Review project changes', icon: 'eye', prompt: 'Review the project changes for correctness and suggest focused improvements.' },
    { label: 'Plan the next step', icon: 'calendar', prompt: 'Explore this idea and propose an implementation plan:\n' },
    { label: 'Supervise ongoing work', icon: 'eye', prompt: 'Supervise the following work until its requirements are verified. Keep monitoring after your reply ends, coordinate follow-ups and independent verification, and report progress here:\n' },
  ],
}

type ChatPageProps = { workspace: Workspace; navigate: (route: string) => void; chatId?: string; supervisionId?: string; supervisingOnly?: boolean; workflows?: SavedWorkflow[] }

export function ChatPage(props: ChatPageProps) { return <ChatSurface {...props} surface="chat" /> }
export function HomeChatComposer(props: Pick<ChatPageProps, 'workspace' | 'navigate' | 'workflows'>) { return <ChatSurface {...props} surface="home" /> }

// Both entry points use the same draft, discovery, commands, settings, and submission flow.
function ChatSurface({ workspace: w, navigate, chatId, supervisionId, supervisingOnly = false, workflows = [], surface }: ChatPageProps & { surface: 'chat' | 'home' }) {
  const fieldVariant = useContentFieldVariant()
  const [draftComposer, setDraftComposer] = useState(w.chatComposers.getDraft)
  const [activePreview, setActivePreview] = useState<Preview | null>(() => {
    const id = chatId ?? draftComposer.getSnapshot().draftChatId
    if (!id) return null
    const chat = w.chats.chats.find(chat => chat.id === id)
    return { id, mode: chat?.mode ?? 'chat', prompt: chat?.title ?? 'Conversation', agent: chat?.profile ?? 'Codex', project: chat?.project, chat: true }
  })
  const composer = activePreview ? w.chatComposers.forConversation(activePreview.id, activePreview.project) : draftComposer
  const composerScope = useMemo(() => requestId(), [composer])
  const draftStore = composer.draft
  const { sending, actionBusy, notice, pendingAttempt, configuration, messages: pendingMessages, messagesPaused } = useSyncExternalStore(composer.subscribe, composer.getSnapshot)
  const [chatOpenFailed, setChatOpenFailed] = useState(false)
  const [chatOpenError, setChatOpenError] = useState('')
  const failedChatOpen = useRef<{ chatId: string; revision: number; message: string } | null>(null)
  const [recoveryWait, setRecoveryWait] = useState(false)
  const busy = sending || actionBusy
  const setNotice = (notice: string) => composer.update({ notice })
  const setBusy = (sending: boolean) => composer.update({ sending })
  const setPendingAttempt = (pendingAttempt: ChatAttempt | null) => composer.update({ pendingAttempt })
  const currentComposer = useRef<typeof composer | null>(composer)
  useLayoutEffect(() => {
    currentComposer.current = composer
    return () => { currentComposer.current = null }
  }, [composer])
  function isCurrentComposer() {
    if (currentComposer.current !== composer) return false
    const route = window.location.hash.split('?')[0]
    if (surface === 'home') return route === '#/home' || route === '#/' || route === ''
    if (route === '#/chat' || route === '#/chat/supervising') return !chatId
    const id = route.match(/^#\/chat\/([^/]+)(?:\/supervision\/[^/]+)?$/)?.[1]
    return Boolean(id && w.chatComposers.forConversation(id) === composer)
  }
  function showPreview(preview: Preview) {
    currentComposer.current = w.chatComposers.forConversation(preview.id, preview.project)
    setActivePreview(preview)
  }
  const draftProject = useSyncExternalStore(draftStore.subscribe, draftStore.getProject)
  const draftEmpty = useSyncExternalStore(draftStore.subscribe, draftStore.isEmpty)
  const mode: ChatMode = draftProject ? 'work' : 'chat'
  const selectedProject = w.projects.projects.find((project) => project.name === draftProject)
  const compactFiles = useSyncExternalStore(subscribeProjectFilesLayout, projectFilesCompact)
  const [filesOpen, setFilesOpen] = useState(() => {
    try { return readStorage('aixand.chat.projectFiles.open') === 'true' } catch { return false }
  })
  const [mobileFilesOpen, setMobileFilesOpen] = useState(false)
  const [filesWidth, setFilesWidth] = useState(() => {
    try { const value = Number(readStorage('aixand.projectFiles.width')); return value >= 280 && value <= 720 ? value : 384 }
    catch { return 384 }
  })
  useEffect(() => {
    try {
      localStorage.setItem('aixand.chat.projectFiles.open', String(filesOpen))
      localStorage.setItem('aixand.projectFiles.width', String(filesWidth))
    } catch { /* File browsing stays available when preferences cannot be saved. */ }
  }, [filesOpen, filesWidth])
  const mcpServers = configuration.mcpServers
  const setMcpServers = (mcpServers: string[] | undefined) => composer.configure({ mcpServers })
  const [composerOptionsOpen, setComposerOptionsOpen] = useState(false)
  const [modelOptionsOpen, setModelOptionsOpen] = useState(false)
  const backendChoice = configuration.backendChoice
  const setBackendChoice = (backendChoice: string) => composer.configure({ backendChoice })
  const [settingPicker, setSettingPicker] = useState<string | null>(null)
  const [commandPanel, setCommandPanel] = useState<CommandPanel | null>(null)
  const [commandsError, setCommandsError] = useState('')
  const [commandsLoading, setCommandsLoading] = useState(false)
  const preparation = useRef<{ composer: typeof composer; promise: Promise<ChatSnapshot | undefined> } | null>(null)
  const expectedCommandOutput = useRef<{ chatId: string; key: string; composer: typeof composer } | null>(null)
  useEffect(() => { setCommandsError(''); setCommandsLoading(false); setSettingPicker(null); setCommandPanel(null); setModelOptionsOpen(false) }, [composer])
  const resources = configuration.resources
  const setResources = (resources: ResourceRequest) => composer.configure({ resources })
  const suiteTools = configuration.suiteTools
  const setSuiteTools = (suiteTools: boolean) => composer.configure({ suiteTools })
  const [resourcesValid, setResourcesValid] = useState(true)
  const backendAccess = configuration.backendAccess
  const setBackendAccess = (backendAccess: string) => composer.configure({ backendAccess })
  const projectOptions: SelectOption[] = [
    { id: '', label: 'No project', description: 'Start a general chat' },
    ...w.projects.projects.map((project) => ({ id: project.id, label: project.name, description: project.path })),
    ...(!selectedProject && draftProject ? [{ id: '@legacy', label: draftProject }] : []),
    { id: '@new', label: 'New project…', disabled: w.agents.status !== 'connected' },
    { id: '@discover', label: 'Discover projects…', disabled: w.agents.status !== 'connected' },
  ]
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [remoteChatOpen, setRemoteChatOpen] = useState(false)
  const [discoveryOpen, setDiscoveryOpen] = useState(false)
  const [discoveryJobId, setDiscoveryJobId] = useState<string | null>(null)
  const defaultAgent = w.chatProfiles.find((p) => p.preferred)?.id ?? w.chatProfiles.find((p) => !p.automatic && p.ready !== false)?.id ?? w.chatProfiles[0]?.id ?? ''
  const agent = configuration.profileId || defaultAgent
  const setAgent = (profileId: string) => composer.configure({ profileId })
  const modelChoice = configuration.modelChoice
  const setModelChoice = (modelChoice: typeof configuration.modelChoice) => composer.configure({ modelChoice })
  const [chatPreviews, setChatPreviews] = useState<Preview[]>([])
  const [deletingPreview, setDeletingPreview] = useState<Preview | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [supervisionFilter, setSupervisionFilter] = useState(supervisingOnly)
  useEffect(() => { if (supervisingOnly) setSupervisionFilter(true) }, [supervisingOnly])
  const [recentAddedAt, setRecentAddedAt] = useState<Record<string, number>>(() => {
    try {
      const stored: unknown = JSON.parse(readStorage('aixand.command.recentAddedAt') ?? '{}')
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
      return Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0))
    } catch { return {} }
  })
  useEffect(() => {
    try { localStorage.setItem('aixand.command.recentAddedAt', JSON.stringify(recentAddedAt)) }
    catch { /* Keep Recent usable when browser storage is unavailable. */ }
  }, [recentAddedAt])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return readStorage('aixand.chat.sidebar') === 'collapsed' } catch { return false }
  })
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    try { localStorage.setItem('aixand.chat.sidebar', sidebarCollapsed ? 'collapsed' : 'expanded') } catch { /* Keep navigation usable without storage. */ }
  }, [sidebarCollapsed])
  const [historyProject, setHistoryProject] = useState<string | null>(null)
  const [expandedParents, setExpandedParents] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(readStorage('aixand.command.expandedParents') ?? '[]')
      return Array.isArray(stored) && stored.every((id) => typeof id === 'string') ? stored : []
    } catch { return [] }
  })
  useEffect(() => {
    try { localStorage.setItem('aixand.command.expandedParents', JSON.stringify(expandedParents)) }
    catch { /* Keep toggles usable when browser storage is unavailable. */ }
  }, [expandedParents])
  const followupMode = configuration.followupMode ?? 'steer'
  const setFollowupMode = (followupMode: 'steer' | 'queue') => composer.configure({ followupMode })
  const terminalAttempts = useRef(new Map<string, string>())
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const isRemoteChat = Boolean(activePreview?.chat && (w.chats.snapshots[activePreview.id]?.deviceId ||
    w.chats.chats.find((chat) => chat.id === activePreview.id)?.deviceId))
  const activeRun = w.carrier.runs.find((run) => run.key === activePreview?.id)
  const retainedChat = activePreview?.chat ? w.chats.snapshots[activePreview.id] ?? w.chats.chats.find(row => row.id === activePreview.id) : undefined
  const retainedProfile = retainedChat ?? activeRun
  const profile = retainedProfile ?
    w.chatProfiles.find(p => p.id === `${retainedProfile.provider}/${retainedProfile.profile}`) ?? {
      id: `${retainedProfile.provider}/${retainedProfile.profile}`, name: retainedProfile.profile, provider: retainedProfile.provider,
      role: `${retainedProfile.provider} profile`, model: retainedProfile.model ?? 'Default', instructions: '', automatic: false,
    } : w.chatProfiles.find((p) => p.id === agent)
  const managedProfile = profile && ['codex', 'opencode', 'claude', 'antigravity', 'copilot'].includes(profile.provider)
  const providerChoice = profile?.provider ?? ''
  const providerName = (id: string) => w.agents.catalog?.capabilities.find(row => row.provider === id)?.label ??
    ({ codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity', opencode: 'OpenCode' } as Record<string, string>)[id] ?? id
  const providerOptions: SelectOption[] = [...new Set(w.chatProfiles.map(p => p.provider))].map(id => ({ id, label: providerName(id) }))
  const effectiveBackend = retainedChat ? retainedChat.backendRoute === 'managed' ? retainedChat.backend ?? '' : '' : backendChoice || (profile && ['claude', 'opencode', 'antigravity', 'copilot'].includes(profile.provider) ?
    preferredBackend(w.agents.catalog?.backends, profile.provider)?.id ?? `${profile.provider}-${profile.provider === 'antigravity' ? 'sdk' : 'acp'}` : '')
  const backendOption = isRemoteChat ? undefined : w.agents.catalog?.backends?.find(row => row.id === effectiveBackend && row.provider === profile?.provider)
  const selectedMcpServers = mcpServers ?? w.agents.catalog?.profiles.find((row) => row.id === agent)?.mcp?.servers ?? []
  const mcpSelection = { inherit: false, add: selectedMcpServers }
  const resourceArgs = { ...launchResourceArgs(resources, mcpServers === null ? undefined : mcpSelection), suiteTools }
  const usesAppServer = (['codex', 'claude', 'antigravity'].includes(profile?.provider ?? '') || Boolean(backendOption)) && !activeRun
  const activeChat = activePreview?.chat ? w.chats.snapshots[activePreview.id] : undefined
  const catalogDraft = !activePreview && usesAppServer
  const discovery = useBackendDiscovery(w.agents, catalogDraft && profile && backendOption?.available !== false && resourcesValid ? {
    provider: profile.provider, profile: profile.automatic ? null : profile.name, backend: effectiveBackend || 'native-codex',
    ...(selectedProject ? { projectId: selectedProject.id } : { draftId: configuration.draftId }), resources: resourceArgs.resources,
    ...(modelChoice.profileId === agent && modelChoice.value ? { model: modelChoice.value } : {}),
  } : undefined)
  const draftCommands = !activePreview && !pendingAttempt ? (discovery.snapshot?.commands.length ? discovery.snapshot.commands :
    (backendOption ?? w.agents.catalog?.backends?.find(row => row.id === 'native-codex'))?.commandPreview)?.map(command =>
    catalogDraft && ['native', 'suite', 'prompt', 'terminal'].includes(command.execution) && !command.startsConversation ? { ...command, execution: 'unsupported' as const,
      reason: 'Start a conversation before using this command.' } : command) : undefined
  const configurableSettings = activeChat?.sessionConfig ?? (catalogDraft ? discovery.snapshot?.settings.map(option => ({ ...option,
    defaultUnknown: option.defaultUnknown && configuration.settings[option.id] === undefined,
    currentValue: option.category === 'model' && backendOption?.controls.model !== false ? modelChoice.profileId === agent ? modelChoice.value : '' : configuration.settings[option.id] ?? option.currentValue })) : [])
  const initialConfig = Object.entries(configuration.settings).map(([id, value]) => ({ id, value }))
  const invalidDraftSettings = catalogDraft && discovery.snapshot?.state === 'ready' ? initialConfig.filter(selection => {
    const option = configurableSettings?.find(row => row.id === selection.id)
    return !option || !(option.type === 'boolean' && typeof selection.value === 'boolean' || option.type === 'select' &&
      configOptions(option).some(row => row.value === selection.value))
  }) : []
  const availableCommands = activeChat?.availableCommands ?? draftCommands ?? []
  const failedCreation = activeChat?.backendRoute === 'managed' && activeChat.status === 'failed' && !activeChat.turnId && activeChat.items.length === 0
  const creationAlternatives = failedCreation ? w.agents.catalog?.backends?.filter(row => row.provider === activeChat.provider && row.available && row.id !== activeChat.backend) ?? [] : []
  const supervising = chatSupervision(w.command.monitors, activePreview?.id)
  const supervision = supervising[0]
  const executionMonitor = supervising.find(monitor => (monitor.supervisorChatId === activePreview?.id || activeChat?.automationId === monitor.id) && monitor.state !== 'cancelled')
  const supervisedBy = w.command.monitors.filter(monitor => supervisionActive(monitor) && monitor.watchedChatIds?.includes(activePreview?.id ?? '') && supervisionChat(monitor) !== activePreview?.id)
  const waitingForChat = Boolean(activePreview?.chat && (!activeChat || activeChat.syncing))
  useEffect(() => {
    setRecoveryWait(false)
    if (!waitingForChat) return
    const timer = setTimeout(() => setRecoveryWait(true), 15000)
    return () => clearTimeout(timer)
  }, [activePreview?.id, waitingForChat])
  useEffect(() => { setChatOpenFailed(false); setChatOpenError(''); failedChatOpen.current = null }, [chatId])
  useEffect(() => {
    const failed = failedChatOpen.current
    if (!failed || !activeChat || activeChat.id !== failed.chatId || activeChat.revision <= failed.revision ||
      activeChat.syncing || ['offline', 'uncertain'].includes(activeChat.status) || w.agents.status !== 'connected') return
    failedChatOpen.current = null
    setChatOpenFailed(false)
    setChatOpenError('')
    if (notice === failed.message) composer.update({ notice: '' })
  }, [activeChat, w.agents.status, composer, notice])
  const [agentActions, setAgentActions] = useState<ManagementAction[]>([])
  useEffect(() => {
    let current = true
    setAgentActions([])
    if (!activeChat?.id || w.agents.status !== 'connected') return
    const chatId = activeChat.id
    void w.agents.request<{ actions: ManagementAction[] }>('agent-management-actions', { chatId })
      .then(result => { if (current && Array.isArray(result?.actions)) setAgentActions(previous => {
        const received = new Map(result.actions.map(action => [action.id, action]))
        for (const action of previous) received.set(action.id, action)
        return [...received.values()]
      }) })
      .catch(() => {})
    const unsubscribe = w.agents.subscribe(value => {
      const message = value as { type: string; action?: ManagementAction }
      if (message.type === 'agent-management-updated' && message.action?.sourceChatId === chatId && current) {
        const action = message.action
        setAgentActions(previous => [...previous.filter(row => row.id !== action.id), action])
      }
    })
    return () => { current = false; unsubscribe() }
  }, [activeChat?.id, w.agents.status])

  const managedBackend = activeChat?.backendRoute === 'managed' || (!activePreview && Boolean(backendOption))
  useEffect(() => { if (activeChat?.discoveries) w.projects.remember(activeChat.discoveries) }, [activeChat?.discoveries, w.projects.remember])
  const voice = useVoice(w.agents, activePreview?.chat ? activePreview.id : null)
  const registeredChat = activePreview?.chat ? w.chats.chats.find((chat) => chat.id === activePreview.id) : undefined
  const projectChat = activeChat ?? registeredChat
  const filesProject = isRemoteChat || (chatId && activePreview?.id !== chatId) ? undefined : activePreview ?
    activePreview.chat ? w.projects.projects.find((project) => projectChat?.projectId ? project.id === projectChat.projectId :
      Boolean(projectChat?.project) && project.name === projectChat?.project) :
    w.projects.projects.find((project) => project.name === activePreview.project) : selectedProject
  const desktopFilesOpen = Boolean(filesProject && filesOpen && !compactFiles)
  useEffect(() => { setMobileFilesOpen(false) }, [filesProject?.id, compactFiles])
  const conversationProfile = activeChat?.profile ?? registeredChat?.profile
  const conversationProfileId = conversationProfile ? `${activeChat?.provider ?? registeredChat?.provider ?? 'codex'}/${conversationProfile}` : undefined
  const modelLocked = Boolean(activePreview?.chat || activeRun)
  const sessionModel = configurableSettings?.find(row => row.category === 'model' && row.type === 'select')
  const sessionMode = findModelSetting(configurableSettings, availableCommands, 'mode')
  const sessionOptions = (option: typeof sessionModel): SelectOption[] => option?.options?.flatMap(row => 'options' in row ? row.options : [row]).map(row => ({ id: row.value, label: row.name })) ?? []
  const model = modelLocked ? (typeof sessionModel?.currentValue === 'string' ? sessionModel.currentValue : undefined) ?? activeChat?.model ?? registeredChat?.model ?? activeRun?.model ?? activePreview?.model ?? '' :
    backendOption?.controls.model === false && typeof sessionModel?.currentValue === 'string' ? sessionModel.currentValue : modelChoice.profileId === agent ? modelChoice.value : ''
  const modelCatalog = { models: discovery.snapshot?.models ?? [], loading: discovery.loading, error: discovery.error, refresh: discovery.refresh }
  const defaultModel = profile?.model && profile.model !== 'Default' ? profile.model : undefined
  const modelOptions: SelectOption[] = sessionModel && (!catalogDraft || backendOption?.controls.model === false) ? sessionOptions(sessionModel) : [
    { id: '', label: 'Profile default', description: defaultModel ? `Use ${defaultModel}` : 'Use the profile’s configured model' },
    ...modelCatalog.models.map((item) => ({ id: item.id, label: item.name,
      description: `${item.id}${item.free ? ' · Free' : ''}${item.description ? ` · ${item.description}` : ''}` })),
  ]
  if (catalogDraft && backendOption?.controls.model === false && !modelOptions.some(option => option.id === ''))
    modelOptions.unshift({ id: '', label: 'Provider default' })
  if (model && !modelOptions.some((option) => option.id === model))
    modelOptions.push({ id: model, label: model, ...(catalogDraft ? { description: 'Custom model · retained outside the discovered list' } : {}) })
  const agentOptions: SelectOption[] = w.chatProfiles.filter(p => p.provider === providerChoice).map((p) => ({
    id: p.id, label: p.label ?? p.name, description: p.reason ?? (p.automatic ? `${p.role} · selected at launch` : p.role),
  }))
  const mentionResources = useMentionResources(w.agents, `${composerScope}:${agent}:${effectiveBackend}:${filesProject?.id ?? ''}`)
  if (conversationProfileId && !agentOptions.some((option) => option.id === conversationProfileId))
    agentOptions.push({ id: conversationProfileId, label: activeChat?.deviceId || registeredChat?.deviceId ? 'Remote Codex' : conversationProfile!, description: `${profile?.provider ?? 'codex'} profile` })
  const initialSend = w.carrier.outbox.find((item) => item.key === `task:${activeRun?.key}`)
  const activeTurn = Boolean(activeChat && ['running', 'waiting'].includes(activeChat.status))
  const queueAvailable = Boolean(activeChat && (!managedBackend || activeChat.chatCapabilities?.queue))
  const steerAvailable = Boolean(activeChat && (!managedBackend || activeChat.chatCapabilities?.steer))
  const effectiveFollowupMode = steerAvailable ? followupMode : 'queue'
  const followupOptions = Boolean(!executionMonitor && usesAppServer && activeChat && queueAvailable && !voice.engaged && (activeTurn || activeChat.queue?.messages.length))
  const sendLabel = pendingAttempt ? 'Retry request' : executionMonitor ? 'Send direction' : followupOptions ?
    effectiveFollowupMode === 'queue' ? 'Send after this turn' : activeTurn ? 'Add to current turn' : 'Send message' :
    managedProfile ? activeRun || activePreview?.chat ? 'Send message' : 'Start agent' : mode === 'chat' ? 'Send message' : 'Create work draft'
  const selectedReadiness = w.agents.catalog?.profiles.find(row => row.id === agent)?.readiness
  const readiness = (effectiveBackend ? selectedReadiness?.backends?.[effectiveBackend] : undefined) ?? selectedReadiness?.chat ?? selectedReadiness
  const canSubmit = (Boolean(retainedChat) || readiness?.ready !== false) && resourcesValid && invalidDraftSettings.length === 0 && (!activeChat?.initialConfiguration || activeChat.initialConfiguration.state === 'ready') && Boolean(profile && (retainedChat || ((!['claude', 'antigravity'].includes(profile.provider) || Boolean(backendOption?.available)) && (!backendOption || backendOption.available))) && !busy && !activeChat?.syncing && !activeChat?.backendHistoryPending && !(managedBackend && activeTurn && !queueAvailable) && (!voice.engaged || voice.phase === 'active') && (!managedProfile ||
    (usesAppServer ? (w.agents.status === 'connected' || Boolean(activePreview?.chat && activeChat)) && (pendingAttempt || !activePreview?.chat ||
      (activeChat && (!activeTurn || (!voice.engaged && (effectiveFollowupMode === 'queue' || activeChat.turnId))))) :
      w.carrier.status === 'connected' && w.carrier.service?.connected && w.carrier.service.agent_configured &&
      w.carrier.service.providers.includes(profile.provider))))
  const runCreatedAt = new Map(w.carrier.runs.map((run): [string, number] => [run.key, run.created_at * 1000]))
  function activityFor(item: Preview): ChatActivity {
    const unconfirmed = item.id === activePreview?.id && (pendingAttempt && !busy || pendingMessages.some(row => row.status === 'failed' && row.uncertain))
    if (item.chat) {
      const registered = w.chats.chats.find((chat) => chat.id === item.id)
      const snapshot = w.chats.snapshots[item.id]
      const chat = snapshot && (!registered || snapshot.revision > registered.revision) ? snapshot : registered
      if (chat?.sessionRecovery?.phase === 'restoring') return 'reconnecting'
      if (!chat && w.agents.status === 'connected') return unconfirmed ? 'unknown' : pendingAttempt ? 'starting' : 'checking'
      const activity = chatActivity(chat?.status, w.agents.status === 'connected', chat?.statusReason, chat?.connectionState)
      return unconfirmed && activity !== 'disconnected' ? 'unknown' : activity
    }
    if (unconfirmed) return 'unknown'
    const run = w.carrier.runs.find((run) => run.key === item.id)
    if (run) return chatActivity(run.task_status ?? run.status, w.carrier.status === 'connected' && Boolean(w.carrier.service?.connected))
    if (item.id === activePreview?.id && pendingAttempt) return 'starting'
    return 'draft'
  }
  const previews: Preview[] = [
    ...chatPreviews,
    ...w.chats.chats.map((chat): Preview => ({ id: chat.id, mode: chat.mode, prompt: chat.title, agent: chat.profile, chat: true, labels: chat.labels, createdAt: chat.createdAt,
      parentId: chat.parentChatId === undefined ? chat.originChatId : chat.parentChatId,
      ...(chat.project ? { project: chat.project } : {}) })),
    ...w.carrier.runs.filter((run) => run.mode === 'chat').map((run): Preview => ({ id: run.key, mode: 'chat', prompt: run.prompt, agent: run.profile, createdAt: run.created_at * 1000 })),
    ...w.tasks.filter((task) => !w.chats.chats.some((chat) => chat.id === task.id)).map((task): Preview => ({ ...task, mode: 'work', createdAt: runCreatedAt.get(task.id) })),
  ]
  const executionOwners = new Map(w.command.monitors.filter(monitor => supervisionChat(monitor) && monitor.supervisorChatId && supervisionChat(monitor) !== monitor.supervisorChatId)
    .map(monitor => [monitor.supervisorChatId!, supervisionChat(monitor)!]))
  for (const chat of w.chats.chats) {
    const owner = chat.automationId && w.command.monitors.find(monitor => monitor.id === chat.automationId)
    if (owner && supervisionChat(owner) && supervisionChat(owner) !== chat.id) executionOwners.set(chat.id, supervisionChat(owner)!)
  }
  const history = previews.filter(item => !executionOwners.has(item.id) || item.id === activePreview?.id).map((item) => ({ ...item,
    parentId: executionOwners.get(item.parentId ?? '') ?? item.parentId, activity: activityFor(item), supervision: chatSupervision(w.command.monitors, item.id)[0],
  }))
  const recentHistory = orderRecentConversations(history, recentAddedAt)
    .filter(item => !supervisionFilter || item.supervision && supervisionActive(item.supervision))
  const latestHistory = useRef(history)
  latestHistory.current = history
  const projectHistory = new Map<string, Preview[]>(w.projects.projects.map((project) => [project.name, []]))
  for (const item of history) {
    if (item.project) {
      const group = projectHistory.get(item.project) ?? []
      group.push(item)
      projectHistory.set(item.project, group)
    }
  }

  function rememberHistoryItem(id: string) {
    setRecentAddedAt((previous) => {
      const items = latestHistory.current
      const recent = orderRecentConversations(items, previous).slice(0, recentHistoryLimit)
      const entries = groupHistory(recent, items, true)
      while (entries.length) {
        const entry = entries.pop()!
        if (entry.item.id === id) return previous
        entries.push(...entry.children)
      }
      const latestAddition = Object.values(previous).reduce((value, addedAt) => Math.max(value, addedAt), Date.now())
      const newest = items.reduce((value, item) => Math.max(value, item.createdAt ?? 0), latestAddition)
      return { ...previous, [id]: newest + 1 }
    })
  }
  const chatApi = useRef(w.chats)
  chatApi.current = w.chats
  const needsChatRecovery = Boolean(activePreview?.chat && (chatOpenFailed || recoveryWait || activeChat?.status === 'offline' || activeChat?.statusReason === 'notification_error' || activeChat?.sessionRecovery))
  const chatRecovery = useChatRecovery({
    id: activePreview?.chat ? activePreview.id : undefined,
    enabled: w.agents.status === 'connected', needed: needsChatRecovery,
    open: id => chatApi.current.open(id),
    recovered: () => { setChatOpenFailed(false); setChatOpenError(''); failedChatOpen.current = null },
  })
  const transportUnavailable = w.agents.status !== 'connected'
  const showConnectionNotice = transportUnavailable || needsChatRecovery
  const connectionWarning = transportUnavailable ? w.agents.connectionRecovery.exhausted : needsChatRecovery && chatRecovery.exhausted
  const connectionAttempt = transportUnavailable ? w.agents.connectionRecovery.attempt : chatRecovery.attempt
  const connectionError = transportUnavailable ? w.agents.error : activeChat?.sessionRecovery?.message || chatRecovery.error || chatOpenError || activeChat?.error
  useLayoutEffect(() => {
    if (surface === 'home' && !activePreview?.chat) return
    chatApi.current.activate(activePreview?.chat ? activePreview.id : null)
    return () => { chatApi.current.activate(null) }
  }, [activePreview?.id, activePreview?.chat, surface])
  useEffect(() => {
    if (profile?.provider === 'codex' && !profile.automatic && w.agents.status === 'connected' && !activeRun && !activePreview?.chat)
      void chatApi.current.connectProfile(profile.name)
  }, [agent, w.agents.status])
  useEffect(() => {
    let alive = true
    if (!chatId && registeredChat?.id && w.agents.status === 'connected') {
      void chatApi.current.visit(registeredChat.id).catch((error: Error) => { if (alive) setNotice(error.message) })
    }
    return () => { alive = false }
  }, [registeredChat?.id, w.agents.status, chatId])
  const previousChatId = useRef(chatId)
  useLayoutEffect(() => {
    const previous = previousChatId.current
    previousChatId.current = chatId
    if (!chatId) {
      if (previous && activePreview?.chat) {
        const next = w.chatComposers.getDraft()
        currentComposer.current = next
        setDraftComposer(next)
        setActivePreview(null)
      }
      return
    }
    let alive = true
    const target = w.chatComposers.forConversation(chatId)
    if (activePreview?.id !== chatId) showPreview({ id: chatId, mode: 'chat', prompt: 'Conversation', agent: 'Codex', chat: true })
    if (w.agents.status === 'connected') {
      void chatApi.current.visit(chatId).then((chat) => {
        if (!alive || currentComposer.current !== target) return
        setChatOpenFailed(false)
        if (previous !== chatId) rememberHistoryItem(chat.id)
        showPreview({ id: chat.id, mode: chat.mode, prompt: chat.title, agent: chat.profile, model: chat.model ?? undefined, project: chat.project || undefined, chat: true })
        target.configure(chat.deviceId ? { profileId: w.chatProfiles.find((entry) => entry.provider === 'codex')?.id ?? agent } :
          { profileId: `${chat.provider}/${chat.profile}`, backendChoice: chat.backendRoute === 'managed' ? chat.backend ?? '' : '' })
        target.draft.set({ ...target.draft.getSnapshot(), project: chat.project || '' })
      }).catch((error: Error) => { if (alive) {
        failedChatOpen.current = { chatId, revision: chatApi.current.snapshots[chatId]?.revision ?? 0, message: error.message }
        setChatOpenError(error.message); setChatOpenFailed(true)
      } })
    }
    return () => { alive = false }
  }, [chatId, w.agents.status])

  useEffect(() => {
    let alive = true
    setConversation(null)
    if (initialSend?.message_id && w.carrier.status === 'connected') {
      void w.carrier.request<Conversation>('conversation', { mailbox: 'user', id: initialSend.message_id, limit: 100 }).then((result) => { if (alive) setConversation(result) }).catch((error: Error) => { if (alive) setNotice(error.message) })
    }
    return () => { alive = false }
  }, [initialSend?.message_id, activeRun?.key, w.carrier.service?.version, w.carrier.status])

  async function deliverMessage(message: import('../chats/composer').PendingMessage, save: (attempt: NonNullable<import('../chats/composer').PendingMessage['attempt']>) => void) {
    let attempt = message.attempt
    if (!attempt) {
      const captured = message.draft
      const text = await resolvePromptReferences(message.text, captured?.inboxReferences, captured?.fileReferences,
        filesProject?.id, w.carrier.request, w.agents.request)
      await w.agents.ensureConnected()
      const id = activePreview!.id
      let chat = chatApi.current.snapshots[id]
      if (!chat || ['offline', 'uncertain'].includes(chat.status)) chat = await w.chats.open(id)
      if (!chat || ['offline', 'uncertain'].includes(chat.status)) throw new AgentError('Could not confirm the conversation’s current state. Your message is still in the composer.', 'configuration')
      const active = chat && ['running', 'waiting'].includes(chat.status)
      const op = message.mode === 'queue' && (active || chat?.queue?.messages.length) ? 'chat-queue' : active ? 'chat-steer' : 'chat-send'
      attempt = { op, args: { key: message.id, chatId: id, text,
        ...(op === 'chat-steer' ? { expectedTurnId: chat?.turnId } : op === 'chat-send' ? { followupMode: message.mode } : {}) } }
      save(attempt)
    }
    await (attempt.op === 'chat-steer' ? w.chats.steer : attempt.op === 'chat-queue' ? w.chats.queue : w.chats.send)(attempt.args)
  }

  async function submit() {
    const draft = draftStore.getSnapshot()
    const prompt = draft.prompt.trim()
    const startsWithCommand = catalogDraft && commandInput(prompt, availableCommands)?.command.startsConversation
    const parsedDraftCommand = catalogDraft ? commandInput(prompt, availableCommands) : null
    const inlinePlan = parsedDraftCommand?.command.name === 'plan' && parsedDraftCommand.command.execution === 'setting' &&
      parsedDraftCommand.arguments && !['on', 'off', 'plan', 'default', 'status'].includes(parsedDraftCommand.arguments) ? parsedDraftCommand.arguments : ''
    const planConfigId = parsedDraftCommand?.command.configId ?? 'mode'
    const creationConfig = inlinePlan ? [...initialConfig.filter(row => row.id !== planConfigId), { id: planConfigId, value: 'plan' }] : initialConfig
    if ((!prompt && !pendingAttempt) || !profile || busy || activeChat?.syncing || (voice.engaged && voice.phase !== 'active')) return
    if (!startsWithCommand && !inlinePlan && !executionMonitor && usesAppServer && (pendingAttempt?.op === 'chat-config-set' || pendingAttempt?.op === 'chat-command' || !pendingAttempt &&
      (commandInput(prompt, activeChat?.availableCommands ?? []) || /^\/[A-Za-z][^\s/]*(?:\s[\s\S]*)?$/.test(prompt)))) {
      await submitCommand(prompt)
      return
    }
    if (activePreview?.chat && activeChat && usesAppServer && !executionMonitor && !voice.engaged && !pendingAttempt) {
      if (pendingMessages.length >= 20) { setNotice('There are already 20 messages waiting for delivery. Review them before adding more.'); return }
      composer.enqueue({ id: requestId(), text: prompt, mode: effectiveFollowupMode, status: 'waiting', draft }, deliverMessage)
      draftStore.set({ ...draft, prompt: '', inboxReferences: [], fileReferences: [] })
      rememberHistoryItem(activePreview.id)
      if (isCurrentComposer()) navigate(`chat/${activePreview.id}`)
      promptRef.current?.focus()
      return
    }
    if (!composer.begin('sending')) return
    let resolvedPrompt = pendingAttempt?.frozenPrompt ?? (inlinePlan || prompt)
    if (!pendingAttempt) {
      setBusy(true); setNotice('')
      try { resolvedPrompt = await resolvePromptReferences(inlinePlan || prompt, draft.inboxReferences, draft.fileReferences,
        filesProject?.id, w.carrier.request, w.agents.request) }
      catch (error) {
        setNotice(error instanceof Error ? error.message : 'Unable to load the referenced inbox message.')
        setBusy(false)
        return
      }
    }
    if (usesAppServer) {
      setBusy(true); setNotice('')
      let queuedRequest = false
      try {
        const reconnecting = w.agents.status !== 'connected'
        await w.agents.ensureConnected()
        let currentChat = activeChat
        if (activePreview?.chat && (reconnecting || !currentChat || ['offline', 'uncertain'].includes(currentChat.status))) {
          setNotice('Reconnecting to your conversation…')
          currentChat = await w.chats.open(activePreview.id)
          setNotice('')
        }
        let attempt = pendingAttempt
        if (executionMonitor || attempt?.op === 'command-update') {
          const directionAttempt = attempt?.op === 'command-update' ? attempt : { op: 'command-update' as const, args: {
            key: requestId(), monitorId: executionMonitor!.id, expectedRevision: executionMonitor!.revision, direction: resolvedPrompt,
          } }
          setPendingAttempt(directionAttempt)
          await w.command.mutate('command-update', directionAttempt.args)
          setPendingAttempt(null)
          draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [], fileReferences: [] })
          setNotice('Direction saved. The supervisor will evaluate the updated brief.')
          return
        }
        if (!attempt) {
          if (activePreview?.chat) {
            if (!currentChat || ['offline', 'uncertain'].includes(currentChat.status))
              throw new Error('Could not confirm the conversation’s current state. Your message is still in the composer')
            const currentTurn = ['running', 'waiting'].includes(currentChat.status)
            const currentFollowups = !voice.engaged && (currentTurn || currentChat.queue?.messages.length)
            const op = currentFollowups && effectiveFollowupMode === 'queue' ? 'chat-queue' : currentTurn ? 'chat-steer' : 'chat-send'
            attempt = { op, args: { key: requestId(), chatId: activePreview.id, text: resolvedPrompt,
              ...(op === 'chat-steer' ? { expectedTurnId: currentChat.turnId } : {}) } }
            rememberHistoryItem(activePreview.id)
          } else {
            const key = configuration.draftId
            attempt = { op: 'chat-create', frozenPrompt: resolvedPrompt, args: { key, provider: profile.provider, profile: profile.automatic ? null : profile.name,
              ...(backendOption ? { backend: backendOption.id,
                ...(backendOption.controls.access ? { permissionMode: backendAccess } : {}) } : {}),
              mode: selectedProject ? 'work' : 'chat',
              ...resourceArgs,
              ...(creationConfig.length ? { initialConfig: creationConfig } : {}),
              ...(model && backendOption?.controls.model !== false ? { model } : {}),
              ...(selectedProject ? { projectId: selectedProject.id } : {}) } }
            const command = startsWithCommand ? commandInput(resolvedPrompt, availableCommands) : null
            if (command) attempt.firstCommand = { name: command.command.name, arguments: command.arguments }
            w.chatComposers.attach(key, composer)
            rememberHistoryItem(key)
            if (isCurrentComposer()) showPreview({ id: key, mode, prompt, agent: profile.name, chat: true,
              ...(model ? { model } : {}),
              ...(mode === 'work' ? { project: draftProject } : {}) })
          }
        }
        queuedRequest = attempt.op === 'chat-queue'
        setPendingAttempt(attempt)
        if (attempt.op === 'chat-create') {
          const chat = await w.chats.create(attempt.args)
          if (chat.id !== attempt.args.key) rememberHistoryItem(chat.id)
          w.chatComposers.attach(chat.id, composer)
          if (isCurrentComposer()) showPreview({ id: chat.id, mode: chat.mode, prompt: chat.title, agent: chat.profile,
            model: chat.model ?? undefined, project: chat.project || undefined, chat: true })
          if (attempt.firstCommand) {
            await w.chats.commands(chat.id)
            attempt = { op: 'chat-command', args: { key: requestId(), chatId: chat.id,
              command: attempt.firstCommand.name, arguments: attempt.firstCommand.arguments } }
          } else attempt = { op: 'chat-send', args: { key: requestId(), chatId: chat.id, text: attempt.frozenPrompt ?? resolvedPrompt } }
          setPendingAttempt(attempt)
          if (attempt.op === 'chat-send' && !voice.engaged) {
            composer.enqueue({ id: String(attempt.args.key), text: String(attempt.args.text), mode: 'steer', status: 'waiting',
              attempt: { op: 'chat-send', args: { ...attempt.args, followupMode: 'steer' } }, draft }, deliverMessage)
            setPendingAttempt(null)
            draftStore.set({ ...draft, prompt: '', inboxReferences: [], fileReferences: [] })
            if (isCurrentComposer()) { navigate(`chat/${chat.id}`); promptRef.current?.focus() }
            return
          }
        }
        if (!['chat-send', 'chat-steer', 'chat-queue', 'chat-command'].includes(attempt.op)) throw new Error('Start a new conversation to change its provider.')
        await (attempt.op === 'chat-command' ? w.chats.command : attempt.op === 'chat-steer' ? w.chats.steer : attempt.op === 'chat-queue' ? w.chats.queue : w.chats.send)(attempt.args)
        w.chatComposers.attach(String(attempt.args.chatId), composer)
        if (attempt.op === 'chat-queue') setNotice('Message queued. You can edit or remove it before it is sent.')
        setPendingAttempt(null)
        draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [], fileReferences: [] })
        if (isCurrentComposer()) {
          navigate(`chat/${attempt.args.chatId}`)
          promptRef.current?.focus()
        }
      } catch (error) {
        if (error instanceof AgentError && error.code === 'configuration' && !error.uncertain) {
          setPendingAttempt(null); setNotice(error.message); return
        }
        if ((executionMonitor || pendingAttempt?.op === 'command-update') && error instanceof AgentError && error.code === 'manager' && error.message.includes('This monitor changed.')) {
          setPendingAttempt(null)
          setNotice('Supervision changed before this direction was accepted. Your message is still in the composer; send it again with the current brief.')
          return
        }
        if (queuedRequest && error instanceof AgentError && error.code === 'manager') {
          // Queue validation fails before the local receipt commits. Keep the
          // draft editable so a full queue or oversized message can be corrected.
          setPendingAttempt(null)
          setNotice(error.message)
          return
        }
        setNotice(`${error instanceof Error ? error.message : 'Chat request failed'}. Reconnect or refresh to inspect the conversation. Retry uses the same operation.`)
      } finally { setBusy(false) }
      return
    }
    if (managedProfile) {
      setBusy(true); setNotice('')
      try {
        let attempt = pendingAttempt
        if (!attempt && activeRun) {
          if (['launching', 'unknown', 'failed', 'stopped'].includes(activeRun.status)) {
            setNotice('Inspect this conversation in Carrier before sending more instructions.')
            return
          }
          const content = mode === 'work' ? JSON.stringify({ schema: 'aixand.carrier', version: 1, kind: 'task.request', title: prompt.split('\n')[0], body: resolvedPrompt, project_id: activeRun.project, run_id: activeRun.run_id }) : resolvedPrompt
          const parent = conversation?.messages.at(-1)?.id ?? initialSend?.message_id
          attempt = { op: 'send', args: { mailbox: 'user', key: requestId(), to: activeRun.address, content,
            ...(parent ? { reply_to: Number(parent) } : {}) } }
        } else if (!attempt) {
          const key = requestId()
          w.chatComposers.attach(key, composer)
          if (isCurrentComposer()) showPreview({ id: key, mode, prompt, agent: profile.name, ...(model ? { model } : {}), ...(mode === 'work' ? { project: draftProject } : {}) })
          rememberHistoryItem(key)
          attempt = { op: 'launch', args: { key, provider: profile.provider, profile: profile.name, prompt: resolvedPrompt,
            ...(model ? { model } : {}),
            instructions: profile.instructions, project: mode === 'work' ? draftProject : '', mode,
            ...(selectedProject ? { projectId: selectedProject.id } : {}),
            mcp: mcpSelection } }
        }
        // Keep the exact operation across an interrupted response. A retry must
        // reuse its key even if the backend has already registered the run.
        setPendingAttempt(attempt)
        const result = await w.carrier.request<{ status: string }>(attempt.op, attempt.args)
        if (activeRun) rememberHistoryItem(activeRun.key)
        setPendingAttempt(null)
        setNotice(attempt.op === 'send' ? 'Message stored. The agent will reply through Carrier.' :
          result.status === 'active' ? 'Agent started. Replies will appear here and in Carrier.' :
            'Launch recorded. Inspect this conversation in Carrier before continuing.')
        draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [] })
      } catch (error) { setNotice(`${error instanceof Error ? error.message : 'Agent request failed'}. Retry request keeps the same operation; inspect its outcome in Carrier.`) }
      finally { await w.carrier.refresh(); setBusy(false) }
      return
    }
    const preview: Preview = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      mode,
      prompt: resolvedPrompt,
      agent: profile.name,
      ...(mode === 'work' ? { project: draftProject } : {}),
    }
    if (mode === 'work') {
      // Retain the existing draft behavior. Project/session attachment is deferred.
      w.setTasks((previous) => [{ id: preview.id, prompt: resolvedPrompt, agent: profile.name, project: draftProject, status: 'Draft' }, ...previous])
      setNotice('Work draft created. No agent has been started.')
    } else {
      setChatPreviews((previous) => [preview, ...previous])
      setNotice('Message saved in this preview. No agent has been started.')
    }
    w.chatComposers.attach(preview.id, composer)
    if (isCurrentComposer()) showPreview(preview)
    rememberHistoryItem(preview.id)
    draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [] })
    setBusy(false)
    if (isCurrentComposer()) promptRef.current?.focus()
  }

  function startVoice() {
    if (!resourcesValid) { setNotice('Correct the resource instruction inputs before starting a conversation.'); return }
    let created: ChatSnapshot | undefined
    void voice.start(async () => {
      if (activePreview?.chat) {
        rememberHistoryItem(activePreview.id)
        return activePreview.id
      }
      if (!profile || profile.provider !== 'codex') throw new Error('Choose Codex to start voice.')
      const args = { key: configuration.draftId, profile: profile.automatic ? null : profile.name,
        mode: selectedProject ? 'work' : 'chat',
        ...resourceArgs, ...(initialConfig.length ? { initialConfig } : {}),
        ...(model ? { model } : {}),
        ...(selectedProject ? { projectId: selectedProject.id } : {}) }
      rememberHistoryItem(args.key)
      try {
        created = await w.chats.create(args)
        if (created.id !== args.key) rememberHistoryItem(created.id)
        w.chatComposers.attach(created.id, composer)
        return created.id
      } catch (cause) {
        // Retain the exact create operation when its outcome is unconfirmed.
        w.chatComposers.attach(args.key, composer)
        setPendingAttempt({ op: 'chat-create', args })
        if (isCurrentComposer()) showPreview({ id: args.key, mode, prompt: 'Voice conversation', agent: profile.name, chat: true })
        throw cause
      }
    }, (id) => {
      if (!isCurrentComposer()) return
      const chat = created ?? activeChat
      showPreview({ id, mode: chat?.mode ?? mode, prompt: chat?.title ?? 'Voice conversation',
        agent: chat?.profile ?? profile?.name ?? 'Codex', model: chat?.model ?? undefined,
        project: chat?.project || undefined, chat: true })
      navigate(`chat/${id}`)
    })
  }

  function selectAgent(value: string) {
    setAgent(value)
    setBackendChoice('')
    setResources({})
    setSuiteTools(true)
    setModelChoice({ profileId: value, value: '' })
    setMcpServers(undefined)
    composer.configure({ settings: {} })
  }

  function selectProvider(value: string) {
    const candidates = w.chatProfiles.filter(p => p.provider === value)
    const selected = candidates.find(p => p.preferred) ?? candidates.find(p => !p.automatic && p.ready !== false) ?? candidates[0]
    if (selected) selectAgent(selected.id)
  }

  async function changeSessionConfig(configId: string, value: string | boolean, focusComposer = true) {
    if (pendingAttempt || activeTurn) return
    if (!activeChat && catalogDraft) {
      if (value === '' && configurableSettings?.find(row => row.id === configId)?.category === 'model' && backendOption?.controls.model === false) {
        const next = { ...configuration.settings }; delete next[configId]; composer.configure({ settings: next }); return
      }
      if (configurableSettings?.find(row => row.id === configId)?.category === 'model' && backendOption?.controls.model !== false) setModelChoice({ profileId: agent, value: String(value) })
      else composer.configure({ settings: { ...configuration.settings, [configId]: value } })
      setNotice('Draft settings updated.'); return
    }
    if (!activeChat) return
    await applyCommandAttempt({ op: 'chat-config-set', preserveDraft: true,
      args: { key: requestId(), chatId: activeChat.id, configId, value } }, focusComposer)
    if (!focusComposer && isCurrentComposer() && composer.getSnapshot().pendingAttempt) setModelOptionsOpen(false)
  }

  async function prepareCommands(): Promise<ChatSnapshot | undefined> {
    if (!activePreview?.chat) { discovery.check(); return undefined }
    if (!usesAppServer) return undefined
    if (preparation.current?.composer === composer) return preparation.current.promise
    const task = (async () => {
      setCommandsLoading(true); setCommandsError('')
      try {
        await w.agents.ensureConnected()
        return await w.chats.commands(activePreview.id)
      } catch (cause) {
        if (isCurrentComposer()) setCommandsError(cause instanceof Error ? cause.message : 'Could not load commands.')
        return undefined
      } finally { if (isCurrentComposer()) setCommandsLoading(false) }
    })()
    preparation.current = { composer, promise: task }
    try { return await task } finally { if (preparation.current?.promise === task) preparation.current = null }
  }

  async function chooseCommand(command: ChatCommand) {
    if (command.execution === 'unsupported') { setNotice(command.reason ?? 'This command is unavailable for this session.'); return }
    if (command.execution === 'terminal') {
      setCommandPanel({ kind: 'terminal', command, text: '/' + command.name,
        canOpen: Boolean(activeChat && !activeChat.deviceId && !managedBackend) }); return
    }
    if (command.execution === 'client') { void runClientCommand(command); return }
    if (command.execution !== 'setting') {
      setCommandPanel(null); draftStore.set({ ...draftStore.getSnapshot(), prompt: '/' + command.name + ' ', inboxReferences: [], fileReferences: [] })
      requestAnimationFrame(() => promptRef.current?.focus()); return
    }
    if (activeTurn || busy) { setNotice('Wait for the response before changing session settings.'); return }
    if (!activeChat && catalogDraft) {
      setSettingPicker(command.configId ?? null)
      draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [], fileReferences: [] })
      return
    }
    if (!activeChat) {
      const chat = await prepareCommands()
      if (!chat || !isCurrentComposer()) return
      const confirmed = chat.availableCommands?.find(row => row.name === command.name && row.execution === 'setting')
      if (!confirmed || !chat.sessionConfig?.some(row => row.id === confirmed.configId)) {
        setNotice('This setting is not advertised by the current provider session.'); return
      }
      command = confirmed
    }
    draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [], fileReferences: [] })
    setSettingPicker(command.configId ?? null)
  }

  async function runClientCommand(command: ChatCommand) {
    const action = command.action
    const chat = activeChat
    if (action === 'connect') { if (catalogDraft) discovery.refresh(); else if (activeChat) await w.chats.commands(activeChat.id); else await prepareCommands(); return }
    const draft = draftStore.getSnapshot()
    draftStore.set({ ...draft, prompt: '', inboxReferences: [], fileReferences: [] })
    if (action === 'help') setCommandPanel({ kind: 'help', commands: availableCommands })
    else if (action === 'history' || action === 'children') setCommandPanel({ kind: 'history', title: action === 'children' ? 'Child conversations' : 'Choose a conversation',
      chats: w.chats.chats.filter(row => action !== 'children' || Boolean(chat && (row.parentChatId ?? row.originChatId) === chat.id)) })
    else if (action === 'new') {
      if (isRemoteChat) { setCommandPanel(null); setRemoteChatOpen(true); return }
      const next = w.chatComposers.newDraft(chat?.project || draftProject, configuration)
      currentComposer.current = next; setDraftComposer(next); setActivePreview(null); setCommandPanel(null)
      navigate(surface === 'home' ? 'home' : 'chat'); requestAnimationFrame(() => promptRef.current?.focus())
    } else if (action === 'leave') { setCommandPanel(null); newConversation() }
    else if (action === 'file') {
      setCommandPanel(null); draftStore.set({ ...draftStore.getSnapshot(), prompt: '@file:' })
      requestAnimationFrame(() => promptRef.current?.focus())
    } else if (action === 'copy') {
      const item = [...(chat?.items ?? [])].reverse().find(item => item.type === 'agentMessage' && item.status !== 'inProgress' &&
        (!chat || !['running', 'waiting'].includes(chat.status) || item.turnId && item.turnId !== chat.turnId))
      if (!item) { setNotice('There is no completed assistant response in the loaded transcript.'); return }
      try { await navigator.clipboard.writeText(item.text); setNotice('Assistant response copied.') }
      catch { setNotice('Clipboard access failed. Use the response’s Copy button.'); }
    } else {
      const text = action === 'warnings' ? chat?.error || 'No retained conversation warnings.' :
        chat?.items.map(item => `${item.type}\n${item.text}`).join('\n\n') || 'No saved transcript yet.'
      setCommandPanel({ kind: 'text', title: action === 'warnings' ? 'Conversation warnings' : 'Loaded transcript', output: {
        key: requestId(), command: command.name, text } })
    }
  }

  async function submitCommand(prompt: string) {
    // Command preparation owns its own request state and never starts inference.
    let chat = activeChat
    let attempt = pendingAttempt?.op === 'chat-config-set' || pendingAttempt?.op === 'chat-command' ? pendingAttempt : null
    if (!attempt) {
      if (draftCommands) {
        const parsed = commandInput(prompt, draftCommands)
        if (prompt === '/' || !parsed && draftCommands.some(command => ('/' + command.name).startsWith(prompt))) return
        if (parsed && ['client', 'unsupported'].includes(parsed.command.execution)) {
          if (parsed.arguments && parsed.command.execution === 'client') setNotice('Choose this command from the menu without arguments.')
          else await chooseCommand(parsed.command)
          return
        }
        if (catalogDraft && parsed) {
          if (parsed.command.execution === 'setting') {
            const option = configurableSettings?.find(row => row.id === parsed.command.configId)
            if (!option) { setNotice(discovery.loading ? 'Discovering settings…' : 'Refresh discovery to load this setting.'); return }
            if (!parsed.arguments && !['plan', 'fast'].includes(parsed.command.name)) { await chooseCommand(parsed.command); return }
            try {
              const value = settingValue(parsed.command, parsed.arguments, option)
              if (value !== null) {
                await changeSessionConfig(option.id, value)
                draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [], fileReferences: [] })
              } else setNotice(`${option.name}: ${String(option.currentValue)}`)
            } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Choose a setting.') }
            return
          }
          setNotice('Start a conversation before using this command.'); return
        }
        if (catalogDraft) { setNotice(discovery.loading ? 'Discovering provider commands…' : 'This command is not advertised by the selected backend.'); return }
      }
      chat = await prepareCommands()
      if (!chat) return
      const parsed = commandInput(prompt, chat.availableCommands ?? [])
      if (prompt === '/' || !parsed && chat.availableCommands?.some(command => ('/' + command.name).startsWith(prompt))) {
        setNotice(''); requestAnimationFrame(() => promptRef.current?.focus()); return
      }
      if (!parsed) {
        if (chat.provider === 'codex' && !chat.deviceId && chat.backendRoute !== 'managed') setCommandPanel({ kind: 'terminal',
          command: { name: prompt.slice(1).split(/\s/)[0], description: 'Provider command', execution: 'terminal',
            reason: 'This command is not exposed by the session API. The Codex terminal can resolve custom and terminal commands.' }, text: prompt, canOpen: true })
        else setNotice('This command is not advertised by the current provider session.')
        return
      }
      if (['client', 'terminal', 'unsupported'].includes(parsed.command.execution)) {
        if (parsed.command.execution === 'unsupported') chooseCommand(parsed.command)
        else if (parsed.command.execution === 'terminal') setCommandPanel({ kind: 'terminal', command: parsed.command,
          text: prompt, canOpen: Boolean(activeChat && !activeChat.deviceId && !managedBackend) })
        else if (parsed.arguments) setNotice('Choose this command from the menu without arguments.')
        else chooseCommand(parsed.command)
        return
      }
      if (parsed.command.name === 'rename' && !parsed.arguments) { setCommandPanel({ kind: 'input', command: parsed.command, label: 'Conversation name' }); return }
      if (['uncertain', 'offline'].includes(chat.status) || ['running', 'waiting'].includes(chat.status) &&
        (parsed.command.requiresIdle !== false || parsed.command.name === 'skills' && parsed.arguments)) { setNotice('Wait for the response before running a command.'); return }
      if (parsed.command.execution === 'setting') {
        const option = chat.sessionConfig?.find(row => row.id === parsed.command.configId)
        if (!option) { setNotice('This setting is no longer available. Reopen the conversation.'); return }
        if (!parsed.arguments && !['fast', 'plan'].includes(parsed.command.name)) { chooseCommand(parsed.command); return }
        try {
          const value = settingValue(parsed.command, parsed.arguments, option)
          if (value === null) { setNotice(`${option.name}: ${String(option.currentValue)}`); return }
          attempt = { op: 'chat-config-set', args: { key: requestId(), chatId: chat.id, configId: option.id, value } }
          if (parsed.command.name === 'plan' && parsed.arguments && !['on', 'off', 'plan', 'default', 'status'].includes(parsed.arguments)) {
            const draft = draftStore.getSnapshot()
            const text = await resolvePromptReferences(parsed.arguments, draft.inboxReferences, draft.fileReferences, filesProject?.id, w.carrier.request, w.agents.request)
            attempt.after = { op: 'chat-send', args: { key: requestId(), chatId: chat.id, text } }
          }
        } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Choose a session setting.'); return }
      } else {
        let arguments_ = parsed.arguments
        if (parsed.command.execution === 'prompt' || ['review', 'skills'].includes(parsed.command.name)) {
          try {
            const draft = draftStore.getSnapshot()
            arguments_ = await resolvePromptReferences(parsed.arguments, draft.inboxReferences, draft.fileReferences, filesProject?.id, w.carrier.request, w.agents.request)
            if (arguments_.length > 24000) throw new Error('Command arguments and references exceed 24,000 characters. Remove a reference or shorten the command.')
          } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Could not resolve command references.'); return }
        }
        attempt = { op: 'chat-command', args: { key: requestId(), chatId: chat.id, command: parsed.command.name, arguments: arguments_ } }
      }
    }
    await applyCommandAttempt(attempt)
  }

  async function applyCommandAttempt(attempt: ChatAttempt, focusComposer = true) {
    if (!composer.begin('sending')) return
    setPendingAttempt(attempt)
    if (attempt.op === 'chat-command') expectedCommandOutput.current = { chatId: String(attempt.args.chatId), key: String(attempt.args.key), composer }
    try {
      let snapshot = await (attempt.op === 'chat-config-set' ? w.chats.configure : w.chats.command)(attempt.args)
      if (attempt.after) {
        attempt = attempt.after; setPendingAttempt(attempt)
        snapshot = await w.chats.send(attempt.args)
      }
      setPendingAttempt(null)
      if (!attempt.preserveDraft) draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [], fileReferences: [] })
      if (isCurrentComposer()) {
        setNotice(attempt.op === 'chat-config-set' ? 'Session settings updated.' : 'Command submitted.')
        if (focusComposer) promptRef.current?.focus()
        if (surface === 'home' && (attempt.op === 'chat-send' || attempt.op === 'chat-command' && ['running', 'waiting'].includes(snapshot.status))) {
          w.chatComposers.attach(snapshot.id, composer)
          navigate(`chat/${snapshot.id}`)
        }
        const output = snapshot.commandOutput
        if (output && output.key === attempt.args.key) {
          expectedCommandOutput.current = null
          setCommandPanel({ kind: 'text', title: '/' + output.command, output })
        }
      }
    } catch (cause) {
      if (cause instanceof AgentError && !cause.uncertain && ['manager', 'validation', 'unsupported', 'busy'].includes(cause.code ?? '')) {
        setPendingAttempt(null)
        if (expectedCommandOutput.current?.key === attempt.args.key) expectedCommandOutput.current = null
      }
      setNotice(cause instanceof Error ? cause.message : 'Command outcome is unconfirmed. Retry keeps the same operation.')
    } finally { setBusy(false) }
  }

  useEffect(() => {
    const expected = expectedCommandOutput.current
    const output = activeChat?.commandOutput
    if (expected && output && expected.composer === composer && expected.chatId === activeChat?.id && expected.key === output.key) {
      expectedCommandOutput.current = null
      setCommandPanel({ kind: 'text', title: '/' + output.command, output })
    }
  }, [activeChat?.id, activeChat?.commandOutput, composer])

  function selectProjectOption(value: string) {
    if (value === '@new') { setNewProjectOpen(true); return }
    if (value === '@discover') { setDiscoveryJobId(null); setDiscoveryOpen(true); return }
    selectProject(value ? w.projects.projects.find((project) => project.id === value)?.name ?? draftProject : '')
  }

  function newConversation() {
    const next = w.chatComposers.newDraft()
    currentComposer.current = next
    setDraftComposer(next)
    setActivePreview(null)
    setHistoryOpen(false)
    navigate(surface === 'home' ? 'home' : 'chat')
    promptRef.current?.focus()
  }

  function startWithBackend(backend: string) {
    const draft = draftStore.getSnapshot()
    const next = w.chatComposers.newDraft(draft.project, { ...configuration, profileId: profile!.id, backendChoice: backend, settings: {} })
    next.draft.set({ ...draft, prompt: draft.prompt || pendingAttempt?.frozenPrompt || '' })
    currentComposer.current = next
    setDraftComposer(next)
    setActivePreview(null)
    setHistoryOpen(false)
    setComposerOptionsOpen(false)
    navigate(surface === 'home' ? 'home' : 'chat')
    promptRef.current?.focus()
  }

  function selectProject(project: string) {
    if (project === draftProject) return
    if (activePreview || busy || pendingAttempt) {
      const draft = draftStore.getSnapshot()
      const next = startProject(project)
      if (!busy && !pendingAttempt) next.draft.set({ ...draft, project })
      return
    }
    draftStore.set({ ...draftStore.getSnapshot(), project })
    navigate(surface === 'home' ? 'home' : 'chat')
  }

  function startProject(project: string) {
    const profileId = profile?.id ?? agent
    const next = w.chatComposers.newDraft(project, { ...configuration, profileId, backendChoice: effectiveBackend,
      modelChoice: { profileId, value: model }, settings: Object.fromEntries((configurableSettings ?? [])
        .filter(option => option.id !== 'model').map(option => [option.id, option.currentValue])) })
    currentComposer.current = next
    setDraftComposer(next)
    setActivePreview(null)
    setHistoryOpen(false)
    navigate(surface === 'home' ? 'home' : 'chat')
    promptRef.current?.focus()
    return next
  }

  function revealHistoryItem(id: string) {
    const available = new Map(history.map((item) => [item.id, item]))
    const ancestors = new Set<string>([id])
    let parentId = available.get(id)?.parentId
    while (parentId && !ancestors.has(parentId)) {
      ancestors.add(parentId)
      parentId = available.get(parentId)?.parentId
    }
    ancestors.delete(id)
    if (ancestors.size) setExpandedParents((previous) => [...new Set([...previous, ...ancestors])])
  }

  function openPreview(preview: Preview) {
    showPreview(preview)
    revealHistoryItem(preview.id)
    rememberHistoryItem(preview.id)
    const run = w.carrier.runs.find((item) => item.key === preview.id)
    const matchingAgent = w.chatProfiles.find((p) => p.name === preview.agent && (!run || p.provider === run.provider))
    if (matchingAgent) w.chatComposers.forConversation(preview.id, preview.project).configure({ profileId: matchingAgent.id })
    setHistoryOpen(false)
    navigate(preview.chat ? `chat/${preview.id}` : 'chat')
  }

  async function deletePreview(choice?: ChatDeletionChoice) {
    if (!deletingPreview) return
    const item = deletingPreview
    const ids = new Set(item.chat ? await w.chats.remove(item.id, choice) : [item.id])
    if (!item.chat && w.carrier.runs.some((run) => run.key === item.id)) await w.carrier.removeRun(item.id)
    setChatPreviews((previous) => previous.filter((preview) => !ids.has(preview.id)))
    w.setTasks((previous) => previous.filter((task) => !ids.has(task.id)))
    setExpandedParents((previous) => previous.filter((id) => !ids.has(id)))
    setRecentAddedAt((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !ids.has(id))))
    if ([...ids].some(id => currentComposer.current === w.chatComposers.forConversation(id))) newConversation()
    setDeletingPreview(null)
  }

  useEffect(() => {
    if (activePreview?.chat && w.chats.deletedIds.has(activePreview.id)) newConversation()
  }, [w.chats.deletedIds, activePreview?.id, busy])

  async function chatAction(operation: () => Promise<void>) {
    if (!composer.begin('actionBusy')) return
    try { await operation() }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Chat operation failed.') }
    finally { composer.update({ actionBusy: false }) }
  }

  async function terminalAction(release = false) {
    if (!activeChat) return
    await chatAction(async () => {
      const operation = `${activeChat.id}:${release ? 'release' : 'open'}`
      const key = terminalAttempts.current.get(operation) ?? requestId()
      terminalAttempts.current.set(operation, key)
      const args = { key, chatId: activeChat.id }
      const snapshot = await (release ? w.chats.releaseTerminal(args) : w.chats.openTerminal(args))
      terminalAttempts.current.delete(operation)
      if (isCurrentComposer() && !release && snapshot.terminal?.status === 'running' && snapshot.terminal.sessionId)
        navigate(`terminals/${encodeURIComponent(snapshot.terminal.sessionId)}`)
      else if (snapshot.terminal?.error) setNotice(snapshot.terminal.error)
      else if (!release && snapshot.terminal?.status === 'queued') setNotice('The terminal will be available after this turn finishes.')
    })
  }

  function renderHistory() {
    return <div className="command-history">
      <div className="chat-sidebar-header"><span className="chat-sidebar-title">Chats</span></div>
      <div className="chat-sidebar-actions">
        <Button variant="ghost" className="chat-new-conversation" aria-label="New chat" onPress={newConversation}><Icon name="pencil" />New chat</Button>
        <CommandPalette title="Search history" searchLabel="Search history" className="command-history-search"
          placeholder="Search all conversations…" query={historyQuery} onQueryChange={setHistoryQuery}
          onOpenChange={(open) => { if (open) setHistoryQuery('') }}
          trigger={<Button variant="ghost" className="chat-search-conversations" aria-label="Search history"><Icon name="search" />Search chats</Button>}
          items={history.map((item) => ({ id: item.id, label: item.prompt.split('\n')[0],
            description: item.project || undefined, group: item.project || 'Chats',
            keywords: [item.prompt, item.agent, item.project ?? '', labelText(item.labels)],
          }))}
          onAction={(id) => { const item = history.find((preview) => preview.id === id); if (item) openPreview(item) }} />
      </div>
      <ChatHistory selectedProject={historyProject} recent={recentHistory} projectHistory={projectHistory}
        history={history} activeId={activePreview?.id} expandedParents={expandedParents}
        supervisingOnly={supervisionFilter} onSupervisingOnlyChange={setSupervisionFilter}
        canCreateProject={w.agents.status === 'connected'} onNewProject={() => setNewProjectOpen(true)}
        onToggleParent={(id) => setExpandedParents((previous) => previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id])}
        onProjectChange={setHistoryProject} onStartProject={startProject} onSelect={openPreview}
        onDelete={(item) => {
          const state = w.chatComposers.forConversation(item.id).getSnapshot()
          if (!state.sending && !state.actionBusy) setDeletingPreview(item)
        }} />
    </div>
  }

  const conversationTitle = activeChat?.title ?? registeredChat?.title ?? activePreview?.prompt.split('\n')[0] ?? ''
  const titleCharacters = Array.from(conversationTitle)
  const shortTitle = titleCharacters.length > 64 ? `${titleCharacters.slice(0, 63).join('')}…` : conversationTitle
  const refreshMentionChats = () => {
    if (w.agents.status === 'connected') void w.chats.refresh().catch(() => {})
  }
  const mentionGroups: ComposerMentionGroup[] = []
  if (!voice.engaged) {
    if (!isRemoteChat) mentionGroups.push({
      id: 'project', label: 'Project', description: 'Choose the project for your chat', icon: 'layers',
      options: projectOptions, onSelect: selectProjectOption,
    })
    if (!modelLocked) {
      mentionGroups.push({
        id: 'profile', aliases: ['agent'], label: 'Profile', description: 'Choose an agent profile', icon: 'sparkles',
        options: w.chatProfiles.map(p => ({ id: p.id, label: p.label ?? p.name, description: p.reason ?? p.role })), onSelect: selectAgent,
      })
    }
    if (w.agents.status === 'connected' && !busy && !pendingAttempt && !activeChat?.syncing && (sessionModel ? !activeTurn : !modelLocked && managedProfile && (!backendOption || backendOption.controls.model))) mentionGroups.push({
      id: 'model', label: 'Model', description: 'Choose the model for your chat', icon: 'scan',
      options: modelOptions, onOpen: catalogDraft ? discovery.check : undefined, loading: modelCatalog.loading && modelOptions.length <= 1, error: modelCatalog.error, onRetry: modelCatalog.refresh,
      onSelect: value => sessionModel ? void changeSessionConfig(sessionModel.id, value) : setModelChoice({ profileId: agent, value }),
    })
    mentionGroups.push(...mentionResources.groups, {
      id: 'chat', label: 'Chat', description: 'Link a saved chat in your message', icon: 'messages-square',
      onOpen: refreshMentionChats, onRetry: refreshMentionChats, loading: w.chats.listLoading, error: w.chats.listError,
      options: w.chats.chats.filter(chat => !executionOwners.has(chat.id)).map(chat => ({ id: chat.id, label: chat.title,
        description: [chat.project, chat.profile, chat.id.slice(0, 8)].filter(Boolean).join(' · ') })),
      insertText: async (id, followingText) => {
        const chat = w.chats.chats.find(chat => chat.id === id)
        return chat ? chatMentionLink(chat.title, chat.id) + (/^\s/.test(followingText) ? '' : ' ') : null
      },
      onNavigate: id => { const item = previews.find(item => item.id === id); if (item) openPreview(item) },
    }, {
      id: 'workflow', separator: '/', label: 'Workflow', description: 'Open a saved workflow', icon: 'layers',
      options: workflows.map(item => ({ id: item.id, label: item.draft.name, description: 'Open in the workflow builder' })),
      onSelect: id => navigate(`workflows/${encodeURIComponent(id)}`),
    })
  }

  const speedSetting = findModelSetting(configurableSettings, availableCommands, 'speed')
  const effortSetting = findModelSetting(configurableSettings, availableCommands, 'effort')
  const fastEnabled = speedSetting?.currentValue === true || ['fast', 'priority'].includes(String(speedSetting?.currentValue).toLowerCase())
  const effortValue = typeof effortSetting?.currentValue === 'string' && !['', 'auto', 'default'].includes(effortSetting.currentValue.toLowerCase()) ?
    configOptions(effortSetting).find(option => option.value === effortSetting.currentValue)?.name ?? effortSetting.currentValue : ''
  const modelSummary = `${fastEnabled ? '/fast' : ''}${effortValue ? ` · ${effortValue}` : ''}`
  const remainingSettings = configurableSettings?.filter(option => option !== sessionModel && option !== sessionMode && ['select', 'boolean'].includes(option.type)) ?? []
  const modelSettings = remainingSettings.filter(option => option === speedSetting || option === effortSetting || option.category === 'model_config')
  const accessSettings = remainingSettings.filter(option => !modelSettings.includes(option) && /permission|approval|access|policy/i.test(`${option.category ?? ''} ${option.id}`))
  const advancedSettings = remainingSettings.filter(option => !modelSettings.includes(option) && !accessSettings.includes(option))
  const policyChat = activeChat ?? registeredChat
  const settingsDisabled = busy || voice.engaged || Boolean(pendingAttempt) || Boolean(activeChat?.syncing) || activeTurn || w.agents.status !== 'connected'

  if (!settingsDisabled && !['offline', 'uncertain'].includes(activeChat?.status ?? '')) {
    const settingGroups = modelSettingMentions({ settings: [...modelSettings, ...(sessionMode ? [sessionMode] : [])],
      speed: speedSetting, effort: effortSetting, mode: sessionMode,
      onSelect: (configId, value) => { void changeSessionConfig(configId, value) },
    })
    mentionGroups.push(...settingGroups)
    if (usesAppServer && (!activeChat?.commandsState || ['error', 'loading'].includes(activeChat.commandsState))) {
      for (const shortcut of modelSettingShortcuts.filter(item => !settingGroups.some(group => group.id === item.id))) {
        const discover = () => { if (catalogDraft) { discovery.check(); return }; void prepareCommands().then(snapshot => {
          if (!snapshot || !isCurrentComposer() || snapshot.commandsState === 'loading') return
          if (!findModelSetting(snapshot.sessionConfig, snapshot.availableCommands, shortcut.id))
            setNotice(`This session does not advertise ${shortcut.label.toLowerCase()} options.`)
        }) }
        mentionGroups.push({ ...shortcut, options: [], browseOnly: true,
          loading: catalogDraft ? discovery.loading : commandsLoading || activeChat?.commandsState === 'loading', error: catalogDraft ? discovery.error : commandsError || activeChat?.commandsError,
          onOpen: commandsError || activeChat?.commandsError ? undefined : discover, onRetry: discover,
        })
      }
    }
  }

  function sessionSetting(option: SessionConfig, keepModelOpen = false) {
    const change = (value: string | boolean) => {
      if (!keepModelOpen) setComposerOptionsOpen(false)
      void changeSessionConfig(option.id, value, !keepModelOpen)
    }
    return option.type === 'boolean' ?
      <Button key={option.id} variant="ghost" size="sm" disabled={settingsDisabled}
        aria-pressed={Boolean(option.currentValue)} onPress={() => change(!option.currentValue)}>{option.name}: {option.defaultUnknown ? 'Provider default' : option.currentValue ? 'On' : 'Off'}</Button> :
      <ComposerPicker key={option.id} label={option.name} value={String(option.currentValue)} showValue
        displayValue={option.defaultUnknown ? 'Provider default' : undefined}
        options={configOptions(option).map(row => ({ id: row.value, label: row.name }))}
        onChange={change} disabled={settingsDisabled} />
  }

  const modelDisabled = busy || voice.engaged || Boolean(pendingAttempt) || Boolean(activeChat?.syncing) ||
    (sessionModel ? activeTurn : modelLocked || Boolean(backendOption && !backendOption.controls.model)) || w.agents.status !== 'connected'
  const modelPicker = (managedProfile || modelLocked) && (backendOption?.modelInput === 'text' && !modelLocked && !sessionModel ?
    <TextField className="command-context-picker command-context-picker--model command-model-input" label="Model" hideLabel
      variant={fieldVariant} value={model} placeholder="Provider default" disabled={modelDisabled}
      onChange={event => setModelChoice({ profileId: agent, value: event.target.value })} /> : <ChatModelPicker
    value={model}
    displayValue={!model && defaultModel ? defaultModel : undefined}
    summary={modelSummary}
    notice={notice}
    disabled={modelDisabled && (settingsDisabled || (!modelSettings.length && !sessionMode))}
    modelDisabled={modelDisabled}
    open={modelOptionsOpen}
    onOpenChange={open => { setModelOptionsOpen(open); if (open && catalogDraft) discovery.check() }}
    onChange={value => sessionModel ? void changeSessionConfig(sessionModel.id, value, false) : setModelChoice({ profileId: agent, value })}
    options={modelOptions}
  >
    {catalogDraft && <div className="command-model-discovery" role="group" aria-label="Model discovery">
      {modelCatalog.loading ? <p role="status">Loading models…</p> : modelCatalog.error && <p role="status">Model list unavailable.</p>}
      <Button variant="ghost" size="sm" onPress={modelCatalog.refresh} disabled={modelCatalog.loading || w.agents.status !== 'connected'}>Refresh models</Button>
    </div>}
    {catalogDraft && backendOption?.controls.model !== false && <TextField label="Custom model" variant={fieldVariant} value={model} placeholder="Provider default" disabled={modelDisabled}
      onChange={event => setModelChoice({ profileId: agent, value: event.target.value })} />}
    {(modelSettings.length > 0 || sessionMode) && <div className="command-model-settings-controls">
      {modelSettings.map(option => sessionSetting(option, true))}
      {sessionMode && sessionSetting(sessionMode, true)}
    </div>}
  </ChatModelPicker>)

  const composerDialogs = <>
    {mentionResources.dialog}
      <CommandDialog key={commandPanel?.kind === 'input' ? commandPanel.command.name : commandPanel?.kind ?? 'closed'} panel={commandPanel}
        onClose={() => { setCommandPanel(null); requestAnimationFrame(() => promptRef.current?.focus()) }} onCommand={command => { setCommandPanel(null); chooseCommand(command) }}
        onChat={id => { setCommandPanel(null); navigate(`chat/${id}`) }}
        onTerminal={() => { setCommandPanel(null); void terminalAction() }}
        onInsert={text => { setCommandPanel(null); draftStore.set({ ...draftStore.getSnapshot(), prompt: text }); requestAnimationFrame(() => promptRef.current?.focus()) }}
        onArguments={(command, value) => { setCommandPanel(null); void submitCommand('/' + command.name + ' ' + value) }} />
      <Dialog trigger={<Button style={{ display: 'none' }}>Session setting</Button>} title={`Choose ${configurableSettings?.find(row => row.id === settingPicker)?.name ?? 'setting'}`} open={Boolean(settingPicker)} onOpenChange={open => { if (!open) { setSettingPicker(null); requestAnimationFrame(() => promptRef.current?.focus()) } }}>
        {(() => {
          const option = configurableSettings?.find(row => row.id === settingPicker)
          if (!option) return <p role="status">{catalogDraft && discovery.loading ? 'Discovering settings…' : 'This setting is not advertised. Refresh discovery.'}</p>
          const choices = option.type === 'boolean' ? [{ value: 'true', name: 'On' }, { value: 'false', name: 'Off' }] : configOptions(option)
          return <div role="group" aria-label={`${option.name} choices`}>{choices.map(row => <Button key={row.value} variant="ghost"
            disabled={busy || activeTurn} onPress={() => { setSettingPicker(null); void changeSessionConfig(option.id, option.type === 'boolean' ? row.value === 'true' : row.value) }}>{row.name}</Button>)}</div>
        })()}
      </Dialog>
      <NewProject open={newProjectOpen} onOpenChange={setNewProjectOpen} disabled={w.agents.status !== 'connected'}
        onDiscover={() => { setNewProjectOpen(false); setDiscoveryJobId(null); setDiscoveryOpen(true) }}
        create={w.projects.create} onCreated={(project) => {
          selectProject(project.name)
          setHistoryProject(project.name)
        }} />
      <RemoteChatDialog open={remoteChatOpen} onOpenChange={setRemoteChatOpen} agents={w.agents} create={w.chats.create}
        onCreated={(chat) => {
          openPreview({ id: chat.id, mode: 'work', prompt: chat.title, agent: chat.profile, project: chat.project, chat: true })
        }} />
      <DiscoverProjects open={discoveryOpen} onOpenChange={setDiscoveryOpen} jobId={discoveryJobId} onSelectJob={setDiscoveryJobId}
        projects={w.projects} connected={w.agents.status === 'connected'} />
  </>

  const composerContent = (
        <div className="command-compose-area">
          {activeChat && w.agents.status === 'connected' && activeChat.status === 'uncertain' && !needsChatRecovery && !pendingAttempt &&
            <Button variant="ghost" disabled={busy} onPress={() => { void chatAction(async () => { await w.chats.open(activeChat.id) }) }}>Inspect conversation</Button>}
          {activeChat?.backendCapabilities?.operations.restore_session?.supported && activeChat.status === 'uncertain' && !needsChatRecovery && w.agents.status === 'connected' &&
            <Button variant="secondary" disabled={busy} onPress={() => { void chatAction(async () => {
              await w.agents.request('chat-backend-resume', { chatId: activeChat.id, key: requestId() })
              await w.chats.open(activeChat.id)
            }) }}>Resume saved session</Button>}
          {activeChat && pendingAttempt && w.agents.status === 'connected' && <div className="command-answer-options">
            <Button variant="ghost" disabled={busy} onPress={() => { void chatAction(async () => { await w.chats.open(activeChat.id) }) }}>Inspect outcome</Button>
            {pendingAttempt.op === 'chat-config-set' && !['running', 'waiting', 'uncertain', 'offline'].includes(activeChat.status) &&
              activeChat.sessionConfig?.some(option => option.id === pendingAttempt.args.configId && option.currentValue === pendingAttempt.args.value) &&
              <Button variant="ghost" disabled={busy} onPress={() => {
                if (!pendingAttempt.preserveDraft) draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [], fileReferences: [] })
                setPendingAttempt(null); setNotice('Continue with the confirmed session settings.')
              }}>Continue with confirmed settings</Button>}
            {activeChat.turnId && ['completed', 'failed', 'interrupted'].includes(activeChat.status) &&
              <Button variant="ghost" disabled={busy} onPress={() => {
                setPendingAttempt(null)
                draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [] })
                setNotice('Continue with the messages shown in this conversation.')
              }}>Continue conversation</Button>}
          </div>}
          {managedProfile && !usesAppServer && <CarrierConnectionPanel carrier={w.carrier} />}
          {surface === 'chat' && !activePreview && <EmptyChatDraft draft={draftStore}>
            <div className="command-suggestions" role="group" aria-label={mode === 'chat' ? 'Chat suggestions' : 'Work suggestions'}>
              {suggestions[mode].map((suggestion) => (
                <Button key={suggestion.label} variant="ghost" size="sm" onPress={() => {
                  draftStore.set({ ...draftStore.getSnapshot(), prompt: suggestion.prompt, inboxReferences: [] })
                  promptRef.current?.focus()
                }}><Icon name={suggestion.icon} />{suggestion.label}</Button>
              ))}
            </div>
          </EmptyChatDraft>}
          <p role="status" className="command-notice">{notice}</p>
          <VoicePanel voice={voice} />
          {failedCreation && creationAlternatives.length > 0 && <div className="command-answer-options" role="group" aria-label="Choose another chat backend">
            <p>This chat could not start. Continue in a new chat using an available backend.</p>
            {creationAlternatives.map(backend => <Button key={backend.id} variant="secondary" disabled={busy || voice.engaged}
              onPress={() => startWithBackend(backend.id)}>Start new chat with {backend.label}</Button>)}
          </div>}
          {activeChat && <QueuedMessages key={activeChat.id} queue={activeChat.queue} chatId={activeChat.id}
            disabled={busy || Boolean(activeChat.syncing) || Boolean(pendingAttempt) || w.agents.status !== 'connected' || voice.engaged}
            onEdit={w.chats.editQueued} onRemove={w.chats.removeQueued} onResume={w.chats.resumeQueue} />}
          {pendingMessages.length > 0 && <section aria-label="Pending messages">
            {messagesPaused && <p role="status">Pending messages paused after Stop.</p>}
            {pendingMessages.map(message => <div key={message.id}>
              <p>{message.text}</p>
              <p role={message.error ? 'alert' : 'status'}>{message.error ?? (message.status === 'sending' ? 'Sending…' : 'Waiting to send…')}</p>
              {message.status === 'failed' && <Button variant="ghost" size="sm" disabled={actionBusy || w.agents.status !== 'connected'}
                onPress={() => composer.retryMessage(message.id, deliverMessage)}>Retry request</Button>}
              {message.status === 'failed' && message.uncertain && activeChat && <Button variant="ghost" size="sm" disabled={actionBusy || w.agents.status !== 'connected'}
                onPress={() => { void chatAction(async () => { await w.chats.open(activeChat.id) }) }}>Inspect outcome</Button>}
              {message.status !== 'sending' && <Button variant="ghost" size="sm" onPress={() => composer.removeMessage(message.id)}>{message.uncertain ? 'Dismiss pending receipt' : 'Remove pending message'}</Button>}
              {message.status === 'failed' && !message.uncertain && <Button variant="ghost" size="sm" disabled={!draftEmpty} onPress={() => {
                if (!draftStore.isEmpty()) return
                draftStore.set(message.draft ?? { prompt: message.text, project: draftProject }); composer.removeMessage(message.id)
              }}>Edit message</Button>}
            </div>)}
            {messagesPaused && <Button variant="ghost" size="sm" disabled={actionBusy || w.agents.status !== 'connected'} onPress={() => composer.resumeMessages(deliverMessage)}>Resume pending messages</Button>}
          </section>}
          {(draftProject || sessionMode?.currentValue === 'plan' || followupOptions) && <div className="command-composer-context" aria-label="Conversation context">
            {draftProject && <span title={draftProject}>{draftProject}</span>}
            {sessionMode?.currentValue === 'plan' && <span>Plan</span>}
            {followupOptions && <span>{effectiveFollowupMode === 'queue' ? 'Send after this turn' : activeTurn ? 'Add to current turn' : 'Send now'}</span>}
          </div>}
          <ChatComposer
            draft={draftStore}
            inputRef={promptRef}
            placeholder={executionMonitor ? 'Give the supervisor a direction…' : mode === 'chat' ? 'Ask anything…' : 'Describe the work…'}
            request={w.carrier.request}
            connection={w.carrier.status}
            context={!voice.engaged ? { agents: w.agents, project: filesProject, mailboxes: w.carrier.mailboxes, scope: `${composerScope}:${agent}:${effectiveBackend}:${filesProject?.id ?? ''}`,
              commands: availableCommands, commandsState: commandsLoading ? 'loading' : !usesAppServer ? 'unsupported' : activeChat?.commandsState ?? (draftCommands ? 'ready' : undefined),
              commandsError: catalogDraft ? discovery.error : commandsError || activeChat?.commandsError, onCommandsOpen: () => { void prepareCommands() }, onChooseCommand: chooseCommand } : undefined}
            mentionGroups={mentionGroups}
            readOnly={busy || Boolean(pendingAttempt)}
            canSubmit={canSubmit}
            canRunCommand={Boolean(activeChat && usesAppServer && !busy && !activeChat.syncing && !voice.engaged && w.agents.status === 'connected')}
            retrying={Boolean(pendingAttempt)}
            sendLabel={sendLabel}
            onSubmit={() => { void submit() }}
            options={<>
                {!retainedChat && readiness?.ready === false && <p role="status">{readiness.reason || 'This profile needs setup before starting a chat.'}</p>}
                {followupOptions && <select aria-label="Message timing" className="command-followup-mode" value={effectiveFollowupMode}
                  disabled={actionBusy || voice.engaged} onChange={event => setFollowupMode(event.target.value as 'steer' | 'queue')}>
                  {steerAvailable && <option value="steer">Add to current turn</option>}
                  <option value="queue">Send after this turn</option>
                </select>}
                <Dialog title="Chat settings" className="chat-composer-settings-dialog" open={composerOptionsOpen} onOpenChange={setComposerOptionsOpen}
                  trigger={<Button variant="ghost" size="sm" iconOnly className="command-context-button command-settings-button" aria-label="Chat settings"><Icon name="settings" /></Button>}>
                  <div className="chat-composer-settings">
                    <section className="chat-settings-section" aria-labelledby="chat-settings-conversation">
                      <h3 id="chat-settings-conversation">Conversation</h3>
                      <ComposerPicker label="Project" value={selectedProject?.id ?? (draftProject ? '@legacy' : '')} showValue
                        disabled={busy || voice.engaged || Boolean(pendingAttempt) || Boolean(activeChat?.deviceId)}
                        onChange={value => { setComposerOptionsOpen(false); selectProjectOption(value) }} options={projectOptions} />
                      {followupOptions && <label className="chat-settings-field">Message timing
                        <select className="command-followup-mode" aria-label="Message timing" value={effectiveFollowupMode}
                          disabled={busy || Boolean(pendingAttempt) || voice.engaged || w.agents.status !== 'connected'}
                          onChange={event => { setFollowupMode(event.target.value as 'steer' | 'queue'); setComposerOptionsOpen(false) }}>
                          {steerAvailable && <option value="steer">{activeTurn ? 'Add to current turn' : 'Send now'}</option>}
                          <option value="queue">Send after this turn</option>
                        </select>
                      </label>}
                      {!activePreview && <Button variant="ghost" size="sm" disabled={busy || w.agents.status !== 'connected'} onPress={() => { setComposerOptionsOpen(false); setRemoteChatOpen(true) }}><Icon name="monitor" />Remote chat</Button>}
                    </section>
                    {(managedProfile || accessSettings.length > 0) && <section className="chat-settings-section" aria-labelledby="chat-settings-access">
                      <h3 id="chat-settings-access">Permissions &amp; policy</h3>
                      {accessSettings.map(option => sessionSetting(option))}
                      {policyChat && (policyChat.permissionMode || policyChat.accessMode || policyChat.approvalPolicy) && <dl className="chat-settings-summary">
                        {(policyChat.permissionMode || policyChat.accessMode) && <><dt>Access</dt><dd>{permissionLabel(conversationPermission(policyChat))}</dd></>}
                        {policyChat.approvalPolicy && <><dt>Approval policy</dt><dd>{policyChat.approvalPolicy === 'never' ? 'Never ask' : 'On request'}</dd></>}
                      </dl>}
                      {!modelLocked && backendOption?.controls.access && <ComposerPicker label="Backend access" showValue value={backendAccess}
                        disabled={busy || Boolean(pendingAttempt)} onChange={setBackendAccess} options={[
                          { id: 'read-only', label: 'Read only' }, { id: 'workspace-write', label: 'Workspace · approval required' },
                          { id: 'workspace-auto', label: 'Workspace · automatic' }, { id: 'full-access', label: 'Full access' },
                        ]} />}
                      {!accessSettings.length && !policyChat?.permissionMode && !policyChat?.accessMode && !policyChat?.approvalPolicy && (modelLocked || !backendOption?.controls.access) &&
                        <p className="chat-settings-note">Uses the provider’s access and approval defaults.</p>}
                    </section>}
                    {managedProfile && !activeChat?.deviceId && <section className="chat-settings-section" aria-labelledby="chat-settings-tools">
                      <h3 id="chat-settings-tools">Tools &amp; resources</h3>
                      {!modelLocked && <details><summary>Resources</summary>
                        <label><input type="checkbox" checked={suiteTools} disabled={busy || Boolean(pendingAttempt)} onChange={event => setSuiteTools(event.target.checked)} />Include Suite tools</label>
                        <p>{suiteTools ? 'Workspace, conversation, and agent tools are included automatically.' : 'Basic chat uses your selected resources without Suite tools.'}</p>
                        <ResourcePicker agents={w.agents} provider={profile!.provider as import('../agents/client').Provider} profile={profile!.name}
                          applicationPreset={suiteTools ? 'controller' : 'basic'} cwd={selectedProject?.path} backend={backendOption?.id} value={resources} onChange={setResources} onValidationChange={setResourcesValid} disabled={busy || Boolean(pendingAttempt)} />
                      </details>}
                      {modelLocked && activeChat?.resourceReport && <details><summary>Resources</summary>
                        <ResourceReportView report={activeChat.resourceReport} />
                      </details>}
                      <Dialog
                        title="MCP servers"
                        description={activeChat ? 'Check and reconnect this conversation’s MCP servers.' : 'Select the servers this conversation can use.'}
                        className="command-mcp-dialog"
                        trigger={<Button variant="ghost" size="sm" className="command-context-button" aria-label="MCP servers"
                          data-active={(activeChat ? Boolean(activeChat.mcp?.states.length) : selectedMcpServers.length > 0) || undefined}
                          disabled={busy || voice.engaged || Boolean(pendingAttempt) || Boolean(activePreview && !activeChat) || w.agents.status !== 'connected'}>
                          <Icon name="plug" />MCP servers
                          <span className="chat-settings-note">{activeChat ? `${activeChat.mcp?.states.length ?? 0} configured` : `${selectedMcpServers.length} selected`}</span>
                        </Button>}
                        footer={(close) => <Button onPress={close}>Done</Button>}
                      >
                        {activeChat ? <>
                          <McpSummary snapshot={activeChat.mcp} />
                          <McpConnections key={activeChat.id} agents={w.agents} chatId={activeChat.id}
                            disabled={busy || Boolean(pendingAttempt)} />
                        </> : <McpServerList agents={w.agents} provider={profile!.provider as 'codex' | 'opencode'}
                          value={selectedMcpServers} onChange={setMcpServers}
                          disabled={busy || Boolean(pendingAttempt) || w.agents.status !== 'connected'} />}
                      </Dialog>
                    </section>}
                    {((managedProfile && !activeChat?.deviceId) || advancedSettings.length > 0) && <section className="chat-settings-section" aria-labelledby="chat-settings-advanced">
                      <h3 id="chat-settings-advanced">Advanced</h3>
                      {advancedSettings.map(option => sessionSetting(option))}
                      {managedProfile && !activeChat?.deviceId && <ComposerPicker label="Backend" showValue
                        value={activeChat?.backendRoute === 'managed' ? activeChat.backend ?? '' : effectiveBackend}
                        disabled={busy || Boolean(pendingAttempt) || modelLocked || voice.engaged}
                        options={[...(profile?.provider === 'codex' ? [{ id: '', label: 'Native Codex · Suite tools' }] : []),
                          ...(w.agents.catalog?.backends?.filter(row => row.provider === profile?.provider).map(row => ({ id: row.id, label: row.label, disabled: !row.available, description: row.reason })) ?? [])]}
                        onChange={value => {
                          setBackendChoice(value); setModelChoice({ profileId: agent, value: '' }); setResources({}); composer.configure({ settings: {} })
                          if (value && profile?.automatic) { const explicit = w.profiles.find(row => row.provider === profile.provider); if (explicit) setAgent(explicit.id) }
                        }} />}
                      {!modelLocked && backendOption && !backendOption.available && <>
                        <span role="status">{backendOption.reason}</span>
                        <Button variant="ghost" size="sm" disabled={w.agents.loading} onPress={() => { void w.agents.refresh() }}>Refresh backends</Button>
                      </>}
                      {catalogDraft && <details className="chat-backend-details">
                        <summary>Backend details</summary>
                        <div className="command-backend-discovery" role="group" aria-label="Backend discovery">
                          <p role="status">{discovery.error || (discovery.loading ? 'Discovering models and settings…' : discovery.snapshot?.discoveredAt ?
                            `Discovered at ${new Date(discovery.snapshot.discoveredAt).toLocaleTimeString()}` : 'Discovery has not completed.')}</p>
                          <Button variant="secondary" size="sm" onPress={discovery.refresh} disabled={discovery.loading || w.agents.status !== 'connected'}>Refresh discovery</Button>
                          {discovery.snapshot?.limitations.map(text => <p key={text}>{text}</p>)}
                          {invalidDraftSettings.length > 0 && <>
                            <p role="alert">Unavailable draft settings: {invalidDraftSettings.map(row => row.id).join(', ')}.</p>
                            <Button variant="secondary" size="sm" onPress={() => composer.configure({ settings: Object.fromEntries(initialConfig
                              .filter(row => !invalidDraftSettings.some(invalid => invalid.id === row.id)).map(row => [row.id, row.value])) })}>Reset unavailable settings</Button>
                          </>}
                        </div>
                      </details>}
                    </section>}
                  </div>
                </Dialog>
                <ComposerPicker label="Provider" value={providerChoice} showValue
                  options={providerOptions} onChange={selectProvider}
                  displayValue={profile ? providerName(profile.provider) : w.agents.loading ? 'Loading providers…' : 'No providers available'}
                  disabled={busy || voice.engaged || Boolean(pendingAttempt) || modelLocked || !providerOptions.length} />
                <ComposerPicker
                  label="Profile"
                  showValue
                  value={conversationProfileId ?? agent}
                  disabled={busy || voice.engaged || Boolean(pendingAttempt) || modelLocked || !agentOptions.length}
                  displayValue={!agentOptions.length ? 'No profiles available' : undefined}
                  onChange={selectAgent}
                  options={agentOptions}
                />
                {modelPicker}

            </>}
            actions={<>
                {(usesAppServer || voice.engaged) && !activeChat?.deviceId && !managedBackend && <VoiceButton voice={voice} onStart={startVoice}
                  disabled={busy || Boolean(pendingAttempt) || w.agents.status !== 'connected' || terminalIsActive(activeChat?.terminal) ||
                    Boolean(activePreview?.chat && (!activeChat || ['offline', 'uncertain'].includes(activeChat.status)))} />}
            </>}
          />
          {activeChat?.initialConfiguration && activeChat.initialConfiguration.state !== 'ready' && <div className="command-model-status" role="group" aria-label="Review initial settings">
            <p role="alert">Confirm conversation settings before sending.</p>
            <Button variant="ghost" size="sm" disabled={settingsDisabled} onPress={() => { setComposerOptionsOpen(true); void prepareCommands() }}>Review settings</Button>
            <Button variant="ghost" size="sm" disabled={settingsDisabled} onPress={async () => {
              if (!composer.begin('actionBusy')) return
              try { await w.chats.confirmConfiguration({ key: requestId(), chatId: activeChat.id }); setNotice('Current session settings confirmed. You can send your message.') }
              catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Could not confirm settings.') }
              finally { composer.update({ actionBusy: false }) }
            }}>Use current session settings</Button>
          </div>}
          {usesAppServer && !activePreview?.chat && !profile!.automatic && (w.chats.profileStatus[profile!.name] === 'connecting' || w.chats.error) &&
            <p className="command-profile-status" role="status">{w.chats.profileStatus[profile!.name] === 'connecting' ? 'Starting your profile…' : w.chats.error}</p>}
          {invalidDraftSettings.length > 0 && <div className="command-model-status" role="group" aria-label="Draft settings unavailable">
            <p role="alert">Some draft settings are unavailable.</p>
            <Button variant="ghost" size="sm" onPress={() => setComposerOptionsOpen(true)}>Review settings</Button>
          </div>}
          {!modelLocked && backendOption && !backendOption.available && <div className="command-model-status" role="group" aria-label="Agent setup required">
            <p role="alert">Selected backend is unavailable.</p>
            <Button variant="ghost" size="sm" onPress={() => setComposerOptionsOpen(true)}>Change backend</Button>
            <Button variant="ghost" size="sm" onPress={() => navigate('agents/providers')}>Review provider setup</Button>
          </div>}
          {!modelLocked && !providerOptions.length && w.agents.catalog && !w.agents.loading && <div className="command-model-status" role="group" aria-label="Agent setup required">
            <p role="status">No providers are ready for chat.</p>
            <Button variant="ghost" size="sm" disabled={w.agents.status !== 'connected'} onPress={() => { void w.agents.refresh() }}>Refresh providers</Button>
            <Button variant="ghost" size="sm" onPress={() => navigate('agents/providers')}>Set up a provider</Button>
          </div>}
          {surface === 'chat' && <p className="command-composer-hint">Enter to send · Shift + Enter for a new line · @ to add context</p>}
        </div>
  )

  if (surface === 'home') return <div className="home-chat-composer">{composerDialogs}{composerContent}</div>

  return (
    <div className={`command-screen${activePreview ? ' command-screen--conversation' : ''}${desktopFilesOpen ? ' command-screen--files' : ''}`}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      style={{ '--project-files-width': `${filesWidth}px` } as CSSProperties}>
      {composerDialogs}
      {deletingPreview && <DeleteConversation key={deletingPreview.id} title={deletingPreview.prompt.split('\n')[0]}
        chatId={deletingPreview.chat ? deletingPreview.id : undefined} open
        loadPreview={w.chats.previewDeletion} onClose={() => setDeletingPreview(null)} onDelete={deletePreview}
        onStop={(choice, stopToken) => w.chats.stopForDeletion(deletingPreview.id, choice, stopToken)} />}
      <WorkspaceTheme><aside id="chat-sidebar" className="command-history-sidebar" aria-label="Chat history sidebar" inert={sidebarCollapsed || undefined}>
        {renderHistory()}
      </aside></WorkspaceTheme>
      <div className="command-content">
      <div className="command-toolbar">
        <div className="command-toolbar-start">
          <span className="chat-desktop-sidebar-toggle"><SidebarToggle collapsed={sidebarCollapsed} controls="chat-sidebar"
            buttonRef={sidebarToggleRef} onToggle={() => setSidebarCollapsed((value) => !value)} /></span>
          <Sheet
            title="Chat history"
            side="start"
            bodyClassName="command-history-sheet-body"
            open={historyOpen}
            onOpenChange={setHistoryOpen}
            trigger={
              <Button variant="ghost" size="sm" iconOnly className="command-mobile-history" aria-label="Show chat history">
                <Icon name="panel-left" />
              </Button>
            }
          >
            {renderHistory()}
          </Sheet>
          {activePreview ? <div className="command-conversation-heading">
            <ChatStatus activity={activityFor(activePreview)} />
            <h1 tabIndex={-1} className="command-conversation-title" title={conversationTitle} aria-label={conversationTitle}>{shortTitle}</h1>
            {supervision && <SupervisionControl workspace={w} chatId={activePreview.id} focusId={supervisionId} navigate={navigate} />}
          </div> :
            <span className="command-title">New chat</span>}
        </div>
        <div className="command-toolbar-actions">
          {filesProject && (compactFiles ? <Sheet title="Project files" side="end" bodyClassName="project-files-sheet-body"
            open={mobileFilesOpen} onOpenChange={setMobileFilesOpen}
            trigger={<Button variant="ghost" size="sm" iconOnly aria-label="Show project files"><Icon name="panel-right" /></Button>}>
            <ProjectFilesPane key={filesProject.id} project={filesProject} agents={w.agents} />
          </Sheet> : <Tooltip content={filesOpen ? 'Hide project files' : 'Show project files'}>
            <Button variant="ghost" size="sm" iconOnly aria-label={filesOpen ? 'Hide project files' : 'Show project files'}
              aria-expanded={filesOpen} aria-controls="project-files-sidebar" onPress={() => setFilesOpen((value) => !value)}><Icon name="panel-right" /></Button>
          </Tooltip>)}
          <Tooltip content="New conversation">
            <Button variant="ghost" size="sm" iconOnly className="command-mobile-new" aria-label="New chat" onPress={newConversation}><Icon name="plus" /></Button>
          </Tooltip>
          {activeChat && ['running', 'waiting'].includes(activeChat.status) && <Button variant="ghost" size="sm" className="command-stop"
            disabled={actionBusy || w.agents.status !== 'connected'} onPress={() => { void chatAction(async () => {
              composer.pauseMessages()
              if (executionMonitor) await w.command.mutate('command-pause', { key: requestId(), monitorId: executionMonitor.id })
              else await w.chats.interrupt({ key: requestId(), chatId: activeChat.id, expectedTurnId: activeChat.turnId })
            }) }}>
            <span className="command-stop-symbol" aria-hidden="true" />{executionMonitor ? 'Pause supervision' : 'Stop'}
          </Button>}
          {activePreview && <ConversationInfo key={activePreview.id} conversation={activeChat ?? { title: conversationTitle, profile: activePreview.agent, project: activePreview.project, model: activePreview.model }}
            agents={w.agents} chatId={activeChat?.id}
            disabled={actionBusy || w.agents.status !== 'connected'} connected={w.agents.status === 'connected'}
            onDetach={activeChat ? () => chatAction(() => w.chats.detach({ key: requestId(), chatId: activeChat.id })) : undefined}
            onOpenTerminal={activeChat && !activeChat.deviceId && !managedBackend ? () => terminalAction() : undefined}
            onReleaseTerminal={activeChat && !activeChat.deviceId && !managedBackend ? () => terminalAction(true) : undefined} />}
        </div>
      </div>

      {showConnectionNotice && <div className={`chat-connection-notice${connectionWarning ? ' chat-connection-notice--warning' : ''}${transportUnavailable ? ' command-workspace-connection' : ''}`}
        role="group" aria-label="Chat connection">
        <Icon name={connectionWarning ? 'triangle-alert' : 'refresh-cw'} />
        <div className="chat-connection-copy">
          <p role={connectionWarning ? 'alert' : 'status'}>{connectionWarning
            ? 'Chat connection unavailable.'
            : `${w.agents.status === 'connecting' && !w.agents.error && !connectionAttempt ? 'Connecting…' : 'Reconnecting…'}${connectionAttempt ? ` Attempt ${connectionAttempt} of 3.` : ''}`}</p>
          {connectionWarning && <>
            <p>We couldn’t reconnect after 3 attempts. Your draft and saved messages are kept.</p>
            {connectionError && <details><summary>Connection details</summary><p>{connectionError}</p></details>}
          </>}
        </div>
        {connectionWarning && <div className="chat-connection-actions">
          <Button variant="secondary" size="sm" onPress={() => {
            if (transportUnavailable) w.agents.connect()
            else chatRecovery.retry()
          }}>{transportUnavailable ? 'Retry connection' : 'Retry chat connection'}</Button>
          {activePreview?.chat && !managedBackend && <Button variant="ghost" size="sm"
            onPress={() => reportRecovery({ kind: 'open', chatId: activePreview.id })}>Open in terminal</Button>}
          {activeChat?.backendCapabilities?.operations.restore_session?.supported && !transportUnavailable &&
            <Button variant="ghost" size="sm" disabled={busy} onPress={() => { void chatAction(async () => {
              await w.agents.request('chat-backend-resume', { chatId: activeChat.id, key: requestId() })
              await w.chats.open(activeChat.id)
            }) }}>Resume saved session</Button>}
        </div>}
      </div>}
      {activeChat?.interruptedTurn && activeChat.interruptedTurn.id === activeChat.turnId && <div className="chat-connection-notice" role="status" aria-label="Previous task interrupted">
        <Icon name="info" /><div className="chat-connection-copy"><p>Your previous task was interrupted. Review the saved results and continue here.</p></div>
      </div>}
      {supervision && <div className="supervision-context" aria-label="Supervision status"><Icon name="eye" /><p>{supervision.progress}</p></div>}
      {!supervision && supervisedBy.length > 0 && <div className="supervision-context" aria-label="Supervised by">Supervised by:
        {supervisedBy.map(monitor => <a key={monitor.id} href={`#/${supervisionChat(monitor) ? `chat/${supervisionChat(monitor)}/supervision/${monitor.id}` : `chat/supervision/${monitor.id}`}`}>{monitor.title}</a>)}
      </div>}
      {(activeChat?.deviceId || registeredChat?.deviceId) && <div className="connect-chat-location" role="group" aria-label="Remote execution location">
        <strong>Running on {activeChat?.device ?? registeredChat?.device}</strong>
        {(activeChat?.remoteProfile ?? registeredChat?.remoteProfile) && <span>{(activeChat?.profileSelection ?? registeredChat?.profileSelection)?.mode === 'auto' ? 'Auto → ' : 'Agent Manager · '}{activeChat?.remoteProfile ?? registeredChat?.remoteProfile}</span>}
        <code>{activeChat?.cwd ?? registeredChat?.cwd}</code>
      </div>}

      <div className="command-stage">
        {activeChat ? <LiveConversation agentActions={agentActions} agents={w.agents} navigate={navigate} key={activeChat.id} chat={activeChat} disabled={actionBusy || activeChat.syncing || w.agents.status !== 'connected'}
          onLoadOlder={(before) => w.chats.loadOlder(activeChat.id, before)}
          onLoadNewer={(after) => w.chats.loadNewer(activeChat.id, after)}
          onLatest={() => w.chats.latest(activeChat.id)}
          projectRuns={w.chats.projectRuns[activeChat.id] ?? []}
          onProjectRunAction={(id, action, targetId) => w.chats.projectRunAction(activeChat.id, id, action, targetId)}
          transfers={w.chats.transfers[activeChat.id] ?? []}
          onTransferAction={(id, action) => w.chats.transferAction(activeChat.id, id, action)}
          discoveries={w.projects.discoveries.filter((job) => job.origin.kind === 'chat' && job.origin.id === activeChat.id)}
          onViewDiscovery={(id) => { setDiscoveryJobId(id); setDiscoveryOpen(true) }}
          launches={w.chats.launches[activeChat.id] ?? []} connected={w.agents.status === 'connected'}
          workflows={w.chats.workflows[activeChat.id] ?? []} onInbox={messageId => openMainInbox(w, navigate, messageId)}
          onWorkflowAction={(workflow, action) => w.chats.workflowAction(activeChat.id, workflow.id ?? workflow.key, action)}
          onViewWorkflow={(key) => navigate(`workflows/runs/${encodeURIComponent(key)}`)}
          onOpenChat={(id) => { revealHistoryItem(id); navigate(`chat/${id}`) }}
          onAnswer={(requestIdValue, values) => chatAction(() => w.chats.answer({ key: requestId(), chatId: activeChat.id, requestId: requestIdValue, ...values }))} /> : activePreview?.chat ?
          <section className="command-conversation" aria-label="Agent conversation">
            {connectionWarning ? <p>Reconnect to load this conversation.</p>
              : notice ? <p role="status">{notice}</p> : <PageLoading label="Opening your conversation…" size="panel" />}
          </section> : activePreview ? (
          <section className="command-conversation" aria-label={activeRun ? 'Agent conversation' : mode === 'chat' ? 'Chat preview' : 'Work draft preview'}>
            <div className="command-user-message"><span className="command-message-label">You</span><MessageContent text={activePreview.prompt} /></div>
            {activeRun ? <div className="command-transcript" role="log" aria-label="Conversation messages" aria-live="polite">
              {conversation?.messages.filter((item) => item.id !== String(initialSend?.message_id)).map((item) => {
                const incoming = item.direction === 'incoming'
                return <article className={`command-chat-message command-chat-message--${incoming ? 'agentMessage' : 'userMessage'}`} key={item.id} aria-label={incoming ? `${activeRun.profile} message` : 'Your message'}>
                  {incoming && <div className="command-assistant-heading"><Mark small /><strong>{activeRun.profile}</strong></div>}
                  <MessageContent text={item.body} />
                  {incoming && <div className="command-message-actions"><CopyButton text={item.body} label="Copy response" /></div>}
                </article>
              })}
              {!conversation?.messages.some((item) => item.direction === 'incoming') && <div className="command-preview-response"><Mark small /><div><strong>{activeRun.profile}</strong><p>Waiting for the agent’s reply.</p></div></div>}
              <div className="command-answer-options"><Button variant="ghost" size="sm" onPress={() => navigate('carrier')}>Open in Carrier</Button>{activeRun.session_id && <Button variant="ghost" size="sm" onPress={() => navigate(`terminals/${encodeURIComponent(activeRun.session_id!)}`)}>Open terminal</Button>}</div>
            </div> : <div className="command-preview-response">
              <Mark small />
              <div>
                <strong>{mode === 'chat' ? 'A little room to think.' : 'Ready for the next step.'}</strong>
                <p>{mode === 'chat' ? 'Your message is saved here. Agent replies will appear in this space when chat is connected.' : 'Your instructions are saved as a work draft. You can keep refining your direction here.'}</p>
                <span>{activePreview.project ? `${activePreview.project} · ${activePreview.agent}` : activePreview.agent}</span>
              </div>
            </div>}
          </section>
        ) : (
          <div className="command-welcome">
            <h1 tabIndex={-1}>{mode === 'chat' ? 'Where should we start?' : 'What are we working on?'}</h1>
            <p>{mode === 'chat' ? 'Ask a question, explore an idea, or think out loud.' : 'Bring your project, your ideas, and a little direction.'}</p>
          </div>
        )}

        {composerContent}
      </div>
      </div>
      {desktopFilesOpen && filesProject && <aside id="project-files-sidebar" className="project-files-sidebar" aria-label="Project files sidebar">
        <ProjectFilesResize width={filesWidth} onChange={setFilesWidth} />
        <ProjectFilesPane key={filesProject.id} project={filesProject} agents={w.agents} onClose={() => setFilesOpen(false)} />
      </aside>}
    </div>
  )
}
