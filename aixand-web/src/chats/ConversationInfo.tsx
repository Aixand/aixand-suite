import { ResourceReportView } from '../agents/ResourcePicker'
import { Button, Icon, Tooltip, useThemeAttributes } from 'bbb-design'
import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogTrigger, Heading, Popover } from 'react-aria-components'
import type { ChatSnapshot } from './model'
import { terminalIsActive } from './model'
import { McpConnections, McpSummary } from '../agents/mcp'
import type { AgentsModel } from '../agents/model'
import { visibleLabels } from '../terminals/context'
import { conversationPermission, permissionLabel } from '../agents/permissions'

type Details = Pick<ChatSnapshot, 'title' | 'profile'> & Partial<Pick<ChatSnapshot,
  'project' | 'model' | 'cwd' | 'accessMode' | 'permissionMode' | 'approvalPolicy' | 'originChatId' | 'parentChatId' | 'parentTitle' | 'terminal' | 'mcp' | 'labels' | 'deviceId' | 'device' | 'backend' | 'backendRoute' | 'resourceSnapshotRef' | 'resourceReport' | 'applicationPreset'>>

export function ConversationInfo({ conversation, disabled, connected, onDetach, onOpenTerminal, onReleaseTerminal, agents, chatId }: {
  conversation: Details
  disabled: boolean
  connected: boolean
  agents?: AgentsModel
  chatId?: string
  onDetach?: () => Promise<void>
  onOpenTerminal?: () => Promise<void>
  onReleaseTerminal?: () => Promise<void>
}) {
  const theme = useThemeAttributes()
  const parentId = conversation.parentChatId === undefined ? conversation.originChatId : conversation.parentChatId
  const terminal = conversation.terminal
  const terminalActive = terminalIsActive(terminal)
  const [metadata, setMetadata] = useState<Record<string, string> | null>(null)
  const [metadataError, setMetadataError] = useState('')
  const [metadataLoading, setMetadataLoading] = useState(false)
  const [updatingTools, setUpdatingTools] = useState(false)
  const [toolsError, setToolsError] = useState('')
  const toolsAttempt = useRef<{ chatId: string; key: string } | null>(null)
  const currentChat = useRef(chatId)
  currentChat.current = chatId
  useEffect(() => { setMetadata(null); setMetadataError(''); setMetadataLoading(false) }, [chatId])
  const loadMetadata = async () => {
    if (!agents || !chatId) return
    setMetadataLoading(true)
    setMetadataError('')
    try {
      const result = await agents.request<{ metadata: Record<string, string> }>('chat-metadata', { chatId })
      if (currentChat.current === chatId) setMetadata(result.metadata)
    } catch (error) { if (currentChat.current === chatId) setMetadataError(error instanceof Error ? error.message : 'Could not load metadata') }
    finally { if (currentChat.current === chatId) setMetadataLoading(false) }
  }

  return <DialogTrigger>
    <Tooltip content="Conversation information">
      <Button variant="ghost" size="sm" iconOnly className="command-info-button" aria-label="Conversation information"><Icon name="info" /></Button>
    </Tooltip>
    <Popover {...theme} placement="bottom end" className="bbb-theme bbb-floating-surface command-info-popover">
      <Dialog className="command-info-dialog">
        {({ close }) => <>
          <div className="command-info-heading">
            <Heading slot="title">Conversation information</Heading>
            <Button variant="ghost" size="sm" iconOnly aria-label="Close conversation information" onPress={close}><Icon name="x" /></Button>
          </div>
          <p className="command-info-title">{conversation.title}</p>
          <dl className="command-chat-context">
            <dt>Agent</dt><dd>{conversation.profile}</dd>
            {conversation.backend && <><dt>Backend</dt><dd>{conversation.backend}</dd></>}
            {conversation.backendRoute === 'managed' && !conversation.accessMode && <><dt>Access</dt><dd>Adapter defaults</dd></>}
            {conversation.resourceSnapshotRef && <><dt>Resource snapshot</dt><dd>{conversation.resourceSnapshotRef}</dd></>}
            {conversation.device && <><dt>Device</dt><dd>{conversation.device}</dd></>}
            {conversation.project && <><dt>Project</dt><dd>{conversation.project}</dd></>}
            {conversation.model && <><dt>Model</dt><dd>{conversation.model}</dd></>}
            {conversation.project && conversation.cwd && <><dt>Directory</dt><dd>{conversation.cwd}</dd></>}
            {(conversation.permissionMode || conversation.accessMode) && <><dt>Access</dt><dd>{permissionLabel(conversationPermission(conversation))}</dd></>}
            {conversation.originChatId && !parentId && <><dt>Session</dt><dd>Independent session</dd></>}
          </dl>
          {visibleLabels(conversation.labels).length > 0 && <div className="tw-context-labels" aria-label="Conversation labels">
            {visibleLabels(conversation.labels).map(([key, value]) => <span key={key} title={`${key}=${value}`}>{key}: {value}</span>)}
          </div>}
          {agents && chatId && <div className="command-info-metadata">
            {metadata === null && <Button variant="ghost" size="sm" disabled={disabled || !connected || metadataLoading} onPress={() => { void loadMetadata() }}>{metadataLoading ? 'Loading metadata…' : 'Show metadata'}</Button>}
            {metadataError && <p role="alert">{metadataError}</p>}
            {metadata !== null && <><strong>Metadata</strong>{Object.keys(metadata).length ? <dl className="command-chat-context">
              {Object.entries(metadata).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
            </dl> : <p>No metadata</p>}</>}
          </div>}
          <ResourceReportView report={conversation.resourceReport} />
          {conversation.applicationPreset && <p>Default resources: {conversation.applicationPreset.id}</p>}
          {conversation.applicationPreset && agents && chatId && !conversation.deviceId && conversation.backendRoute !== 'managed' && <Button variant="ghost" size="sm" disabled={disabled || !connected || updatingTools} onPress={() => {
            setUpdatingTools(true); setToolsError('')
            if (toolsAttempt.current?.chatId !== chatId) toolsAttempt.current = { chatId, key: crypto.randomUUID() }
            void agents.request('suite-tools-refresh', toolsAttempt.current).then(() => { toolsAttempt.current = null }).catch((error: Error) => setToolsError(error.message)).finally(() => setUpdatingTools(false))
          }}>{updatingTools ? 'Updating tools…' : 'Update Suite tools'}</Button>}
          {toolsError && <p role="alert">{toolsError}</p>}
          <McpSummary snapshot={conversation.mcp} />
          {agents && chatId && !conversation.deviceId && <McpConnections agents={agents} chatId={chatId} disabled={disabled} />}
          {parentId && <div className="command-parent-session" role="group" aria-label="Parent session">
            <span>Started from</span><a href={`#/chat/${parentId}`} title={conversation.parentTitle ?? 'Parent session'} onClick={close}>{conversation.parentTitle ?? 'Parent session'}</a>
            {onDetach && <Button variant="ghost" size="sm" disabled={disabled} onPress={() => { void onDetach() }}>Detach</Button>}
          </div>}
          {onOpenTerminal && <div className="command-info-terminal" role="group" aria-label="Conversation terminal">
            <Button variant="ghost" size="sm" disabled={disabled || !connected} onPress={() => { void onOpenTerminal().then(close) }}>
              {terminalActive ? terminal?.sessionId ? 'Open terminal' : 'Inspect terminal' : 'Spawn terminal'}
            </Button>
            {terminalActive && onReleaseTerminal && <Button variant="ghost" size="sm" disabled={disabled || !connected || terminal?.status === 'releasing'} onPress={() => { void onReleaseTerminal().then(close) }}>{terminal?.status === 'queued' ? 'Cancel terminal request' : 'Stop terminal client'}</Button>}
          </div>}
        </>}
      </Dialog>
    </Popover>
  </DialogTrigger>
}
