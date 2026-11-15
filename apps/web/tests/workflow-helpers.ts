import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { LIBRARY_KEY, SEQUENTIAL_WORKFLOW_ID } from '../src/workflows/library'
import type { CanvasDraft } from '../src/workflows/builder/model'

export async function savedCanvasSource(page: Page, id = SEQUENTIAL_WORKFLOW_ID) {
  return page.evaluate(({ key, id }) => {
    const library = JSON.parse(localStorage.getItem(key) || 'null')
    const workflow = library?.workflows.find((item: { id: string }) => item.id === id)
    return workflow ? JSON.stringify(workflow.draft, null, 2) : null
  }, { key: LIBRARY_KEY, id })
}
export async function savedCanvas(page: Page, id = SEQUENTIAL_WORKFLOW_ID): Promise<CanvasDraft> {
  const source = await savedCanvasSource(page, id)
  expect(source).not.toBeNull()
  return JSON.parse(source!)
}
