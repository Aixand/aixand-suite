import type { Chat } from '../chats/model'

export function supportsWorkflows(chat: Chat): boolean {
  if (!chat.workspaceTools || chat.originChatId) return false
  return chat.backendRoute === 'managed' ? chat.chatCapabilities?.workflows === true : true
}

export function usesToolApprovals(chat?: Pick<Chat, 'backend' | 'chatCapabilities'>): boolean {
  return chat?.chatCapabilities?.workflowApprovalMode === 'tool-approvals'
    || !!chat?.backend && chat.backend !== 'native-codex'
}
