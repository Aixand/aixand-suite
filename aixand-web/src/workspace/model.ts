import { useState } from 'react'
import { useAgents } from '../agents/model'
import { useCarrier } from '../carrier/model'
import { useChats } from '../chats/model'
import { useProjects } from '../projects/model'
import { createChatComposers } from '../chats/composer'
import { useCommand } from '../command/model'

type ChatProfile = {
  id: string
  name: string
  label?: string
  role: string
  provider: string
  model: string
  instructions: string
  automatic?: boolean
  preferred?: boolean
  ready?: boolean
  reason?: string | null
}
export type Task = {
  id: string
  prompt: string
  project: string
  agent: string
  status: string
}
export type Message = {
  id: string
  title: string
  source: string
  body: string
  read: boolean
  archived: boolean
}
export function useWorkspace() {
  const agents = useAgents()
  const command = useCommand(agents)
  const chats = useChats(agents)
  const projects = useProjects(agents)
  const carrier = useCarrier()
  const profiles = [...new Map((agents.catalog?.profiles ?? []).map((profile) =>
    [`${profile.provider}/${profile.profile}`, profile])).values()]
  const availableProfileIds = new Set(profiles.filter(profile => {
    if (profile.preferred) return true
    if ((profile.readiness?.chat?.ready ?? profile.readiness?.ready) === false) return false
    const backends = agents.catalog?.backends?.filter(row => row.provider === profile.provider) ?? []
    if (backends.length) return backends.some(row => row.available)
    const capability = agents.catalog?.capabilities.find(row => row.provider === profile.provider)
    // Older catalogs omit readiness and backend metadata; honor their installation flag when present.
    return capability?.installed ?? profile.readiness?.ready ?? true
  }).map(profile => `${profile.provider}/${profile.profile}`))
  const registeredProfiles = new Map<string, ChatProfile>()
  for (const profile of [...profiles, ...carrier.profiles]) {
    const id = `${profile.provider}/${profile.profile}`
    if (!availableProfileIds.has(id)) continue
    const managed = profiles.find(row => row.id === id)
    if (!registeredProfiles.has(id)) registeredProfiles.set(id, {
      id, name: profile.profile, role: `${profile.provider} profile`,
      provider: profile.provider, model: profile.model ?? 'Default', instructions: '',
      preferred: managed?.preferred,
      ready: managed?.readiness?.chat?.ready ?? managed?.readiness?.ready,
      reason: managed?.readiness?.chat?.reason,
    })
  }
  const choices: ChatProfile[] = [...registeredProfiles.values()]
  if (choices.some(profile => profile.provider === 'codex')) choices.unshift({
    id: '@auto:codex', name: 'Auto', role: 'Codex · highest available budget',
    provider: 'codex', model: 'Default', instructions: '', automatic: true,
  })
  const chatProfiles = choices.map((choice) => ({ ...choice,
    label: !choice.automatic && choices.some((other) => other.id !== choice.id && other.name.toLowerCase() === choice.name.toLowerCase())
      ? `${choice.name} (${choice.id})` : choice.name,
  }))
  const [tasks, setTasks] = useState<Task[]>([])
  const messages = carrier.homeMessages
  const [activeMessage, setActiveMessage] = useState('')
  const [chatComposers] = useState(createChatComposers)
  return {
    activeMessage,
    setActiveMessage,
    profiles,
    agents,
    command,
    carrier,
    chats,
    projects,
    chatProfiles,
    tasks: [...tasks, ...carrier.runs.filter((run) => run.mode === 'work').map((run) => ({
      id: run.key, prompt: run.prompt, project: run.project, agent: run.profile,
      status: run.task_status ?? run.status,
    })), ...chats.chats.filter((chat) => chat.mode === 'work').map((chat) => ({
      id: chat.id, prompt: chat.title, project: chat.project, agent: chat.profile, status: chat.status,
    }))],
    setTasks,
    messages,
    chatComposers,
  }
}
export type Workspace = ReturnType<typeof useWorkspace>
