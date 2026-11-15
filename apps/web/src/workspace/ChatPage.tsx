import { randomUUID } from '../uuid'
import { ResourcePickerView, ResourceReportView, launchResourceArgs, useResourcePicker } from '../agents/ResourcePicker'
import type { ResourceRequest } from '../agents/ResourcePicker'
import type { ManagementAction } from '../agents/AgentManagementCard'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { PageLoading } from '../components/PageLoading'
import { WorkspaceSidebar, WorkspaceSidebarActions, WorkspaceSidebarHeader } from '../components/WorkspaceSidebar'
import { Button, Dialog, Icon, Sheet, SidebarToggle, Tooltip, useThemeAttributes } from 'bbb-design'
import type { IconName, SelectOption } from 'bbb-design'
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay, ListBox, ListBoxItem, Popover, Select, SelectValue, Tab, TabList, TabPanel, Tabs } from 'react-aria-components'
import { Mark } from '../components/Mark'
import type { Conversation } from '../carrier/client'
import { requestId } from '../terminals/connection'
import { labelText } from '../terminals/context'
import { Conversation as LiveConversation } from '../chats/Conversation'
import { ChatStatus, chatActivity, type ChatActivity } from '../chats/ChatStatus'
import { QueuedMessages } from '../chats/QueuedMessages'
import { BackgroundActivity } from '../chats/BackgroundActivity'
import { AgentError } from '../agents/client'
import { preferredBackend, profileTerminalAvailable } from '../agents/backends'
import { useClaudeMigration } from '../agents/useClaudeMigration'
import { ConversationInfo } from '../chats/ConversationInfo'
import { DeleteConversation } from '../chats/DeleteConversation'
import { CopyButton, MessageContent } from '../chats/MessageContent'
import type { Workspace } from './model'
import { NewProject } from '../projects/NewProject'
import { ProjectFilesPane, ProjectFilesResize } from '../projects/ProjectFilesPane'
import { projectFilesCompact, subscribeProjectFilesLayout } from '../projects/files'
import { RemoteChatDialog } from '../connect/RemoteChatDialog'
import { DiscoverProjects } from '../projects/DiscoverProjects'
import { SessionForm } from '../sessions/SessionForm'
import { McpConnections, McpServerList, McpSummary } from '../agents/mcp'
import { useBackendDiscovery } from '../agents/useBackendDiscovery'
import { useProfileModels } from '../agents/useProfileModels'
import { conversationPermission, permissionLabel } from '../agents/permissions'
import { readStorage } from '../storage'
import { terminalIsActive } from '../chats/model'
import { useVoice } from '../chats/voice'
import { VoiceButton, VoicePanel } from '../chats/VoiceControls'
import { ChatComposer, EmptyChatDraft } from '../chats/ChatComposer'
import { useComposerTyping } from '../chats/useComposerTyping'
import { ChatModelPicker } from '../chats/ChatModelPicker'
import { nativeComposerCommands } from '../chats/nativeComposerCommands'
import { messageTimingOptions } from '../chats/messageTiming'
import { composerError, type ComposerNoticeTone, type ComposerStatusNotice } from '../chats/composerNotices'
import type { ChatAttempt } from '../chats/composer'
import type { ComposerMentionGroup } from '../chats/InboxComposerInput'
import type { ComposerCommandSetting } from '../chats/useComposerSuggestions'
import { useMentionResources } from '../chats/MentionResources'
import { findModelSetting, modelSettingMentions, modelSettingShortcuts } from '../chats/modelSettingMentions'
import type { SavedWorkflow } from '../workflows/library'
import { resolvePromptReferences } from '../chats/fileReferences'
import { commandInput, configOptions, settingValue, type ChatCommand, type SessionConfig } from '../chats/commands'
import { CommandDialog, type CommandPanel } from '../chats/CommandDialog'
import type { ChatDeletionChoice, ChatSnapshot } from '../chats/model'
import { ChatSearch } from '../chats/ChatSearch'
import { ChatHistory, type Preview } from '../chats/ChatHistory'
import { openMainInbox } from '../carrier/navigation'
import './chat.css'
import { reportRecovery } from '../recovery/events'
import { useChatRecovery } from '../chats/useChatRecovery'
import { SupervisionControl } from '../command/SupervisionControls'
import { chatSupervision, supervisionActive, supervisionChat } from '../command/supervision'
import { chatMentionLink } from '../chats/composerMentions'
import { WorkspaceTheme } from '../branding/ContentTheme'

type ChatMode = 'chat' | 'work'
type Suggestion = { label: string; icon: IconName; prompt: string }

function orderRecentConversations(items: Preview[], addedAt: Record<string, number>) {
  // User sends determine order; background activity never changes it.
  return [...items].sort((a, b) =>
    (addedAt[b.id] ?? b.createdAt ?? 0) - (addedAt[a.id] ?? a.createdAt ?? 0) || a.id.localeCompare(b.id))
}

function ComposerPicker({ label, icon, value, options, disabled, active = false, showValue = false, showChevron = true, displayValue, summary = '', onChange }: {
  label: string
  icon?: IconName
  value: string
  options: SelectOption[]
  disabled: boolean
  active?: boolean
  showValue?: boolean
  showChevron?: boolean
  displayValue?: string
  summary?: string
  onChange: (value: string) => void
}) {
  const theme = useThemeAttributes()
  const current = options.find((option) => option.id === value)
  const caption = `${label}: ${displayValue ?? current?.label ?? (value || 'Choose an option')}${summary}`
  return (
    <Select className={`command-context-picker command-context-picker--${label.toLowerCase().replaceAll(' ', '-')}`} aria-label={label} selectedKey={value} isDisabled={disabled}
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
          {showValue && showChevron && !disabled && <Icon name="chevron-down" className="command-picker-chevron" />}
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
  const noticeContext = useRef<{ composer: typeof composer; scope: string } | null>(null)
  const staleNotice = () => noticeContext.current?.composer === composer && noticeContext.current.scope !== noticeScope
  const setNotice = (message: string, tone: ComposerNoticeTone = 'info', resolved = false) => {
    if (staleNotice()) return
    const previous = composer.getSnapshot().notice
    if (!resolved && message && ['info', 'success'].includes(tone) && previous?.tone === 'error' && (!previous.scope || previous.scope === noticeScope)) return
    composer.update({ notice: message ? { id: 'operation', tone, title: message, scope: noticeScope } : null })
  }
  const setError = (cause: unknown) => { if (!staleNotice()) composer.update({ notice: composerError(cause, noticeScope) }) }
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
  const [commandPanel, setCommandPanel] = useState<CommandPanel | null>(null)
  const [commandsError, setCommandsError] = useState('')
  const [commandsLoading, setCommandsLoading] = useState(false)
  const preparation = useRef<{ composer: typeof composer; promise: Promise<ChatSnapshot | undefined> } | null>(null)
  const expectedCommandOutput = useRef<{ chatId: string; key: string; composer: typeof composer } | null>(null)
  useEffect(() => { setCommandsError(''); setCommandsLoading(false); setCommandPanel(null); setModelOptionsOpen(false) }, [composer])
  const resources = configuration.resources
  const setResources = (resources: ResourceRequest) => composer.configure({ resources })
  const suiteTools = configuration.suiteTools
  const setSuiteTools = (suiteTools: boolean) => composer.configure({ suiteTools })
  const [resourcesReviewed, setResourcesReviewed] = useState<typeof composer | null>(null)
  useEffect(() => { if (composerOptionsOpen) setResourcesReviewed(composer) }, [composerOptionsOpen, composer])
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
  const [terminalSetupOpen, setTerminalSetupOpen] = useState(false)
  const [discoveryJobId, setDiscoveryJobId] = useState<string | null>(null)
  const defaultAgent = w.chatProfiles.find((p) => p.preferred)?.id ?? w.chatProfiles.find((p) => !p.automatic && p.ready !== false)?.id ?? w.chatProfiles[0]?.id ?? ''
  const agent = configuration.profileId || defaultAgent
  const setAgent = (profileId: string) => composer.configure({ profileId })
  const modelChoice = configuration.modelChoice
  const setModelChoice = (modelChoice: typeof configuration.modelChoice) => composer.configure({ modelChoice: { ...modelChoice,
    label: modelOptions.find(option => option.id === modelChoice.value)?.label, backend: effectiveBackend } })
  const [chatPreviews, setChatPreviews] = useState<Preview[]>([])
  const [deletingPreview, setDeletingPreview] = useState<Preview | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
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
  const focusedComposer = useRef<{ composer: typeof composer; chatId: string | undefined } | null>(null)
  useComposerTyping(promptRef, true)
  useEffect(() => {
    if (surface !== 'chat' || busy) return
    const changed = focusedComposer.current?.composer !== composer || focusedComposer.current?.chatId !== chatId
    focusedComposer.current = { composer, chatId }
    // Wait for the selected conversation and its composer to commit before
    // focusing. Streaming updates should not steal focus from the transcript.
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement
      const background = !active || active === document.body || active === document.documentElement
      if ((changed || background || active === promptRef.current) && !document.querySelector('[role="dialog"], [role="alertdialog"]')) promptRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [surface, composer, activePreview?.id, chatId, busy])
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
  const backendOption = isRemoteChat ? undefined : w.agents.catalog?.backends?.find(row => row.id === (effectiveBackend || (profile?.provider === 'codex' ? 'native-codex' : '')) && row.provider === profile?.provider)
  const catalogProfile = w.agents.catalog?.profiles.find(row => row.id === agent)
  const selectedReadiness = catalogProfile?.readiness
  const claudeMigration = useClaudeMigration(w.agents)
  const catalogReadiness = selectedReadiness?.chat?.ready === false ? selectedReadiness.chat :
    (selectedReadiness?.backends?.[effectiveBackend || 'native-codex']) ?? selectedReadiness?.chat ?? selectedReadiness
  const noticeScope = `${activePreview?.id ?? 'draft'}:${agent}:${effectiveBackend}:${catalogProfile?.revision ?? ''}`
  noticeContext.current = { composer, scope: noticeScope }
  const draftReadiness = notice?.scope === noticeScope && notice.setup ? notice.setup : catalogReadiness
  const terminalAvailable = Boolean(!activePreview && catalogProfile && profileTerminalAvailable(w.agents.catalog, catalogProfile))
  const catalogTerminalFallback = terminalAvailable && (draftReadiness?.ready === false || backendOption?.available === false || !backendOption && profile?.provider !== 'codex')
  useEffect(() => {
    if (notice?.tone !== 'success') return
    const timer = setTimeout(() => {
      if (composer.getSnapshot().notice === notice) composer.update({ notice: null })
    }, 5000)
    return () => clearTimeout(timer)
  }, [composer, notice])
  const selectedMcpServers = mcpServers ?? w.agents.catalog?.profiles.find((row) => row.id === agent)?.mcp?.servers ?? []
  const mcpSelection = { inherit: false, add: selectedMcpServers }
  const resourceArgs = { ...launchResourceArgs(resources, mcpServers === null ? undefined : mcpSelection), suiteTools: backendOption?.controls.suiteTools === false ? false : suiteTools }
  const usesAppServer = (['codex', 'claude', 'antigravity'].includes(profile?.provider ?? '') || Boolean(backendOption)) && !activeRun
  const activeChat = activePreview?.chat ? w.chats.snapshots[activePreview.id] : undefined
  const catalogDraft = !activePreview && usesAppServer && !catalogTerminalFallback
  const resourcePickerProps = { agents: w.agents, provider: profile?.provider as import('../agents/client').Provider ?? 'codex', profile: profile?.name ?? '',
    applicationPreset: suiteTools && backendOption?.controls.suiteTools !== false ? 'controller' as const : 'basic' as const, cwd: selectedProject?.path,
    backend: catalogTerminalFallback ? undefined : backendOption?.id, mode: catalogTerminalFallback ? 'terminal' as const : 'backend' as const,
    value: resources, onChange: setResources, disabled: busy || Boolean(pendingAttempt) }
  const resourcePicker = useResourcePicker({ ...resourcePickerProps,
    enabled: Boolean(backendOption?.controls.resources !== false && managedProfile && !activePreview?.chat && !activeRun && (composerOptionsOpen || resourcesReviewed === composer)) })
  const resourcesValid = resourcePicker.valid
  const resourceValidationMessage = resourcePicker.inputsError ? 'Correct the resource instruction inputs before starting a conversation.' :
    resourcePicker.error || resourcePicker.catalogError || 'Checking selected resources…'
  const nativeCatalogBackend = profile?.provider === 'codex' ? 'native-codex' : profile?.provider === 'opencode' ? 'opencode-native' : undefined
  const discovery = useBackendDiscovery(w.agents, catalogDraft && profile && nativeCatalogBackend && catalogReadiness?.ready !== false && backendOption?.available !== false ? {
    provider: profile.provider, profile: profile.automatic ? null : profile.name, backend: nativeCatalogBackend,
    ...(selectedProject ? { projectId: selectedProject.id } : { draftId: configuration.draftId }),
    ...(modelChoice.profileId === agent && modelChoice.value ? { model: modelChoice.value } : {}),
  } : undefined)
  const readiness = notice?.scope === noticeScope && notice.setup ? notice.setup : discovery.setup ?? catalogReadiness
  const terminalFallback = catalogTerminalFallback || terminalAvailable && readiness?.ready === false
  const nativeModelDiscovery = Boolean(profile && (terminalFallback || catalogDraft && !nativeCatalogBackend))
  const nativeModels = useProfileModels(w.agents, nativeModelDiscovery && profile ? {
    id: agent, provider: profile.provider, profile: profile.automatic ? null : profile.name, auth: catalogProfile?.auth,
    revision: catalogProfile?.revision, cwd: selectedProject?.path ?? w.agents.catalog?.cwd ?? '',
  } : undefined)
  useEffect(() => {
    // Retain a discovered setup requirement when switching resource previews to
    // terminal mode disables discovery for this draft.
    if (!terminalAvailable || catalogTerminalFallback || discovery.setup?.ready !== false) return
    composer.update({ notice: { id: 'operation', tone: 'warning', scope: noticeScope, setup: discovery.setup,
      title: discovery.setup.reason || 'Chat setup is required for this profile.' } })
  }, [composer, noticeScope, terminalAvailable, catalogTerminalFallback, discovery.setup])
  const terminalCommands = terminalFallback ? nativeComposerCommands(profile?.provider ?? '') : undefined
  const draftCommands = terminalCommands ?? (!terminalFallback && !activePreview && !pendingAttempt ? (discovery.catalog?.commands.length ? discovery.catalog.commands :
    (backendOption ?? w.agents.catalog?.backends?.find(row => row.id === 'native-codex'))?.commandPreview)?.map(command =>
    catalogDraft && ['native', 'suite', 'prompt', 'terminal'].includes(command.execution) && !command.startsConversation ? { ...command, execution: 'unsupported' as const,
      reason: 'Start a conversation before using this command.' } : command) : undefined)
  if (catalogDraft && backendOption?.controls.sessionConfig && draftCommands && !draftCommands.some(command => command.name === 'model'))
    draftCommands.push({ name: 'model', description: 'View model availability', execution: 'client', action: 'model' })
  const configurableSettings = activeChat?.sessionConfig ?? (catalogDraft ? discovery.catalog?.settings.map(option => ({ ...option,
    defaultUnknown: Boolean(option.defaultUnknown || discovery.snapshot?.state !== 'ready') &&
      (option.category === 'model' && backendOption?.controls.model !== false ? !(modelChoice.profileId === agent && modelChoice.value) : configuration.settings[option.id] === undefined),
    currentValue: option.category === 'model' && backendOption?.controls.model !== false ? modelChoice.profileId === agent ? modelChoice.value : '' : configuration.settings[option.id] ?? option.currentValue })) : [])
  const initialConfig = Object.entries(configuration.settings).map(([id, value]) => ({ id, value }))
  const invalidDraftSettings = catalogDraft && discovery.snapshot?.state === 'ready' ? initialConfig.filter(selection => {
    const option = configurableSettings?.find(row => row.id === selection.id)
    return !option || !(option.type === 'boolean' && typeof selection.value === 'boolean' || option.type === 'select' &&
      configOptions(option).some(row => row.value === selection.value))
  }) : []
  const availableCommands = activeChat?.availableCommands ?? draftCommands ?? []
  const creationIncomplete = pendingAttempt?.op === 'chat-create' || Boolean(activeChat?.creation && activeChat.creation.state !== 'created')
  const failedCreation = activeChat?.creation?.state === 'failed'
  const creationAlternatives = failedCreation ? w.agents.catalog?.backends?.filter(row => row.provider === activeChat.provider && row.available && row.id !== activeChat.backend) ?? [] : []
  const supervising = chatSupervision(w.command.monitors, activePreview?.id)
  const supervision = supervising[0]
  const executionMonitor = supervising.find(monitor => (monitor.supervisorChatId === activePreview?.id || activeChat?.automationId === monitor.id) && monitor.state !== 'cancelled')
  const supervisedBy = w.command.monitors.filter(monitor => supervisionActive(monitor) && monitor.watchedChatIds?.includes(activePreview?.id ?? '') && supervisionChat(monitor) !== activePreview?.id)
  const waitingForChat = Boolean(!creationIncomplete && activePreview?.chat && (!activeChat || activeChat.syncing))
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
    if (notice?.title === failed.message || notice?.details === failed.message) composer.update({ notice: null })
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
  const modelCatalog = nativeModelDiscovery ? nativeModels : {
    models: discovery.catalog?.models ?? [], loading: discovery.loading, error: discovery.error, refresh: discovery.refresh }
  const discoveredModel = discovery.snapshot?.state === 'ready' ? discovery.catalog?.settings.find(option => option.category === 'model') : undefined
  const defaultModel = catalogDraft ? !discoveredModel?.defaultUnknown && typeof discoveredModel?.currentValue === 'string' && discoveredModel.currentValue || undefined :
    profile?.model && profile.model !== 'Default' ? profile.model : undefined
  const defaultModelLabel = modelCatalog.models.find(item => item.id === defaultModel)?.name ?? defaultModel
  const modelOptions: SelectOption[] = sessionModel && (!catalogDraft || backendOption?.controls.model === false) ? sessionOptions(sessionModel) : [
    { id: '', label: 'Default', description: defaultModelLabel ? `Use ${defaultModelLabel}` : 'Use the profile’s configured model' },
    ...modelCatalog.models.map((item) => ({ id: item.id, label: item.name,
      description: `${item.id}${item.free ? ' · Free' : ''}${item.description ? ` · ${item.description}` : ''}` })),
  ]
  if (catalogDraft && backendOption?.controls.model === false && !modelOptions.some(option => option.id === ''))
    modelOptions.unshift({ id: '', label: 'Provider default' })
  if (model && !modelOptions.some((option) => option.id === model))
    modelOptions.push({ id: model, label: modelChoice.profileId === agent && modelChoice.value === model && modelChoice.backend === effectiveBackend ? modelChoice.label ?? model : model,
      ...(catalogDraft ? { description: 'Custom model · retained outside the discovered list' } : {}) })
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
  const timingOptions = messageTimingOptions(activeTurn, steerAvailable)
  const messageTimingDisabled = busy || Boolean(pendingAttempt) || voice.engaged || w.agents.status !== 'connected'
  const sendLabel = pendingAttempt ? 'Retry request' : terminalFallback ? 'Open terminal' : executionMonitor ? 'Send direction' : followupOptions ?
    effectiveFollowupMode === 'queue' ? 'Send after this turn' : activeTurn ? 'Add to current turn' : 'Send message' :
    managedProfile ? activeRun || activePreview?.chat ? 'Send message' : 'Start agent' : mode === 'chat' ? 'Send message' : 'Create work draft'
  const canSubmit = (Boolean(retainedChat) || terminalFallback || readiness?.ready !== false) && resourcesValid && (terminalFallback || invalidDraftSettings.length === 0) && (!activeChat?.initialConfiguration || activeChat.initialConfiguration.state === 'ready') && Boolean(profile && (retainedChat || terminalFallback || ((!['claude', 'antigravity'].includes(profile.provider) || Boolean(backendOption?.available)) && (!backendOption || backendOption.available))) && !busy && !activeChat?.syncing && !activeChat?.backendHistoryPending && !(managedBackend && activeTurn && !queueAvailable) && (!voice.engaged || voice.phase === 'active') && (terminalFallback ? w.agents.status === 'connected' : !managedProfile ||
    (usesAppServer ? (w.agents.status === 'connected' || Boolean(activePreview?.chat && activeChat)) && (pendingAttempt || !activePreview?.chat ||
      (activeChat && (!activeTurn || (!voice.engaged && (effectiveFollowupMode === 'queue' || activeChat.turnId))))) :
      w.carrier.status === 'connected' && w.carrier.service?.connected && w.carrier.service.agent_configured &&
      w.carrier.service.providers.includes(profile.provider))))
  const runCreatedAt = new Map(w.carrier.runs.map((run): [string, number] => [run.key, run.created_at * 1000]))
  function latestChatFor(id: string) {
    const registered = w.chats.chats.find(chat => chat.id === id)
    const snapshot = w.chats.snapshots[id]
    return snapshot && (!registered || snapshot.revision > registered.revision) ? snapshot : registered
  }
  function activityFor(item: Preview): ChatActivity {
    const unconfirmed = item.id === activePreview?.id && (pendingAttempt && !busy || pendingMessages.some(row => row.status === 'failed' && row.uncertain))
    if (item.chat) {
      const chat = latestChatFor(item.id)
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
  const history = previews.filter(item => !executionOwners.has(item.id) || item.id === activePreview?.id).map((item) => {
    const activity = activityFor(item)
    const chat = item.chat ? latestChatFor(item.id) : undefined
    return { ...item, activity,
      unread: activity === 'done' && Boolean(chat?.latestCompletedTurnId && chat.latestCompletedTurnId !== chat.lastReadTurnId),
      parentId: executionOwners.get(item.parentId ?? '') ?? item.parentId,
      supervision: chatSupervision(w.command.monitors, item.id)[0],
    }
  })
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
      const latestAddition = Object.values(previous).reduce((value, addedAt) => Math.max(value, addedAt), Date.now())
      const newest = items.reduce((value, item) => Math.max(value, item.createdAt ?? 0), latestAddition)
      return { ...previous, [id]: newest + 1 }
    })
  }
  const chatApi = useRef(w.chats)
  chatApi.current = w.chats
  const needsChatRecovery = Boolean(!creationIncomplete && activePreview?.chat && (chatOpenFailed || recoveryWait || activeChat?.status === 'offline' || activeChat?.statusReason === 'notification_error' || activeChat?.sessionRecovery))
  const chatRecovery = useChatRecovery({
    id: activePreview?.chat ? activePreview.id : undefined,
    enabled: !creationIncomplete && w.agents.status === 'connected', needed: needsChatRecovery,
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
    let alive = true
    if (!creationIncomplete && !chatId && registeredChat?.id && w.agents.status === 'connected') {
      void chatApi.current.visit(registeredChat.id).catch((error: Error) => { if (alive) setError(error) })
    }
    return () => { alive = false }
  }, [registeredChat?.id, w.agents.status, chatId, creationIncomplete])
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
      if (target.getSnapshot().pendingAttempt?.op === 'chat-create') {
        void inspectCreation(chatId).catch((error: Error) => { if (alive) setError(error) })
        return () => { alive = false }
      }
      void chatApi.current.visit(chatId).then((chat) => {
        if (!alive || currentComposer.current !== target) return
        setChatOpenFailed(false)
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
      void w.carrier.request<Conversation>('conversation', { mailbox: 'user', id: initialSend.message_id, limit: 100 }).then((result) => { if (alive) setConversation(result) }).catch((error: Error) => { if (alive) setError(error) })
    }
    return () => { alive = false }
  }, [initialSend?.message_id, activeRun?.key, w.carrier.service?.version, w.carrier.status])

  async function deliverMessage(message: import('../chats/composer').PendingMessage, save: (attempt: NonNullable<import('../chats/composer').PendingMessage['attempt']>) => void) {
    let attempt = message.attempt
    if (!attempt) {
      const captured = message.draft
      let text: string
      try {
        text = message.resolvedText ?? await resolvePromptReferences(message.text, captured?.inboxReferences, captured?.fileReferences,
          filesProject?.id, w.carrier.request, w.agents.request)
      } catch (cause) {
        throw new AgentError(cause instanceof Error ? cause.message : 'Could not resolve message references.', 'validation')
      }
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
    if (terminalCommands && !pendingAttempt) {
      const parsed = commandInput(prompt, terminalCommands)
      if (parsed?.command.execution === 'client' && parsed.command.action === 'model' && parsed.arguments) {
        const selected = modelOptions.find(option => option.id.toLowerCase() === parsed.arguments.toLowerCase() ||
          option.label.toLowerCase() === parsed.arguments.toLowerCase())
        if (!selected && /\s/.test(parsed.arguments)) {
          showNativeTerminalCommand({ name: 'model', description: 'Provider model command', execution: 'terminal' }, prompt)
          return
        }
        setModelChoice({ profileId: agent, value: selected?.id ?? (parsed.arguments.toLowerCase() === 'default' ? '' : parsed.arguments) })
        draftStore.set({ ...draft, prompt: '', inboxReferences: [], fileReferences: [] })
        promptRef.current?.focus()
        return
      }
      if (parsed) {
        if (parsed.command.execution === 'terminal') showNativeTerminalCommand(parsed.command, prompt)
        else if (parsed.arguments) setNotice('Choose this command from the menu without arguments.', 'warning')
        else await chooseCommand(parsed.command)
        return
      }
      if (prompt === '/') return
    }
    if (!terminalFallback && pendingAttempt?.op !== 'session-start' && !startsWithCommand && !inlinePlan && !executionMonitor && usesAppServer && (pendingAttempt?.op === 'chat-config-set' || pendingAttempt?.op === 'chat-command' || !pendingAttempt &&
      (commandInput(prompt, activeChat?.availableCommands ?? []) || /^\/[A-Za-z][^\s/]*(?:\s[\s\S]*)?$/.test(prompt)))) {
      await submitCommand(prompt)
      return
    }
    if (activePreview?.chat && activeChat && usesAppServer && !executionMonitor && !voice.engaged && !pendingAttempt) {
      if (pendingMessages.length >= 20) { setNotice('There are already 20 messages waiting for delivery. Review them before adding more.', 'warning'); return }
      const prepared = composer.getSnapshot().preparedMessage
      composer.enqueue({ id: requestId(), text: prompt, mode: effectiveFollowupMode, status: 'waiting', draft,
        ...(prepared?.draft.prompt.trim() === prompt ? { resolvedText: prepared.text } : {}) }, deliverMessage)
      composer.update({ preparedMessage: undefined })
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
        setNotice(error instanceof Error ? error.message : 'Unable to load the referenced inbox message.', 'error')
        setBusy(false)
        return
      }
    }
    if (terminalFallback || pendingAttempt?.op === 'session-start') {
      await launchNativeTerminal(resolvedPrompt)
      return
    }
    if (usesAppServer) {
      setBusy(true); setNotice('')
      let queuedRequest = false
      try {
        const reconnecting = w.agents.status !== 'connected'
        await w.agents.ensureConnected()
        if (pendingAttempt?.op === 'chat-create') {
          await inspectCreation(String(pendingAttempt.args.key))
          return
        }
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
          setNotice('Direction saved. The supervisor will evaluate the updated brief.', 'success')
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
            if (resourceArgs.suiteTools && profile.provider === 'opencode' && !configuration.toolWorkerEnvironmentId)
              throw new Error('Choose a Codex worker environment in Tools & resources')
            const key = configuration.draftId
            attempt = { op: 'chat-create', frozenPrompt: resolvedPrompt, draft, args: { key, provider: profile.provider, profile: profile.automatic ? null : profile.name,
              ...(backendOption ? { backend: backendOption.id,
                ...(backendOption.controls.access ? { permissionMode: backendAccess } : {}) } : {}),
              mode: selectedProject ? 'work' : 'chat',
              ...resourceArgs,
              ...(resourceArgs.suiteTools && profile.provider === 'opencode' ? {
                toolWorkerEnvironmentId: configuration.toolWorkerEnvironmentId,
                toolWorkerPermissionMode: configuration.toolWorkerPermissionMode ?? 'read-only',
              } : {}),
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
          if (chat.initialConfiguration && chat.initialConfiguration.state !== 'ready') {
            composer.update({ pendingAttempt: null, preparedMessage: { text: attempt.frozenPrompt ?? resolvedPrompt, draft } })
            setNotice('Conversation created. Review its settings before sending.', 'warning', true)
            return
          }
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
        if (attempt.op === 'chat-queue') setNotice('Message queued. You can edit or remove it before it is sent.', 'success')
        setPendingAttempt(null)
        draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [], fileReferences: [] })
        if (isCurrentComposer()) {
          navigate(`chat/${attempt.args.chatId}`)
          promptRef.current?.focus()
        }
      } catch (error) {
        const creation = composer.getSnapshot().pendingAttempt
        if (creation?.op === 'chat-create') {
          try { await inspectCreation(String(creation.args.key)); return }
          catch { /* Keep the exact attempt when status inspection is unavailable. */ }
        }
        if (error instanceof AgentError && error.code === 'configuration' && !error.uncertain) {
          setPendingAttempt(null); setError(error); return
        }
        if ((executionMonitor || pendingAttempt?.op === 'command-update') && error instanceof AgentError && error.code === 'manager' && error.message.includes('This monitor changed.')) {
          setPendingAttempt(null)
          setNotice('Supervision changed before this direction was accepted. Your message is still in the composer; send it again with the current brief.', 'warning')
          return
        }
        if (queuedRequest && error instanceof AgentError && error.code === 'manager') {
          // Queue validation fails before the local receipt commits. Keep the
          // draft editable so a full queue or oversized message can be corrected.
          setPendingAttempt(null)
          setError(error)
          return
        }
        setError(error)
      } finally { setBusy(false) }
      return
    }
    if (managedProfile) {
      setBusy(true); setNotice('')
      try {
        let attempt = pendingAttempt
        if (!attempt && activeRun) {
          if (['launching', 'unknown', 'failed', 'stopped'].includes(activeRun.status)) {
            setNotice('Inspect this conversation in Carrier before sending more instructions.', 'warning')
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
      } catch (error) { setError(error) }
      finally { await w.carrier.refresh(); setBusy(false) }
      return
    }
    const preview: Preview = {
      id: randomUUID(),
      createdAt: Date.now(),
      mode,
      prompt: resolvedPrompt,
      agent: profile.name,
      ...(mode === 'work' ? { project: draftProject } : {}),
    }
    if (mode === 'work') {
      // Retain the existing draft behavior. Project/session attachment is deferred.
      w.setTasks((previous) => [{ id: preview.id, prompt: resolvedPrompt, agent: profile.name, project: draftProject, status: 'Draft' }, ...previous])
      setNotice('Work draft created. No agent has been started.', 'success')
    } else {
      setChatPreviews((previous) => [preview, ...previous])
      setNotice('Message saved in this preview. No agent has been started.', 'success')
    }
    w.chatComposers.attach(preview.id, composer)
    if (isCurrentComposer()) showPreview(preview)
    rememberHistoryItem(preview.id)
    draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [] })
    setBusy(false)
    if (isCurrentComposer()) promptRef.current?.focus()
  }

  function startVoice() {
    if (!resourcesValid) { setNotice(resourceValidationMessage, 'warning'); return }
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
    const modelPreferences = { ...configuration.modelPreferences, [agent]: { backendChoice, modelChoice,
      settings: Object.fromEntries(Object.entries(configuration.settings).filter(([id]) => modelSettings.some(option => option.id === id))) } }
    const remembered = modelPreferences[value]
    composer.configure({ profileId: value, backendChoice: remembered?.backendChoice ?? '', resources: {}, suiteTools: true,
      modelChoice: remembered?.modelChoice ?? { profileId: value, value: '' }, mcpServers: undefined,
      settings: remembered?.settings ?? {}, modelPreferences })
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
      setNotice('Draft settings updated.', 'success'); return
    }
    if (!activeChat) return
    await applyCommandAttempt({ op: 'chat-config-set', preserveDraft: true,
      args: { key: requestId(), chatId: activeChat.id, configId, value } }, focusComposer)
    if (!focusComposer && isCurrentComposer() && composer.getSnapshot().pendingAttempt) setModelOptionsOpen(false)
  }

  function showNativeTerminalCommand(command: ChatCommand, text: string, preserveDraft = false) {
    const draft = draftStore.getSnapshot()
    if (!preserveDraft) draftStore.set({ ...draft, prompt: text, inboxReferences: [], fileReferences: [] })
    setCommandPanel({ kind: 'terminal', command, text, canOpen: w.agents.status === 'connected' && !busy && !pendingAttempt, target: 'new' })
  }

  async function launchNativeTerminal(prompt?: string, preserveDraft = false) {
    try {
      const terminalProfile = pendingAttempt ? catalogProfile : await claudeMigration.prepare(catalogProfile!)
      if (!terminalProfile && !pendingAttempt) return
      const attempt: ChatAttempt = pendingAttempt?.op === 'session-start' ? pendingAttempt : { op: 'session-start',
        ...(preserveDraft ? { preserveDraft: true } : {}), args: {
          key: requestId(), provider: terminalProfile!.provider, profile: terminalProfile!.profile, expectedAuth: terminalProfile!.auth,
          ...(terminalProfile!.revision ? { expectedRevision: terminalProfile!.revision } : {}),
          cwd: selectedProject?.path ?? w.agents.catalog?.cwd, ...(prompt ? { prompt } : {}),
          ...(selectedProject ? { projectId: selectedProject.id } : {}), ...(model ? { model } : {}), ...resourceArgs,
        } }
      setPendingAttempt(attempt)
      await w.agents.ensureConnected()
      const result = await w.agents.request<{ session_id: string }>('session-start', attempt.args)
      if (!result.session_id) throw new Error('The terminal launch could not be confirmed. Retry to check the original request.')
      setPendingAttempt(null)
      if (!attempt.preserveDraft) draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [], fileReferences: [] })
      void w.agents.refreshSessions()
      if (isCurrentComposer()) navigate(`terminals/${encodeURIComponent(result.session_id)}`)
    } catch (error) {
      if (error instanceof AgentError && !error.runId && !error.uncertain && !['timeout', 'connection_lost', 'bridge_lost', 'disconnected'].includes(error.code ?? '') && !/unconfirmed|uncertain/i.test(error.message))
        setPendingAttempt(null)
      setError(error)
    } finally { setBusy(false) }
  }

  async function prepareCommands(): Promise<ChatSnapshot | undefined> {
    if (terminalCommands) return undefined
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

  function chooseCommand(command: ChatCommand, preserveDraft = false) {
    if (command.execution === 'unsupported') { setNotice(command.reason ?? 'This command is unavailable for this session.', 'warning'); return }
    if (command.execution === 'terminal') {
      if (terminalCommands) { showNativeTerminalCommand(command, '/' + command.name, preserveDraft); return }
      setCommandPanel({ kind: 'terminal', command, text: '/' + command.name,
        canOpen: Boolean(activeChat && !activeChat.deviceId && !managedBackend) }); return
    }
    if (command.execution === 'setting' || command.execution === 'client' && command.action === 'model') {
      if (activeTurn || busy || pendingAttempt) { setNotice('Wait for the response before changing session settings.', 'warning'); return }
      setCommandPanel(null)
      const draft = draftStore.getSnapshot()
      const token = '/' + command.name
      const prompt = draft.prompt.trim() === token ? token + ' ' : draft.prompt + (draft.prompt && !/\s$/.test(draft.prompt) ? ' ' : '') + token + ' '
      draftStore.set({ ...draft, prompt })
      requestAnimationFrame(() => { promptRef.current?.focus(); promptRef.current?.setSelectionRange(prompt.length, prompt.length) })
      return
    }
    if (command.execution === 'client') { void runClientCommand(command, preserveDraft); return }
    setCommandPanel(null); draftStore.set({ ...draftStore.getSnapshot(), prompt: '/' + command.name + ' ', inboxReferences: [], fileReferences: [] })
    requestAnimationFrame(() => promptRef.current?.focus())
  }

  async function runClientCommand(command: ChatCommand, preserveDraft = false) {
    const action = command.action
    const chat = activeChat
    if (action === 'connect') { if (catalogDraft) discovery.refresh(); else if (activeChat) await w.chats.commands(activeChat.id); else await prepareCommands(); return }
    const draft = draftStore.getSnapshot()
    if (!preserveDraft) draftStore.set({ ...draft, prompt: '', inboxReferences: [], fileReferences: [] })
    if (action === 'help') setCommandPanel({ kind: 'help', commands: availableCommands, ...(terminalCommands ? { terminalTarget: 'new' } : {}) })
    else if (action === 'settings') { setCommandPanel(null); setComposerOptionsOpen(true) }
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
      if (!item) { setNotice('There is no completed assistant response in the loaded transcript.', 'warning'); return }
      try { await navigator.clipboard.writeText(item.text); setNotice('Assistant response copied.', 'success') }
      catch { setNotice('Clipboard access failed. Use the response’s Copy button.', 'error'); }
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
          if (parsed.arguments && parsed.command.execution === 'client') setNotice('Choose this command from the menu without arguments.', 'warning')
          else await chooseCommand(parsed.command)
          return
        }
        if (catalogDraft && parsed) {
          if (parsed.command.execution === 'setting') {
            const option = configurableSettings?.find(row => row.id === parsed.command.configId)
            if (!parsed.arguments) { await chooseCommand(parsed.command); return }
            if (!option) { await chooseCommand(parsed.command); return }
            try {
              const value = settingValue(parsed.command, parsed.arguments, option)
              if (value !== null) {
                await changeSessionConfig(option.id, value)
                draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [], fileReferences: [] })
              } else setNotice(`${option.name}: ${String(option.currentValue)}`)
            } catch (cause) { setError(cause) }
            return
          }
          setNotice('Start a conversation before using this command.', 'warning'); return
        }
        if (catalogDraft) { setNotice(discovery.loading ? 'Discovering provider commands…' : 'This command is not advertised by the selected backend.', discovery.loading ? 'info' : 'warning'); return }
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
        else setNotice('This command is not advertised by the current provider session.', 'warning')
        return
      }
      if (['client', 'terminal', 'unsupported'].includes(parsed.command.execution)) {
        if (parsed.command.execution === 'unsupported') chooseCommand(parsed.command)
        else if (parsed.command.execution === 'terminal') setCommandPanel({ kind: 'terminal', command: parsed.command,
          text: prompt, canOpen: Boolean(activeChat && !activeChat.deviceId && !managedBackend) })
        else if (parsed.arguments) setNotice('Choose this command from the menu without arguments.', 'warning')
        else chooseCommand(parsed.command)
        return
      }
      if (parsed.command.name === 'rename' && !parsed.arguments) { setCommandPanel({ kind: 'input', command: parsed.command, label: 'Conversation name' }); return }
      if (['uncertain', 'offline'].includes(chat.status) || ['running', 'waiting'].includes(chat.status) &&
        (parsed.command.requiresIdle !== false || parsed.command.name === 'skills' && parsed.arguments)) { setNotice('Wait for the response before running a command.', 'warning'); return }
      if (parsed.command.execution === 'setting') {
        const option = chat.sessionConfig?.find(row => row.id === parsed.command.configId)
        if (!option) { setNotice('This setting is no longer available. Reopen the conversation.', 'warning'); return }
        if (!parsed.arguments) { chooseCommand(parsed.command); return }
        try {
          const value = settingValue(parsed.command, parsed.arguments, option)
          if (value === null) { setNotice(`${option.name}: ${String(option.currentValue)}`); return }
          attempt = { op: 'chat-config-set', args: { key: requestId(), chatId: chat.id, configId: option.id, value } }
          if (parsed.command.name === 'plan' && parsed.arguments && !['on', 'off', 'plan', 'default', 'status'].includes(parsed.arguments)) {
            const draft = draftStore.getSnapshot()
            const text = await resolvePromptReferences(parsed.arguments, draft.inboxReferences, draft.fileReferences, filesProject?.id, w.carrier.request, w.agents.request)
            attempt.after = { op: 'chat-send', args: { key: requestId(), chatId: chat.id, text } }
          }
        } catch (cause) { setError(cause); return }
      } else {
        let arguments_ = parsed.arguments
        if (parsed.command.execution === 'prompt' || ['review', 'skills'].includes(parsed.command.name)) {
          try {
            const draft = draftStore.getSnapshot()
            arguments_ = await resolvePromptReferences(parsed.arguments, draft.inboxReferences, draft.fileReferences, filesProject?.id, w.carrier.request, w.agents.request)
            if (arguments_.length > 24000) throw new Error('Command arguments and references exceed 24,000 characters. Remove a reference or shorten the command.')
          } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'Could not resolve command references.', 'error'); return }
        }
        attempt = { op: 'chat-command', args: { key: requestId(), chatId: chat.id, command: parsed.command.name, arguments: arguments_ } }
      }
    }
    await applyCommandAttempt(attempt)
  }

  async function applyCommandAttempt(attempt: ChatAttempt, focusComposer = true) {
    if (!composer.begin('sending')) return
    setPendingAttempt(attempt)
    if (attempt.op === 'chat-command' || attempt.after?.op === 'chat-send') rememberHistoryItem(String(attempt.args.chatId))
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
        setNotice(attempt.op === 'chat-config-set' ? 'Session settings updated.' : 'Command submitted.', 'success')
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
      setError(cause)
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

  useEffect(() => {
    if (surface !== 'chat') return
    function shortcut(event: KeyboardEvent) {
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing
        && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return
        const ordered = orderRecentConversations(history, recentAddedAt)
        if (!ordered.length) return
        event.preventDefault()
        event.stopPropagation()
        const current = ordered.findIndex(item => item.id === activePreview?.id)
        const index = current < 0 ? 0 : Math.max(0, Math.min(ordered.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
        if (ordered[index].id !== activePreview?.id) openPreview(ordered[index])
        return
      }
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.key.toLowerCase() !== 'n' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      newConversation()
    }
    window.addEventListener('keydown', shortcut, true)
    return () => window.removeEventListener('keydown', shortcut, true)
  })

  function editFailedDraft(message?: string) {
    const draft = draftStore.getSnapshot()
    const next = w.chatComposers.newDraft(draft.project, configuration)
    next.draft.set({ ...draft, prompt: draft.prompt || pendingAttempt?.frozenPrompt || '' })
    composer.update({ pendingAttempt: null })
    if (message) next.update({ notice: { id: 'creation-failed', tone: 'error', title: 'Couldn’t start this chat.', details: message } })
    currentComposer.current = next
    setDraftComposer(next)
    setActivePreview(null)
    setChatOpenFailed(false); setChatOpenError(''); setRecoveryWait(false)
    navigate(surface === 'home' ? 'home' : 'chat')
  }

  async function inspectCreation(key: string) {
    const result = await w.chats.inspectCreation(key)
    if (!isCurrentComposer()) return
    setChatOpenFailed(false); setChatOpenError(''); setRecoveryWait(false)
    if (result.state === 'failed') {
      editFailedDraft(result.error || 'The provider rejected this request. Review its setup and send again.')
    } else if (result.state === 'created' && result.chat) {
      const attempt = composer.getSnapshot().pendingAttempt
      if (attempt?.op === 'chat-create') {
        const draft = attempt.draft ?? { ...draftStore.getSnapshot(), prompt: attempt.frozenPrompt ?? draftStore.getSnapshot().prompt }
        draftStore.set(draft)
        composer.update({ pendingAttempt: null, preparedMessage: { text: attempt.frozenPrompt ?? draft.prompt, draft } })
      }
      setNotice('Conversation found. Your message is kept; review settings if needed, then send.', 'info', true)
    } else {
      setNotice(result.state === 'creating' ? 'Starting your conversation…' :
        result.error || 'Conversation creation is unconfirmed. Check its status before continuing.',
        result.state === 'creating' ? 'info' : 'warning', true)
    }
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
      modelChoice: { profileId, value: model, label: modelOptions.find(option => option.id === model)?.label, backend: effectiveBackend },
      // Draft defaults may be unknown, and live sessions expose controls that
      // cannot be applied when creating another conversation.
      settings: activeChat ? Object.fromEntries(modelSettings.filter(option => option.type === 'boolean' ||
        configOptions(option).some(choice => choice.value === option.currentValue))
        .map(option => [option.id, option.currentValue])) : { ...configuration.settings } })
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

  async function chatAction(operation: () => Promise<void>, propagate = false) {
    if (!composer.begin('actionBusy')) {
      if (propagate) throw new Error('Another action is in progress. Try again when it finishes.')
      return
    }
    try { await operation() }
    catch (error) { setError(error); if (propagate) throw error }
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
      else if (snapshot.terminal?.error) setError(snapshot.terminal.error)
      else if (!release && snapshot.terminal?.status === 'queued') setNotice('The terminal will be available after this turn finishes.')
    })
  }

  function renderHistory() {
    return <div className="command-history workspace-sidebar__content">
      <WorkspaceSidebarHeader title="Chats" actions={<ChatSearch search={w.chats.search}
        localItems={history.map(item => ({ chatId: item.id, itemId: null, title: item.prompt.split('\n')[0],
          project: item.project, profile: item.agent, excerpt: [item.prompt, labelText(item.labels)].join(' ') }))} onSelect={async result => {
        const item = history.find(preview => preview.id === result.chatId)
        if (!item || item.chat) await w.chats.openMatch(result.chatId, result.itemId)
        if (item) openPreview(item)
        else { setHistoryOpen(false); navigate(`chat/${result.chatId}`) }
      }} />} />
      <WorkspaceSidebarActions>
        <Button variant="ghost" className="workspace-sidebar__action chat-new-conversation" aria-label="New chat" onPress={newConversation}><Icon name="pencil" /><span>New chat</span></Button>
      </WorkspaceSidebarActions>
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
  const fastEnabled = !speedSetting?.defaultUnknown && (speedSetting?.currentValue === true || ['fast', 'priority'].includes(String(speedSetting?.currentValue).toLowerCase()))
  const effortValue = effortSetting?.defaultUnknown ? 'Provider default' : typeof effortSetting?.currentValue === 'string' && !['', 'auto', 'default'].includes(effortSetting.currentValue.toLowerCase()) ?
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
    if (!terminalCommands && usesAppServer && (!activeChat?.commandsState || ['error', 'loading'].includes(activeChat.commandsState))) {
      for (const shortcut of modelSettingShortcuts.filter(item => !settingGroups.some(group => group.id === item.id))) {
        const discover = () => { if (catalogDraft) { discovery.check(); return }; void prepareCommands().then(snapshot => {
          if (!snapshot || !isCurrentComposer() || snapshot.commandsState === 'loading') return
          if (!findModelSetting(snapshot.sessionConfig, snapshot.availableCommands, shortcut.id))
            setNotice(`This session does not advertise ${shortcut.label.toLowerCase()} options.`, 'warning')
        }) }
        mentionGroups.push({ ...shortcut, options: [], browseOnly: true,
          loading: catalogDraft ? discovery.loading : commandsLoading || activeChat?.commandsState === 'loading', error: catalogDraft ? discovery.error : commandsError || activeChat?.commandsError,
          onOpen: commandsError || activeChat?.commandsError ? undefined : discover, onRetry: discover,
        })
      }
    }
  }

  function sessionSetting(option: SessionConfig) {
    const change = (value: string | boolean) => {
      setComposerOptionsOpen(false)
      void changeSessionConfig(option.id, value)
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
    (sessionModel ? activeTurn : modelLocked || Boolean(!terminalFallback && backendOption && !backendOption.controls.model)) || w.agents.status !== 'connected'
  function discoveryStatus(label: string, hasChoices: boolean) {
    if (nativeModelDiscovery && label === 'models') return <div className="command-model-discovery" role="group" aria-label="Model discovery">
      {modelCatalog.loading ? <p role="status">Loading models…</p> : modelCatalog.error ?
        <p role="status">Couldn’t load models: {modelCatalog.error}</p> :
        !hasChoices ? <p role="status">This provider has not supplied any models.</p> :
        profile?.provider === 'claude' ? <p>Claude Code resolves these model aliases for your signed-in account.</p> : null}

    </div>
    if (!catalogDraft) return null
    const needsSession = effectiveBackend.endsWith('-acp') && !hasChoices
    const copilotDraft = label === 'models' && effectiveBackend === 'copilot-acp' && needsSession
    const copilotSdk = w.agents.catalog?.backends?.find(row => row.id === 'copilot-sdk')
    const setupReason = readiness?.ready === false ? readiness.reason || 'Set up this profile before starting a chat.' :
      backendOption?.available === false ? backendOption.reason || 'This backend needs setup.' : ''
    const message = w.agents.status !== 'connected' ? 'Connect to the local runtime to load available choices.' :
      setupReason || (discovery.loading ? hasChoices ? '' : `Loading ${label}…` : discovery.error ? `Couldn’t load ${label}: ${discovery.error}` :
      !hasChoices ? copilotDraft ? 'Copilot ACP does not provide a model list before a conversation starts. Use Copilot SDK to choose a model now.' :
        needsSession ? `This connection hasn’t supplied available ${label}.` : `This provider has not supplied any ${label}.` : '')
    return <div className="command-model-discovery" role="group" aria-label={`${label === 'models' ? 'Model' : 'Setting'} discovery`}>
      {message && <p role="status">{message}</p>}
      {hasChoices && discovery.error && !discovery.loading && <p>Showing previously discovered choices.</p>}
      {copilotDraft && !setupReason && !discovery.loading && <Button variant="ghost" size="sm"
        disabled={busy || Boolean(pendingAttempt) || w.agents.status !== 'connected'} onPress={() => {
          if (!copilotSdk?.available) { navigate('agents/providers?provider=copilot'); return }
          setBackendChoice('copilot-sdk'); setModelChoice({ profileId: agent, value: '' }); setResources({}); composer.configure({ settings: {} })
          if (profile?.automatic) { const explicit = w.profiles.find(row => row.provider === 'copilot'); if (explicit) setAgent(explicit.id) }
        }}>{copilotSdk?.available ? 'Use Copilot SDK' : 'Set up Copilot SDK'}</Button>}
      {label !== 'models' && (!needsSession || discovery.error) && <Button variant="ghost" size="sm" onPress={discovery.refresh}
        disabled={discovery.loading || w.agents.status !== 'connected' || Boolean(setupReason)}>
        Refresh settings
      </Button>}
    </div>
  }
  const commandSettings: Record<string, ComposerCommandSetting> = Object.create(null)
  for (const command of availableCommands) {
    if (command.execution !== 'setting' && !(command.execution === 'client' && command.action === 'model')) continue
    const option = configurableSettings?.find(row => row.id === command.configId)
    if (command.name === 'model' || option?.category === 'model') {
      commandSettings[command.name.toLowerCase()] = {
        label: 'Model', options: modelOptions, disabled: modelDisabled,
        loading: modelCatalog.loading && modelOptions.length <= 1, error: modelCatalog.error,
        onSelect: value => sessionModel ? void changeSessionConfig(sessionModel.id, value) : setModelChoice({ profileId: agent, value }),
        status: discoveryStatus('models', modelCatalog.models.length > 0 || configOptions(sessionModel).length > 0),
      }
      continue
    }
    const choices = option?.type === 'boolean' ? [{ value: 'true', name: 'On' }, { value: 'false', name: 'Off' }] : configOptions(option)
    const loading = (catalogDraft ? discovery.loading : commandsLoading || activeChat?.commandsState === 'loading') && !choices.length
    const error = catalogDraft ? discovery.error : commandsError || activeChat?.commandsError
    commandSettings[command.name.toLowerCase()] = {
      label: option?.name ?? command.name, options: choices.map(row => ({ id: row.value, label: row.name })),
      disabled: settingsDisabled || !option || ['offline', 'uncertain'].includes(activeChat?.status ?? ''), loading, error,
      onSelect: value => { if (option) void changeSessionConfig(option.id, option.type === 'boolean' ? value === 'true' : value) },
      status: catalogDraft ? discoveryStatus('setting choices', choices.length > 0) : !choices.length && <div className="command-model-discovery">
        <p role="status">{loading ? 'Loading setting choices…' : error || 'This session has not supplied any choices for this setting.'}</p>
        <Button variant="ghost" size="sm" onPress={() => { void prepareCommands() }}
          disabled={loading || w.agents.status !== 'connected'}>Refresh settings</Button>
      </div>,
    }
  }
  const composerTheme = useThemeAttributes()
  const composerSettings = (
    <ModalOverlay {...composerTheme} className="bbb-theme bbb-modal-overlay" isDismissable isOpen={composerOptionsOpen} onOpenChange={setComposerOptionsOpen}>
      <Modal className="bbb-modal">
        <AriaDialog className="bbb-dialog chat-composer-settings-dialog">
          <div className="bbb-dialog__header">
            <div className="bbb-dialog__heading">
              <Heading slot="title">Chat settings</Heading>
              <Button variant="ghost" size="sm" iconOnly aria-label="Close dialog" onPress={() => setComposerOptionsOpen(false)}><Icon name="x" /></Button>
            </div>
          </div>
          <div className="bbb-dialog__body">
            <Tabs className="chat-composer-settings" defaultSelectedKey={sessionMode || followupOptions ? 'conversation' : managedProfile || accessSettings.length ? 'access' : 'advanced'}>
              <TabList aria-label="Chat settings sections" className="chat-settings-tabs">
                {(sessionMode || followupOptions) && <Tab id="conversation" className="chat-settings-tab">Conversation</Tab>}
                {(managedProfile || accessSettings.length > 0) && <Tab id="access" className="chat-settings-tab">Permissions</Tab>}
                {managedProfile && !activeChat?.deviceId && (backendOption?.controls.resources !== false || backendOption?.controls.suiteTools) && <Tab id="tools" className="chat-settings-tab">Tools</Tab>}
                {((managedProfile && !activeChat?.deviceId) || advancedSettings.length > 0) && <Tab id="advanced" className="chat-settings-tab">Advanced</Tab>}
              </TabList>
              {(sessionMode || followupOptions) && <TabPanel id="conversation" className="chat-settings-section">
                {sessionMode && sessionSetting(sessionMode)}
                {followupOptions && <ComposerPicker label="Message timing" showValue value={effectiveFollowupMode}
                  options={timingOptions} disabled={messageTimingDisabled}
                  onChange={value => { setFollowupMode(value as 'steer' | 'queue'); setComposerOptionsOpen(false) }} />}
              </TabPanel>}
              {(managedProfile || accessSettings.length > 0) && <TabPanel id="access" className="chat-settings-section">
                {accessSettings.map(option => sessionSetting(option))}
                {!accessSettings.length && policyChat && (policyChat.permissionMode || policyChat.accessMode || policyChat.approvalPolicy) && <dl className="chat-settings-summary">
                  {(policyChat.permissionMode || policyChat.accessMode) && <><dt>Access</dt><dd>{permissionLabel(conversationPermission(policyChat))}</dd></>}
                  {policyChat.approvalPolicy && <><dt>Approval policy</dt><dd>{policyChat.approvalPolicy === 'never' ? 'Never ask' : 'On request'}</dd></>}
                </dl>}
                {!accessSettings.length && !modelLocked && !terminalFallback && backendOption?.controls.access && <ComposerPicker label="Access" showValue value={backendAccess}
                  disabled={busy || Boolean(pendingAttempt)} onChange={setBackendAccess} options={[
                    { id: 'read-only', label: 'Read only' }, { id: 'workspace-write', label: 'Workspace · ask before changes' },
                    { id: 'workspace-auto', label: 'Workspace · allow changes' }, { id: 'full-access', label: 'Full access' },
                  ]} />}
                {!accessSettings.length && !policyChat?.permissionMode && !policyChat?.accessMode && !policyChat?.approvalPolicy && (terminalFallback || modelLocked || !backendOption?.controls.access) &&
                  <p className="chat-settings-note">Uses the provider’s access and approval defaults.</p>}
              </TabPanel>}
              {managedProfile && !activeChat?.deviceId && (backendOption?.controls.resources !== false || backendOption?.controls.suiteTools) && <TabPanel id="tools" className="chat-settings-section">
                {!modelLocked && <div className="chat-tools-controls">
                  <div className="chat-settings-row">
                    <label className="chat-tools-toggle"><span>Suite tools</span><input type="checkbox" role="switch" aria-label="Suite tools"
                      checked={backendOption?.controls.suiteTools === false ? false : suiteTools}
                      disabled={backendOption?.controls.suiteTools === false || busy || Boolean(pendingAttempt)} onChange={event => setSuiteTools(event.target.checked)} /></label>
                    <Tooltip content="Includes conversation and workflow tools. Terminal launch requires full access."><Button variant="ghost" size="sm" iconOnly aria-label="About Suite tools"><Icon name="info" /></Button></Tooltip>
                  </div>
                  {backendOption?.controls.suiteTools === false && <p className="chat-settings-note" role="status">Suite tools are unavailable for this connection.</p>}
                  {suiteTools && profile.provider === 'opencode' && <>
                    <p className="chat-settings-note">Delegation requires a Codex worker.</p>
                    <label>Worker environment <select value={configuration.toolWorkerEnvironmentId ?? ''}
                      disabled={busy || Boolean(pendingAttempt)} onChange={event => composer.configure({ toolWorkerEnvironmentId: event.target.value })}>
                      <option value="">Select a Codex worker</option>
                      {w.agents.catalog?.profiles.filter(item => item.provider === 'codex' && item.environment_id).map(item =>
                        <option key={item.id} value={item.environment_id}>{item.profile}</option>)}
                    </select></label>
                    <label>Worker access <select value={configuration.toolWorkerPermissionMode ?? 'read-only'}
                      disabled={busy || Boolean(pendingAttempt)} onChange={event => composer.configure({ toolWorkerPermissionMode: event.target.value })}>
                      {['read-only', 'workspace-write', 'workspace-auto', 'full-access'].map(value => <option key={value} value={value}>{value}</option>)}
                    </select></label>
                  </>}
                  {backendOption?.controls.resources !== false && <ResourcePickerView {...resourcePickerProps} state={resourcePicker} compact />}
                </div>}
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
                  </> : backendOption?.controls.legacyMcpSelection === false ? <p>Select managed MCP definitions under Resources.</p> : <McpServerList agents={w.agents} provider={profile!.provider as 'codex' | 'opencode'}
                    value={selectedMcpServers} onChange={setMcpServers}
                    disabled={busy || Boolean(pendingAttempt) || w.agents.status !== 'connected'} />}
                </Dialog>
              </TabPanel>}
              {((managedProfile && !activeChat?.deviceId) || advancedSettings.length > 0) && <TabPanel id="advanced" className="chat-settings-section">
                {advancedSettings.map(option => sessionSetting(option))}
                {managedProfile && !activeChat?.deviceId && (w.agents.catalog?.backends?.filter(row => row.provider === profile?.provider).length ?? 0) + (profile?.provider === 'codex' ? 1 : 0) > 1 && <ComposerPicker label="Connection" showValue
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
                  <summary>Diagnostics</summary>
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
              </TabPanel>}
            </Tabs>
          </div>
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  )

  const identityControls = <div className="command-composer-identity">
      <ComposerPicker label="Provider" icon="bot" value={providerChoice} showValue showChevron={false}
        options={providerOptions} onChange={selectProvider}
        displayValue={profile ? providerName(profile.provider) : w.agents.loading ? 'Loading providers…' : 'No providers available'}
        disabled={busy || voice.engaged || Boolean(pendingAttempt) || modelLocked || !providerOptions.length} />
      <ComposerPicker
        label="Profile"
        icon="user-round"
        showValue
        showChevron={false}
        value={conversationProfileId ?? agent}
        disabled={busy || voice.engaged || Boolean(pendingAttempt) || modelLocked || !agentOptions.length}
        displayValue={!agentOptions.length ? 'No profiles available' : undefined}
        onChange={selectAgent}
        options={agentOptions}
      />
    </div>

  const modelPicker = <ChatModelPicker
    value={model}
    displayValue={!model && defaultModelLabel ? defaultModelLabel : undefined}
    summary={modelSummary}
    disabled={busy || Boolean(pendingAttempt)}
    modelDisabled={modelDisabled}
    open={modelOptionsOpen}
    onOpenChange={open => { setModelOptionsOpen(open); if (open && catalogDraft) discovery.check() }}
    onChange={value => sessionModel ? changeSessionConfig(sessionModel.id, value, false) : setModelChoice({ profileId: agent, value })}
    options={modelOptions}
    refresh={(nativeModelDiscovery || catalogDraft && (!effectiveBackend.endsWith('-acp') || modelCatalog.models.length > 0 || discovery.error)) &&
      <Tooltip content="Refresh models"><Button variant="ghost" size="sm" iconOnly aria-label="Refresh models"
        disabled={(nativeModelDiscovery ? modelCatalog.loading : discovery.loading) || w.agents.status !== 'connected' || !nativeModelDiscovery && (readiness?.ready === false || backendOption?.available === false)}
        onPress={nativeModelDiscovery ? modelCatalog.refresh : discovery.refresh}><Icon name="refresh-cw" /></Button></Tooltip>}
    footer={<Button variant="ghost" size="sm" onPress={() => { setModelOptionsOpen(false); setComposerOptionsOpen(true) }}><Icon name="settings" />Chat settings</Button>}
    responseSettings={{ options: modelSettings, speed: speedSetting, effort: effortSetting, disabled: settingsDisabled,
      onChange: (id, value) => { void changeSessionConfig(id, value, false) },
      onReset: catalogDraft ? () => {
        const settings = { ...configuration.settings }
        for (const option of modelSettings) delete settings[option.id]
        composer.configure({ settings })
      } : undefined,
    }}
  >
    {discoveryStatus('models', modelCatalog.models.length > 0 || configOptions(sessionModel).length > 0)}
  </ChatModelPicker>

  const composerDialogs = <>
    {composerSettings}
    {mentionResources.dialog}
    {claudeMigration.dialog}
      <CommandDialog key={commandPanel?.kind === 'input' ? commandPanel.command.name : commandPanel?.kind ?? 'closed'}
        panel={commandPanel?.kind === 'terminal' && commandPanel.target === 'new' ? { ...commandPanel,
          canOpen: w.agents.status === 'connected' && !busy && !pendingAttempt && resourcesValid } : commandPanel}
        onClose={() => { setCommandPanel(null); requestAnimationFrame(() => promptRef.current?.focus()) }} onCommand={command => { setCommandPanel(null); chooseCommand(command) }}
        onChat={id => { setCommandPanel(null); navigate(`chat/${id}`) }}
        onTerminal={() => {
          const newTerminal = commandPanel?.kind === 'terminal' && commandPanel.target === 'new'
          setCommandPanel(null)
          if (newTerminal) {
            if (!composer.begin('sending')) return
            setNotice(''); void launchNativeTerminal(undefined, true)
          } else void terminalAction()
        }}
        onInsert={text => { setCommandPanel(null); draftStore.set({ ...draftStore.getSnapshot(), prompt: text }); requestAnimationFrame(() => promptRef.current?.focus()) }}
        onArguments={(command, value) => { setCommandPanel(null); void submitCommand('/' + command.name + ' ' + value) }} />
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
      {terminalSetupOpen && <SessionForm inline={false} agents={w.agents} projects={w.projects.projects}
        initialProfile={catalogProfile} initialCwd={selectedProject?.path}
        initialModel={modelChoice.profileId === agent ? modelChoice.value : undefined}
        onClose={() => setTerminalSetupOpen(false)} navigate={route => { setTerminalSetupOpen(false); navigate(route) }} />}
  </>

  const composerNotices: ComposerStatusNotice[] = []
  const creationActions = failedCreation ? creationAlternatives.map(backend => ({
    label: `Start new chat with ${backend.label}`, disabled: busy || voice.engaged, onPress: () => startWithBackend(backend.id),
  })) : []
  const currentNotice = notice && !notice.setup && (notice.tone === 'warning' || notice.tone === 'error') && (!notice.scope || notice.scope === noticeScope) ? notice : null
  if (currentNotice && (!pendingAttempt || busy)) composerNotices.push({ ...currentNotice,
    ...(currentNotice.tone === 'error' && !pendingAttempt ? { actions: [{ label: 'Check status', disabled: busy,
      onPress: () => { if (activeChat) void chatAction(async () => { await w.chats.open(activeChat.id) }); else void w.agents.refresh() } }, ...creationActions] } : {}),
  })
  if (showConnectionNotice) composerNotices.push({
    id: 'connection', label: 'Chat connection', className: transportUnavailable ? 'command-workspace-connection' : undefined,
    tone: connectionWarning ? 'error' : needsChatRecovery ? 'warning' : 'info', blocking: true, priority: -1,
    title: connectionWarning ? 'Chat connection unavailable.' :
      `${w.agents.status === 'connecting' && !w.agents.error && !connectionAttempt ? 'Connecting…' : 'Reconnecting…'}${connectionAttempt ? ` Attempt ${connectionAttempt} of 3.` : ''}`,
    description: connectionWarning ? 'We couldn’t reconnect after 3 attempts. Your draft and saved messages are kept.' : undefined,
    details: connectionWarning ? connectionError ?? undefined : undefined, detailsLabel: 'Connection details',
    actions: connectionWarning ? [
      { label: transportUnavailable ? 'Retry connection' : 'Retry chat connection', onPress: () => {
        if (transportUnavailable) w.agents.connect(); else chatRecovery.retry()
      } },
      ...(activePreview?.chat && !managedBackend ? [{ label: 'Open in terminal', onPress: () => reportRecovery({ kind: 'open', chatId: activePreview.id }) }] : []),
      ...(activeChat?.backendCapabilities?.operations.restore_session?.supported && !transportUnavailable ? [{ label: 'Resume saved session', disabled: busy,
        onPress: () => { void chatAction(async () => {
          await w.agents.request('chat-backend-resume', { chatId: activeChat.id, key: requestId() })
          await w.chats.open(activeChat.id)
        }) } }] : []),
    ] : undefined,
  })
  if (managedProfile && !usesAppServer && w.carrier.status !== 'connected') composerNotices.push({
    id: 'carrier-connection', label: 'Inbox connection', tone: w.carrier.retryRequired ? 'error' : 'info', priority: -1,
    title: w.carrier.retryRequired ? 'Inbox connection unavailable.' : w.carrier.status === 'offline' && !w.carrier.error ? 'Inbox disconnected.' : 'Connecting to your inbox…',
    details: w.carrier.error || undefined,
    actions: w.carrier.status === 'offline' ? [{ label: 'Retry inbox connection', onPress: () => w.carrier.connect() }] : undefined,
  })
  if (pendingAttempt && !busy) composerNotices.push({
    id: currentNotice ? currentNotice.id : 'pending-request', tone: 'error', title: currentNotice?.title ?? 'The request outcome is unconfirmed.',
    description: currentNotice?.description ?? 'Inspect the outcome before continuing. Retry request keeps the original operation.',
    details: currentNotice?.details,
    actions: [
      ...creationActions,
      ...(w.agents.status === 'connected' && (pendingAttempt.op === 'chat-create' || activeChat) ? [{ label: 'Inspect outcome', disabled: busy,
        onPress: () => { void chatAction(async () => {
          if (pendingAttempt.op === 'chat-create') await inspectCreation(String(pendingAttempt.args.key))
          else if (activeChat) await w.chats.open(activeChat.id)
        }) } }] : []),
      ...(activeChat && pendingAttempt.op === 'chat-config-set' && !['running', 'waiting', 'uncertain', 'offline'].includes(activeChat.status) &&
        activeChat.sessionConfig?.some(option => option.id === pendingAttempt.args.configId && option.currentValue === pendingAttempt.args.value) ? [{
          label: 'Continue with confirmed settings', disabled: busy, onPress: () => {
            if (!pendingAttempt.preserveDraft) draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [], fileReferences: [] })
            setPendingAttempt(null); setNotice('Continue with the confirmed session settings.', 'success', true)
          },
        }] : []),
      ...(activeChat?.turnId && ['completed', 'failed', 'interrupted'].includes(activeChat.status) ? [{
        label: 'Continue conversation', disabled: busy, onPress: () => {
          setPendingAttempt(null); draftStore.set({ ...draftStore.getSnapshot(), prompt: '', inboxReferences: [] })
          setNotice('Continue with the messages shown in this conversation.', 'success', true)
        },
      }] : []),
    ],
  })
  if (failedCreation && !currentNotice && !pendingAttempt) composerNotices.push({
    id: 'failed-creation', label: 'Choose another chat backend', tone: 'error', title: 'Couldn’t start this chat.', details: activeChat?.error || undefined,
    actions: [{ label: 'Edit draft', onPress: () => editFailedDraft(activeChat?.error ?? undefined) }, ...creationActions],
  })
  if (activeChat?.status === 'uncertain' && !needsChatRecovery && !pendingAttempt && !busy) composerNotices.push({
    id: 'conversation-outcome', tone: 'warning', title: 'The conversation outcome is unconfirmed.',
    actions: [
      { label: 'Inspect conversation', disabled: w.agents.status !== 'connected', onPress: () => { void chatAction(async () => {
        if (creationIncomplete) await inspectCreation(activeChat.id)
        else await w.chats.open(activeChat.id)
      }) } },
      ...(activeChat.backendCapabilities?.operations.restore_session?.supported ? [{ label: 'Resume saved session', disabled: w.agents.status !== 'connected', onPress: () => {
        void chatAction(async () => { await w.agents.request('chat-backend-resume', { chatId: activeChat.id, key: requestId() }); await w.chats.open(activeChat.id) })
      } }] : []),
    ],
  })
  if (terminalFallback) composerNotices.push({
    id: 'terminal-fallback', label: 'Continue in terminal', tone: 'warning',
    title: selectedReadiness?.terminal?.code === 'claude_migration_required' ? 'Claude needs a login migration before opening the terminal.' :
      `${providerName(profile!.provider)} will open in Terminals with your message.`,
    description: selectedReadiness?.terminal?.code === 'claude_migration_required' ? 'Submit your message to review the migration and continue in Claude’s terminal.' :
      selectedReadiness?.terminal?.signInRequired ? 'You can finish sign-in and setup in the provider’s terminal. Your message will be passed to that session.' :
      'Interactive chat is unavailable for this profile. You can continue in the provider’s terminal.',
    actions: [
      { label: 'Configure chat credentials', onPress: () => navigate(`agents/profiles?provider=${encodeURIComponent(catalogProfile!.provider)}&profile=${encodeURIComponent(catalogProfile!.id)}`) },
      { label: 'Open terminal', disabled: busy || Boolean(pendingAttempt) || Boolean(draftStore.getSnapshot().prompt.trim() && !canSubmit),
        onPress: () => { if (draftStore.getSnapshot().prompt.trim()) void submit(); else setTerminalSetupOpen(true) } },
    ],
  })
  if (!retainedChat && !terminalFallback && readiness?.ready === false) composerNotices.push({
    id: 'readiness', label: 'Profile setup required', tone: 'warning', blocking: true,
    title: readiness.reason || 'This profile needs setup before starting a chat.',
    actions: [
      { label: readiness.code === 'credential_required' ? 'Configure chat credentials' : 'Review provider setup',
        onPress: () => navigate(readiness.code === 'credential_required' && catalogProfile ?
          `agents/profiles?provider=${encodeURIComponent(catalogProfile.provider)}&profile=${encodeURIComponent(catalogProfile.id)}` : 'agents/providers') },
      ...(selectedReadiness?.terminal?.ready ? [{ label: 'Open terminal', onPress: () => setTerminalSetupOpen(true) }] : []),
    ],
  })
  if (!creationIncomplete && activeChat?.initialConfiguration && activeChat.initialConfiguration.state !== 'ready') composerNotices.push({
    id: 'initial-settings', label: 'Review initial settings', tone: 'warning', blocking: true, title: 'Confirm conversation settings before sending.',
    actions: [
      { label: 'Review settings', disabled: settingsDisabled, onPress: () => { setComposerOptionsOpen(true); void prepareCommands() } },
      { label: 'Use current session settings', disabled: settingsDisabled, onPress: () => { void chatAction(async () => {
        await w.chats.confirmConfiguration({ key: requestId(), chatId: activeChat.id })
        setNotice('Current session settings confirmed. You can send your message.', 'success')
      }) } },
    ],
  })
  if ((!terminalFallback && invalidDraftSettings.length > 0) || !resourcesValid) composerNotices.push({
    id: 'draft-settings', label: 'Draft settings unavailable', tone: 'warning', blocking: true,
    title: !resourcesValid ? resourceValidationMessage : 'Some draft settings are unavailable.',
    actions: [{ label: 'Review settings', onPress: () => setComposerOptionsOpen(true) }],
  })
  if (!modelLocked && !terminalFallback && readiness?.ready !== false && backendOption && !backendOption.available) composerNotices.push({
    id: 'backend-unavailable', label: 'Agent setup required', tone: 'warning', blocking: true, title: 'Selected backend is unavailable.', description: backendOption.reason,
    actions: [
      { label: 'Change backend', onPress: () => setComposerOptionsOpen(true) },
      { label: 'Review provider setup', onPress: () => navigate('agents/providers') },
    ],
  })
  if (!modelLocked && !providerOptions.length && w.agents.catalog && !w.agents.loading) composerNotices.push({
    id: 'no-providers', label: 'Agent setup required', tone: 'warning', blocking: true, title: 'No providers are ready for chat.',
    actions: [
      { label: 'Refresh providers', disabled: w.agents.status !== 'connected', onPress: () => { void w.agents.refresh() } },
      { label: 'Set up a provider', onPress: () => navigate('agents/providers') },
    ],
  })
  if (catalogDraft && readiness?.ready !== false && discovery.error) composerNotices.push({
    ...composerError(discovery.cause, noticeScope), id: 'discovery', tone: 'warning', title: 'Couldn’t refresh models and settings.',
    description: 'Previously loaded choices are kept. You can also enter a custom model in Model settings.',
    actions: [{ label: 'Refresh discovery', onPress: discovery.refresh, disabled: discovery.loading || w.agents.status !== 'connected' }],
  })
  if (commandsError && !catalogDraft) composerNotices.push({
    id: 'commands', tone: 'warning', title: 'Couldn’t load provider commands.', details: commandsError,
    actions: [{ label: 'Refresh commands', disabled: commandsLoading || w.agents.status !== 'connected', onPress: () => { void prepareCommands() } }],
  })
  for (const message of pendingMessages.filter(message => message.status === 'failed')) composerNotices.push({
    ...composerError(message.error, noticeScope), id: `delivery:${message.id}`, title: message.uncertain ? 'Message delivery is unconfirmed.' : 'Message delivery failed.',
    description: 'Review the pending message above the composer. Its retry uses the original request.',
  })

  const composerContent = (
        <div className="command-compose-area">
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
          <VoicePanel voice={voice} />
          {activeChat && <QueuedMessages key={`queue:${activeChat.id}`} queue={activeChat.queue} chatId={activeChat.id}
            disabled={busy || Boolean(activeChat.syncing) || Boolean(pendingAttempt) || w.agents.status !== 'connected' || voice.engaged}
            onEdit={w.chats.editQueued} onRemove={w.chats.removeQueued} onResume={w.chats.resumeQueue} />}
          {pendingMessages.some(message => message.status !== 'sending') && <section aria-label="Pending messages">
            {messagesPaused && <p role="status">Pending messages paused after Stop.</p>}
            {pendingMessages.filter(message => message.status !== 'sending').map(message => <div key={message.id}>
              <p>{message.text}</p>
              {message.status === 'waiting' && <p role="status">Waiting to send…</p>}
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
          {sessionMode?.currentValue === 'plan' && <div className="command-composer-context" aria-label="Conversation context">
            {sessionMode?.currentValue === 'plan' && <span>Plan</span>}
          </div>}
          {activeChat && !terminalFallback && <BackgroundActivity key={`background:${activeChat.id}`} chat={activeChat}
            supported={w.agents.capabilities.backgroundActivity && activeChat.chatCapabilities?.background === true}
            connected={w.agents.status === 'connected' && activeChat.status !== 'offline' && !activeChat.syncing} launches={w.chats.launches[activeChat.id] ?? []}
            load={w.chats.background} inspectAgent={w.chats.backgroundAgent} stopProcess={w.chats.stopBackground}
            inspectProcess={w.chats.backgroundProcess}
            onAnswer={(id, values) => chatAction(() => w.chats.answer({ key: requestId(), chatId: activeChat.id, requestId: id, ...values }), Boolean(values.answers))}
            onOpenChat={id => { revealHistoryItem(id); navigate(`chat/${id}`) }} />}
          <ChatComposer
            draft={draftStore}
            inputRef={promptRef}
            placeholder={executionMonitor ? 'Give the supervisor a direction…' : mode === 'chat' ? 'Ask anything…' : 'Describe the work…'}
            request={w.carrier.request}
            connection={w.carrier.status}
            context={!voice.engaged && (!terminalFallback || Boolean(terminalCommands)) ? { agents: w.agents, project: filesProject, mailboxes: w.carrier.mailboxes, scope: `${composerScope}:${agent}:${effectiveBackend}:${filesProject?.id ?? ''}`,
              commands: availableCommands, commandsState: terminalCommands ? 'ready' : commandsLoading ? 'loading' : !usesAppServer ? 'unsupported' : activeChat?.commandsState ?? (draftCommands ? 'ready' : undefined),
              commandsError: catalogDraft ? discovery.error : commandsError || activeChat?.commandsError, onCommandsOpen: () => { void prepareCommands() }, onChooseCommand: chooseCommand,
              settings: commandSettings } : undefined}
            mentionGroups={mentionGroups}
            readOnly={sending || Boolean(pendingAttempt)}
            canSubmit={canSubmit}
            canRunCommand={Boolean((activeChat && usesAppServer || terminalCommands) && !busy && !activeChat?.syncing && !pendingAttempt && !voice.engaged && w.agents.status === 'connected')}
            canBrowseSettings={(catalogDraft || Boolean(terminalCommands)) && !busy && !pendingAttempt && !voice.engaged && w.agents.status === 'connected'}
            sending={sending || pendingMessages.some(message => message.status === 'sending')}
            retrying={Boolean(pendingAttempt)}
            sendLabel={sendLabel}
            sendOptions={followupOptions && activeTurn ? [{ id: effectiveFollowupMode, label: sendLabel }] : undefined}
            stop={activeChat && activeTurn ? {
              label: executionMonitor ? 'Pause supervision' : 'Stop',
              disabled: actionBusy || w.agents.status !== 'connected',
              onPress: () => { void chatAction(async () => {
                composer.pauseMessages()
                if (executionMonitor) await w.command.mutate('command-pause', { key: requestId(), monitorId: executionMonitor.id })
                else await w.chats.interrupt({ key: requestId(), chatId: activeChat.id, expectedTurnId: activeChat.turnId })
              }) },
            } : undefined}
            onSubmit={() => { void submit() }}
            notices={composerNotices.map(notice => ({ ...notice, scope: notice.scope ?? noticeScope }))}
            projectSelected={Boolean(filesProject?.name || draftProject)}
            projectSelectionDisabled={isRemoteChat || voice.engaged}
            projectControl={<ComposerPicker label="Project" icon="folder" showValue showChevron={false}
              value={filesProject?.id ?? (draftProject ? selectedProject?.id ?? '@legacy' : '')}
              displayValue={filesProject?.name ?? draftProject}
              summary={activePreview ? ' · Changing project starts a new chat' : ''}
              options={projectOptions} onChange={selectProjectOption}
              disabled={isRemoteChat || busy || Boolean(pendingAttempt) || voice.engaged} />}
            identityControls={identityControls}
            options={modelPicker}
            actions={<>
                {(usesAppServer || voice.engaged) && !activeChat?.deviceId && !managedBackend && <VoiceButton voice={voice} onStart={startVoice}
                  disabled={terminalFallback || busy || Boolean(pendingAttempt) || w.agents.status !== 'connected' || terminalIsActive(activeChat?.terminal) ||
                    Boolean(activePreview?.chat && (!activeChat || ['offline', 'uncertain'].includes(activeChat.status)))} />}
            </>}
          />
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
      <WorkspaceTheme><WorkspaceSidebar id="chat-sidebar" className="command-history-sidebar" aria-label="Chat history sidebar" hidden={sidebarCollapsed} inert={sidebarCollapsed || undefined}>
        {renderHistory()}
      </WorkspaceSidebar></WorkspaceTheme>
      <div className="command-content">
      <div className="command-toolbar">
        <div className="command-toolbar-start">
          <span className="chat-desktop-sidebar-toggle"><SidebarToggle collapsed={sidebarCollapsed} controls="chat-sidebar"
            buttonRef={sidebarToggleRef} onToggle={() => setSidebarCollapsed((value) => !value)} /></span>
          <Sheet
            title="Chat history"
            side="start"
            bodyClassName="workspace-sidebar-sheet-body command-history-sheet-body"
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
          {!activePreview && <Tooltip content="Remote chat"><Button variant="ghost" size="sm" iconOnly aria-label="Remote chat" disabled={busy || w.agents.status !== 'connected'} onPress={() => setRemoteChatOpen(true)}><Icon name="monitor" /></Button></Tooltip>}
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
          {activePreview && <ConversationInfo key={activePreview.id} conversation={activeChat ?? { title: conversationTitle, profile: activePreview.agent, project: activePreview.project, model: activePreview.model }}
            agents={w.agents} chatId={activeChat?.id}
            disabled={actionBusy || w.agents.status !== 'connected'} connected={w.agents.status === 'connected'}
            onDetach={activeChat ? () => chatAction(() => w.chats.detach({ key: requestId(), chatId: activeChat.id })) : undefined}
            onOpenTerminal={activeChat && !activeChat.deviceId && !managedBackend ? () => terminalAction() : undefined}
            onReleaseTerminal={activeChat && !activeChat.deviceId && !managedBackend ? () => terminalAction(true) : undefined} />}
        </div>
      </div>

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
        {activeChat ? <LiveConversation onReadLatest={w.chats.markRead} agentActions={agentActions} agents={w.agents} navigate={navigate} key={activeChat.id} chat={activeChat} disabled={actionBusy || activeChat.syncing || w.agents.status !== 'connected'}
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
          onAnswer={(requestIdValue, values) => chatAction(() => w.chats.answer({ key: requestId(), chatId: activeChat.id, requestId: requestIdValue, ...values }), Boolean(values.answers))} /> : activePreview?.chat ?
          <section className="command-conversation" aria-label="Agent conversation">
            {connectionWarning ? <p>Reconnect to load this conversation.</p>
              : currentNotice ? <p>Review the request status in the composer.</p> : <PageLoading label="Opening your conversation…" size="panel" />}
          </section> : activePreview ? (
          <section className="command-conversation" aria-label={activeRun ? 'Agent conversation' : mode === 'chat' ? 'Chat preview' : 'Work draft preview'}>
            <div className="command-user-message"><span className="command-message-label">You</span><MessageContent text={activePreview.prompt} /></div>
            {activeRun ? <div className="command-transcript" role="log" aria-label="Conversation messages" aria-live="polite">
              {conversation?.messages.filter((item) => item.id !== String(initialSend?.message_id)).map((item) => {
                const incoming = item.direction === 'incoming'
                return <article className={`command-chat-message command-chat-message--${incoming ? 'agentMessage' : 'userMessage'}`} key={item.id} aria-label={incoming ? `${activeRun.profile} message` : 'Your message'}>
                  {incoming && <div className="command-assistant-heading"><Mark small /><strong>{activeRun.profile}</strong></div>}
                  {!incoming && <span className="command-message-label">You</span>}
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
