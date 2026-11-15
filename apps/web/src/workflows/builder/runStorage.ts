import { compileSequence } from './compile'
import type { CanvasDraft } from './model'

export const RUN_KEY = 'aixand.workflow.run.v1'
export const runStorageKey = (workflowId: string) => `${RUN_KEY}:${workflowId}`

/** Keep the old record intact, and recover it only for the matching canvas. */
export function migrateSavedRun(workflowId: string, draft: CanvasDraft) {
  try {
    const key = runStorageKey(workflowId)
    if (localStorage.getItem(key) !== null) return
    const source = localStorage.getItem(RUN_KEY)
    if (source && JSON.stringify(JSON.parse(source).workflow) ===
      JSON.stringify(compileSequence(draft).workflow))
      localStorage.setItem(key, source)
  } catch {
    // An incomplete canvas or unavailable monitoring record still opens normally.
  }
}
