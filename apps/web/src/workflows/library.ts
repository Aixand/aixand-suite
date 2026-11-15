import { useCallback, useEffect, useRef, useState } from 'react'
import {
  blankDraft, createCanvasId, DRAFT_KEY, parseDraft, PREVIOUS_DRAFT_KEY,
  sequentialDraft, brainImplementerDraft, projectAuditDraft, migrateBrainImplementerDraft, serializeDraft, UnsupportedNodesError,
} from './builder/model'
import type { CanvasDraft } from './builder/model'
import { migrateSavedRun } from './builder/runStorage'

export const LIBRARY_KEY = 'aixand.workflow.library.v1'
export const LIBRARY_BACKUP_KEY = 'aixand.workflow.library.previous.v1'
export const SEQUENTIAL_WORKFLOW_ID = 'sequential-hello'
export const BRAIN_IMPLEMENTER_WORKFLOW_ID = 'brain-implementer'
export const PROJECT_AUDIT_WORKFLOW_ID = 'project-audit-example'
export type WorkflowTemplate = 'blank' | 'brain-implementer' | 'project-audit' | 'native-chat'
export const LEGACY_WORKFLOW_ID = 'saved-canvas'
export type SavedWorkflow = {
  id: string
  createdAt: string
  updatedAt: string
  draft: CanvasDraft
}

function serializeLibrary(workflows: SavedWorkflow[]) {
  return JSON.stringify({ format: 'aixand.workflow-library', version: 1, workflows })
}
function readLibrary() {
  const now = new Date().toISOString()
  const seed: SavedWorkflow = {
    id: SEQUENTIAL_WORKFLOW_ID, createdAt: now, updatedAt: now, draft: sequentialDraft(),
  }
  const carrierSeed: SavedWorkflow = {
    id: BRAIN_IMPLEMENTER_WORKFLOW_ID, createdAt: now, updatedAt: now, draft: brainImplementerDraft(),
  }
  const auditSeed: SavedWorkflow = {
    id: PROJECT_AUDIT_WORKFLOW_ID, createdAt: now, updatedAt: now,
    draft: { ...projectAuditDraft(), name: 'Architecture + security → tasks → Main inbox' },
  }
  let source: string | null = null
  let legacy: string | null = null
  try {
    source = localStorage.getItem(LIBRARY_KEY)
    if (source !== null) {
      const value = JSON.parse(source)
      if (value?.format !== 'aixand.workflow-library' || value.version !== 1 ||
        !Array.isArray(value.workflows)) throw new Error('Invalid workflow library')
      const ids = new Set<string>()
      let migrated = false
      const workflows: SavedWorkflow[] = value.workflows.map((item: SavedWorkflow) => {
        if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
          typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' ||
          !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt)))
          throw new Error('Invalid saved workflow')
        ids.add(item.id)
        const saved = parseDraft(JSON.stringify(item.draft))
        const draft = migrateBrainImplementerDraft(saved)
        const changed = draft !== saved || item.draft.mode !== undefined
        migrated ||= changed
        return {
          id: item.id, createdAt: item.createdAt, updatedAt: changed ? now : item.updatedAt, draft,
        }
      })
      if (!ids.has(BRAIN_IMPLEMENTER_WORKFLOW_ID)) workflows.push(carrierSeed)
      if (!ids.has(PROJECT_AUDIT_WORKFLOW_ID)) workflows.push(auditSeed)
      return { workflows, notice: '', writeInitial: source !== serializeLibrary(workflows), backup: migrated ? source : null, legacyBackup: null, migrateRuns: false }
    }
    legacy = localStorage.getItem(DRAFT_KEY)
    const draft = legacy ? parseDraft(legacy) : seed.draft
    const workflows = draft.name === seed.draft.name
      ? [{ ...seed, draft }, carrierSeed, auditSeed]
      : [seed, { ...seed, id: LEGACY_WORKFLOW_ID, draft }, carrierSeed, auditSeed]
    return { workflows, notice: '', writeInitial: true, backup: null, legacyBackup: null, migrateRuns: true }
  } catch (cause) {
    return {
      workflows: [seed, carrierSeed, auditSeed],
      notice: source !== null
        ? 'Your saved workflow list could not be read. Sequential hello is available, and the saved data is kept for recovery.'
        : cause instanceof UnsupportedNodesError
          ? 'Your previous canvas uses unsupported steps. Sequential hello is available, and the previous canvas is kept for recovery.'
          : 'Your saved workflow could not be read. Sequential hello is available, and the saved data is kept for recovery.',
      writeInitial: source === null,
      backup: source,
      legacyBackup: cause instanceof UnsupportedNodesError ? legacy : null,
      migrateRuns: source === null,
    }
  }
}

export function useWorkflowLibrary() {
  const [initial] = useState(readLibrary)
  const [workflows, setWorkflows] = useState(initial.workflows)
  const current = useRef(workflows)
  const backup = useRef(initial.backup)
  const [storageError, setStorageError] = useState('')

  const persist = useCallback((next: SavedWorkflow[]) => {
    try {
      if (backup.current !== null) {
        localStorage.setItem(LIBRARY_BACKUP_KEY, backup.current)
        backup.current = null
      }
      localStorage.setItem(LIBRARY_KEY, serializeLibrary(next))
      setStorageError('')
    } catch {
      const message = 'Browser storage is unavailable. Export your workflow to keep your changes.'
      setStorageError(message)
      throw new Error(message)
    }
  }, [])

  useEffect(() => {
    try {
      if (initial.writeInitial) persist(current.current)
      if (initial.legacyBackup !== null)
        localStorage.setItem(PREVIOUS_DRAFT_KEY, initial.legacyBackup)
    } catch {
      // The library remains usable in memory and shows the storage error.
    }
    if (initial.migrateRuns)
      for (const workflow of initial.workflows) migrateSavedRun(workflow.id, workflow.draft)
  }, [initial, persist])

  const save = useCallback((id: string, draft: CanvasDraft) => {
    const next = current.current.map((workflow) => workflow.id === id
      ? { ...workflow, draft: parseDraft(serializeDraft(draft)), updatedAt: new Date().toISOString() }
      : workflow)
    current.current = next
    setWorkflows(next)
    persist(next)
  }, [persist])

  const create = useCallback((name: string, template: WorkflowTemplate = 'blank') => {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 120) throw new Error('Enter a workflow name of up to 120 characters.')
    const now = new Date().toISOString()
    const workflow: SavedWorkflow = {
      id: createCanvasId(), createdAt: now, updatedAt: now,
      draft: { ...(template === 'project-audit' ? projectAuditDraft() : template === 'brain-implementer' ? brainImplementerDraft() : template === 'native-chat' ? blankDraft() : blankDraft()), name: trimmed },
    }
    const next = [...current.current, workflow]
    persist(next)
    current.current = next
    setWorkflows(next)
    return workflow.id
  }, [persist])

  return { workflows, save, create, storageError, notice: initial.notice }
}
