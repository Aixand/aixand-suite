import { readStorage } from './storage'
import { useEffect, useState } from 'react'

export type WorkflowStatus = 'Ready' | 'Running' | 'Paused' | 'Completed'
export type Workflow = {
  id: string
  name: string
  prompt: string
  steps: string[]
  status: WorkflowStatus
  completed: number
  createdAt: string
  template: string
}

export const templates = [
  {
    id: 'release',
    name: 'Prepare a release',
    icon: 'box' as const,
    description: 'Build, verify, and ship with confidence.',
    prompt:
      'Prepare a release candidate. Review the changes, run the test suite, and draft release notes.',
    steps: [
      'Inspect project',
      'Build application',
      'Run test suite',
      'Review changes',
      'Prepare release notes',
    ],
  },
  {
    id: 'review',
    name: 'Review my code',
    icon: 'layers' as const,
    description: 'A fresh perspective on your changes.',
    prompt:
      'Review the latest changes for correctness, accessibility, and maintainability. Summarize actionable findings.',
    steps: [
      'Read the changes',
      'Check correctness',
      'Review accessibility',
      'Summarize findings',
    ],
  },
  {
    id: 'docs',
    name: 'Refresh documentation',
    icon: 'file-text' as const,
    description: 'Bring your docs up to speed.',
    prompt:
      'Audit the project documentation, identify outdated guidance, and prepare reviewed updates.',
    steps: [
      'Audit documentation',
      'Identify gaps',
      'Draft updates',
      'Review documentation',
    ],
  },
]

const initial: Workflow[] = [
  {
    id: 'release-demo',
    name: 'Release candidate validation',
    prompt: templates[0].prompt,
    steps: templates[0].steps,
    status: 'Paused',
    completed: 2,
    createdAt: '2026-09-21T10:30:00Z',
    template: 'Release',
  },
  {
    id: 'docs-demo',
    name: 'Documentation refresh',
    prompt: templates[2].prompt,
    steps: templates[2].steps,
    status: 'Ready',
    completed: 0,
    createdAt: '2026-09-20T09:00:00Z',
    template: 'Documentation',
  },
  {
    id: 'review-demo',
    name: 'Accessibility review',
    prompt: templates[1].prompt,
    steps: templates[1].steps,
    status: 'Completed',
    completed: 4,
    createdAt: '2026-09-19T15:30:00Z',
    template: 'Code review',
  },
]

export const storageKey = 'aixand.workflows.v1'
function validWorkflow(value: unknown): value is Workflow {
  if (!value || typeof value !== 'object') return false
  const w = value as Workflow
  return (
    typeof w.id === 'string' &&
    typeof w.name === 'string' &&
    typeof w.prompt === 'string' &&
    typeof w.template === 'string' &&
    typeof w.createdAt === 'string' &&
    Number.isFinite(Date.parse(w.createdAt)) &&
    Array.isArray(w.steps) &&
    w.steps.length > 0 &&
    w.steps.length <= 20 &&
    w.steps.every((s) => typeof s === 'string' && s.trim().length > 0) &&
    ['Ready', 'Running', 'Paused', 'Completed'].includes(w.status) &&
    Number.isInteger(w.completed) &&
    w.completed >= 0 &&
    w.completed <= w.steps.length &&
    (w.status !== 'Completed' || w.completed === w.steps.length)
  )
}

function readWorkflows() {
  try {
    const raw = readStorage(storageKey)
    if (!raw) return initial
    const parsed: unknown = JSON.parse(raw)
    if (
      !Array.isArray(parsed) ||
      !parsed.every(validWorkflow) ||
      new Set(parsed.map((w) => w.id)).size !== parsed.length
    )
      return initial
    // A browser reload pauses simulation rather than suggesting a server is running.
    return parsed.map((w) => ({
      ...w,
      status: w.status === 'Running' ? ('Paused' as const) : w.status,
    }))
  } catch {
    return initial
  }
}

export function useWorkflows() {
  const [workflows, setWorkflows] = useState<Workflow[]>(readWorkflows)
  const [storageError, setStorageError] = useState(false)
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(workflows))
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }, [workflows])
  useEffect(() => {
    const timer = window.setInterval(() => {
      setWorkflows((current) =>
        current.some((w) => w.status === 'Running')
          ? current.map((w) => {
              if (w.status !== 'Running') return w
              const completed = Math.min(w.completed + 1, w.steps.length)
              return {
                ...w,
                completed,
                status: completed === w.steps.length ? 'Completed' : 'Running',
              }
            })
          : current,
      )
    }, 6000)
    return () => window.clearInterval(timer)
  }, [])
  const update = (
    id: string,
    patch: Partial<Pick<Workflow, 'name' | 'steps' | 'status' | 'completed'>>,
  ) => {
    setWorkflows((current) =>
      current.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    )
  }
  const create = (prompt: string, templateId: string) => {
    const template = templates.find((t) => t.id === templateId)
    const workflow: Workflow = {
      id: crypto.randomUUID(),
      name: template?.name ?? prompt.trim().split('\n')[0].slice(0, 80),
      prompt: prompt.trim(),
      template: template ? template.name : 'Custom workflow',
      steps: [
        ...(template?.steps ?? [
          'Understand the request',
          'Plan the approach',
          'Execute the work',
          'Verify the result',
          'Summarize the outcome',
        ]),
      ],
      status: 'Ready',
      completed: 0,
      createdAt: new Date().toISOString(),
    }
    setWorkflows((current) => [workflow, ...current])
    return workflow.id
  }
  return { workflows, update, create, storageError }
}

export const statusTone = (status: WorkflowStatus) =>
  status === 'Completed'
    ? ('success' as const)
    : status === 'Running'
      ? ('accent' as const)
      : status === 'Paused'
        ? ('warning' as const)
        : ('neutral' as const)
export const formatDate = (date: string) =>
  new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(
    new Date(date),
  )
