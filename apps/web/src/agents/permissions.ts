export const permissionModes = [
  { id: 'read-only', label: 'Read-only', description: 'Inspect and report without editing files.' },
  { id: 'workspace-write', label: 'Workspace write', description: 'Edit within the project and request approvals when needed.' },
  { id: 'workspace-auto', label: 'Workspace automatic', description: 'Edit within the project without approval prompts. Blocked operations remain blocked.' },
  { id: 'full-access', label: 'Full access / YOLO', description: 'Run without the agent sandbox or approval prompts. Operating system permissions still apply.' },
] as const

export type PermissionMode = typeof permissionModes[number]['id']
export const spawnDefaultModes = [...permissionModes, { id: 'manual', label: 'Manual', description: 'Require an explicit access mode for each launch, the whole workflow, or every stage.' }] as const
export type SpawnDefaultMode = PermissionMode | 'manual'
export type SpawnSettings = { defaultMode: SpawnDefaultMode; revision: number }
export type ApprovalSettings = { autoApprove: boolean; revision: number }
export function permissionLabel(mode: PermissionMode) {
  return permissionModes.find((option) => option.id === mode)?.label ?? mode
}
export function conversationPermission(conversation: { permissionMode?: PermissionMode | null; accessMode?: string | null; approvalPolicy?: string | null }): PermissionMode {
  return conversation.permissionMode ?? (conversation.accessMode === 'read-only' ? 'read-only'
    : conversation.accessMode === 'danger-full-access' ? 'full-access'
      : conversation.approvalPolicy === 'never' ? 'workspace-auto' : 'workspace-write')
}
