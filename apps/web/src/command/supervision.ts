import type { Monitor } from './model'

export const supervisionActive = (monitor: Monitor) => !['completed', 'cancelled'].includes(monitor.state)
export const supervisionLabel = (monitor: Monitor) => ({ scheduled: 'Supervising', running: 'Supervising', waiting: 'Supervising', needs_input: 'Needs you', paused: 'Paused', completed: 'Completed', cancelled: 'Stopped' }[monitor.state])
export const supervisionChat = (monitor: Monitor) => monitor.conversationChatId || monitor.sourceChatId || monitor.supervisorChatId
export const supervisionRoute = (monitor: Monitor) => supervisionChat(monitor)
  ? `chat/${supervisionChat(monitor)}/supervision/${monitor.id}` : `chat/supervision/${monitor.id}`
export function chatSupervision(monitors: Monitor[], chatId?: string) {
  return chatId ? monitors.filter(monitor => supervisionChat(monitor) === chatId || monitor.supervisorChatId === chatId)
    .sort((a, b) => Number(supervisionActive(b)) - Number(supervisionActive(a)) || Number(b.state === 'needs_input') - Number(a.state === 'needs_input') || b.createdAt - a.createdAt) : []
}
