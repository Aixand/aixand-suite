import { expect, test } from './fixtures'
import type { Page, WebSocketRoute } from './fixtures'
import AxeBuilder from '@axe-core/playwright'

const draftId = 'a'.repeat(64),
  releaseId = 'b'.repeat(64)
const digest = `sha256:${'c'.repeat(64)}`,
  changedDigest = `sha256:${'d'.repeat(64)}`

for (const theme of ['light', 'dark']) {
test(`${theme} prompt releases expose explicit assignment and preserve focus`, async ({ page }) => {
  await page.addInitScript(mode => localStorage.setItem('aixand.appearance', mode), theme)
  const { requests } = await fixture(page)
  await page.goto(`/#/agents/prompts?pack=${releaseId}&prompt=review&file=sections%2Freview.md`)
  await expect(page.getByLabel('Prompt content')).toHaveText('Original released instructions.')
  await page.screenshot({ path: test.info().outputPath(`prompt-overview-${theme}.png`) })
  const assign = page.getByRole('button', { name: 'Assign to profile', exact: true })
  await expect(assign).toBeVisible()
  if (theme === 'dark') await expect(page.getByRole('button', { name: /Prompt revision/ })).toBeHidden()
  await assign.click()
  const dialog = page.getByRole('dialog', { name: 'Assign review to a profile', exact: true })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(assign).toBeFocused()
  expect(requests.some(row => row.op === 'prompts-bind')).toBe(false)
  await assign.click()
  await dialog.getByRole('button', { name: /Consumer profile/ }).click()
  await page.getByRole('option', { name: 'Agent Manager · Codex / review', exact: true }).click()
  await dialog.getByRole('button', { name: 'Assign to profile', exact: true }).click()
  expect(requests.find(row => row.op === 'prompts-bind')?.args.expectedBindingDigest).toBe(digest)
  await page.getByText('Versions and source', { exact: true }).click()
  await page.getByRole('button', { name: /Prompt revision/ }).click()
  await page.getByRole('option', { name: 'Draft', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit review', exact: true })).toBeVisible()
  await expect(page.locator('.bbb-floating-surface')).toHaveCount(0)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
})
}

async function fixture(page: Page, conflict = false) {
  const requests: { op: string; args: Record<string, unknown> }[] = []
  let socketRoute: WebSocketRoute | undefined
  let sourceStatus = 'available'
  let sourceText = 'Review for {{ audience }}.',
    sourceDigest = digest
  const prompt = {
    name: 'review',
    description: 'Review requested changes.',
    inputs: { audience: { type: 'string', default: 'maintainers' } },
    instruction_compatible: true,
  }
  const pack = {
    name: 'agents',
    source: 'Prompt Manager',
    source_id: 'development',
    status: 'available',
    prompts: [
      prompt,
      {
        ...prompt,
        name: 'summarize',
        description: 'Summarize completed work.',
        inputs: {},
      },
    ],
    description: 'Agent instructions.',
  }
  await page.routeWebSocket('**/api/agents/ws', (socket) => {
    socketRoute = socket
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const request = JSON.parse(raw.toString())
      requests.push(request)
      const { op, args, id } = request
      const draft = {
        ...pack,
        status: sourceStatus,
        id: draftId,
        kind: 'draft',
        version: null,
        digest: sourceDigest,
      }
      const release = {
        ...pack,
        id: releaseId,
        kind: 'release',
        version: '1',
        reference: 'agents@1',
        digest,
      }
      const details = {
        entry: args?.packId === releaseId ? release : draft,
        release: { digest: args?.packId === releaseId ? digest : sourceDigest },
        manifest: {
          name: 'agents',
          prompts: { review: { sections: [{ section: 'review-task' }] } },
          sections: { 'review-task': { file: 'sections/review.md' } },
        },
        files: {
          'sections/summary-task.md': 'Summarize this task.',
          'sections/review.md':
            args?.packId === releaseId
              ? 'Original released instructions.'
              : sourceText,
        },
        dependencies: {},
      }
      let result: unknown = null
      if (op === 'prompts-catalog')
        result = {
          store: '/tmp/prompts',
          checked_at: new Date().toISOString(),
          sources: [
            { id: 'development', label: 'Prompt Manager', status: 'available' },
          ],
          packs: [draft, release],
          consumers: [
            {
              id: 'agent-manager-local',
              label: 'Agent Manager · Codex',
              status: 'available',
              profiles: [
                {
                  profile: 'review',
                  binding: { reference: 'agents@1/review', inputs: {} },
                  binding_digest: digest,
                },
              ],
              launches: [
                {
                  id: 'saved-launch',
                  profile: 'review',
                  status: 'bound',
                  reference: 'agents@1/review',
                  thread_id: 'saved-thread',
                  release: { digest },
                },
              ],
              total: 1,
              next_offset: null,
            },
          ],
        }
      else if (op === 'prompts-show') result = details
      else if (op === 'prompts-validate') result = { examples_passed: 2 }
      else if (op === 'prompts-preview')
        result = {
          output: [
            { role: 'system', content: `Review for ${args.inputs.audience}.` },
          ],
        }
      else if (op === 'prompts-save') {
        if (conflict) {
          socket.send(
            JSON.stringify({
              type: 'error',
              id,
              code: 'conflict',
              message:
                'Draft changed since it was opened; refresh before saving',
            }),
          )
          return
        }
        sourceText = args.text
        sourceDigest = changedDigest
        result = {
          ...details,
          release: { digest: sourceDigest },
          files: { 'sections/review.md': sourceText },
        }
      } else if (op === 'prompts-snapshot')
        result = {
          status: 'bound',
          thread_id: 'saved-thread',
          instructions: {
            reference: 'agents@1/review',
            developer_instructions: 'The original saved instructions.',
            provenance: { release: { digest } },
          },
        }
      else if (op === 'prompts-diff')
        result = { changed: true, definition_diff: '-Original\n+Edited' }
      else if (op === 'catalog')
        result = { profiles: [], auths: [], capabilities: [], cwd: '/tmp' }
      else if (op === 'sessions') result = { runs: [], runtimeError: null }
      else if (op === 'chat-list') result = []
      else if (op === 'project-list') result = []
      socket.send(JSON.stringify({ type: 'result', id, result }))
    })
  })
  return {
    requests,
    dropConnection() {
      socketRoute?.close({ code: 1011, reason: 'Simulated connection loss' })
    },
    changeDraft(text: string, invalid = false) {
      sourceText = text
      sourceDigest = changedDigest
      sourceStatus = invalid ? 'invalid' : 'available'
      socketRoute?.send(JSON.stringify({ type: 'prompts-changed' }))
    },
  }
}

function promptRow(page: Page, name: string) {
  return page
    .getByRole('treegrid', { name: 'Prompt tree', exact: true })
    .getByRole('row', { name, exact: true })
}

async function promptAction(page: Page, name: string) {
  if (name === 'Assign to profile') {
    await page.getByRole('button', { name, exact: true }).click()
    return
  }
  await page
    .getByRole('button', { name: 'Prompt actions', exact: true })
    .click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function pageView(page: Page, name: string) {
  await page.getByRole('button', { name: 'Prompts menu', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

test('starts with a read-only library, filters prompts and saves through the focused editor', async ({
  page,
}) => {
  const { requests } = await fixture(page)
  await page.goto('/#/prompts')
  await expect(promptRow(page, 'review')).toBeVisible()
  await expect(
    page.getByRole('button', { name: /^Collapse agents/ }),
  ).toHaveCount(1)
  await expect(page.locator('textarea')).toHaveCount(0)
  expect(requests.some((request) => request.op === 'prompts-show')).toBe(false)
  await page.getByRole('searchbox', { name: 'Search prompts' }).fill('review')
  await expect(promptRow(page, 'summarize')).toHaveCount(0)
  await promptRow(page, 'review').click()
  await expect(page.getByLabel('Prompt content')).toContainText(
    'Review for {{ audience }}.',
  )
  await expect(page.locator('textarea')).toHaveCount(0)
  await expect(page.getByLabel('Prompt content')).not.toContainText(
    'Summarize this task.',
  )
  await expect(page.getByText(digest, { exact: true })).not.toBeVisible()
  await page.getByRole('button', { name: 'Edit review', exact: true }).click()
  const editor = page.getByRole('region', { name: 'Edit review', exact: true })
  await editor
    .getByRole('textbox', { name: 'Prompt file contents', exact: true })
    .fill('Edited review instructions.')
  await editor
    .getByRole('button', { name: 'Save changes', exact: true })
    .click()
  await expect(editor).not.toBeVisible()
  await expect(page.getByLabel('Prompt content')).toHaveText(
    'Edited review instructions.',
  )
  await expect(
    page.getByRole('button', { name: 'Edit review', exact: true }),
  ).toBeFocused()
  expect(
    requests.find((request) => request.op === 'prompts-save')?.args
      .expectedDigest,
  ).toBe(digest)
  await promptAction(page, 'Publish pack')
  const publish = page.getByRole('dialog', {
    name: 'Publish agents pack',
    exact: true,
  })
  await publish.getByLabel('Release version').fill('2')
  await publish
    .getByRole('button', { name: 'Publish release', exact: true })
    .click()
  await expect(publish).not.toBeVisible()
  await expect(
    page.getByText('Published agents@2.', { exact: true }),
  ).toBeVisible()
  expect(
    requests.find((request) => request.op === 'prompts-release')?.args
      .expectedDigest,
  ).toBe(changedDigest)
  await expect(page.locator('.carrier-list-pane')).toBeVisible()
  await expect(
    page.getByRole('searchbox', { name: 'Search prompts' }),
  ).toHaveValue('review')
})

test('keeps unsaved edits when dismissing or switching files and returns to the library', async ({
  page,
}) => {
  const { requests } = await fixture(page)
  await page.goto('/#/prompts')
  await promptRow(page, 'review').click()
  await page.getByRole('button', { name: 'Edit review', exact: true }).click()
  const editor = page.getByRole('region', { name: 'Edit review', exact: true })
  await editor.getByRole('textbox', { name: 'Prompt file contents', exact: true }).fill('My unsaved edit.')
  await page.keyboard.press('Escape')
  const confirm = page.getByRole('alertdialog', {
    name: 'Discard your changes?',
    exact: true,
  })
  await expect(confirm).toBeVisible()
  await confirm
    .getByRole('button', { name: 'Keep editing', exact: true })
    .click()
  await expect(editor.getByRole('textbox', { name: 'Prompt file contents', exact: true })).toHaveText(
    'My unsaved edit.',
  )
  await editor.getByRole('button', { name: /sections\/review.md/ }).click()
  await page.getByRole('dialog', { name: 'Choose a file', exact: true }).getByRole('button', { name: 'pack.json', exact: true }).click()
  await expect(confirm).toBeVisible()
  await confirm
    .getByRole('button', { name: 'Keep editing', exact: true })
    .click()
  await expect(editor.getByRole('textbox', { name: 'Prompt file contents', exact: true })).toHaveText(
    'My unsaved edit.',
  )
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await confirm
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click()
  await expect(editor).not.toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Edit review', exact: true }),
  ).toBeFocused()
  await expect(promptRow(page, 'review')).toBeVisible()
  expect(requests.some((request) => request.op === 'prompts-save')).toBe(false)
})

test('preserves the opened revision across refreshes and conflicts, and inspects saved instructions', async ({
  page,
}) => {
  const { requests, changeDraft } = await fixture(page, true)
  await page.goto('/#/prompts')
  await promptRow(page, 'review').click()
  await page.getByRole('button', { name: 'Edit review', exact: true }).click()
  const editor = page.getByRole('region', { name: 'Edit review', exact: true })
  await editor.getByRole('textbox', { name: 'Prompt file contents', exact: true }).fill('My unsaved edit.')
  const count = requests.filter(
    (request) => request.op === 'prompts-catalog',
  ).length
  changeDraft('Changed by another editor.', true)
  await expect
    .poll(
      () =>
        requests.filter((request) => request.op === 'prompts-catalog').length,
    )
    .toBeGreaterThan(count)
  await expect(editor.getByRole('textbox', { name: 'Prompt file contents', exact: true })).toHaveText(
    'My unsaved edit.',
  )
  await editor
    .getByRole('button', { name: 'Save changes', exact: true })
    .click()
  await expect(editor.getByRole('alert')).toContainText('Draft changed')
  await expect(editor.getByRole('textbox', { name: 'Prompt file contents', exact: true })).toHaveText(
    'My unsaved edit.',
  )
  expect(
    requests.find((request) => request.op === 'prompts-save')?.args
      .expectedDigest,
  ).toBe(digest)
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Discard changes', exact: true })
    .click()
  await pageView(page, 'Used in sessions')
  await expect(page.getByText('saved-thread', { exact: true })).toBeVisible()
  await page
    .getByRole('button', {
      name: 'Inspect saved launch saved-launch',
      exact: true,
    })
    .click()
  await expect(page.getByLabel('Saved developer instructions')).toHaveText(
    'The original saved instructions.',
  )
})

test('previews, compares and assigns immutable releases through explicit actions', async ({
  page,
}) => {
  const { requests } = await fixture(page)
  await page.goto('/#/prompts')
  await promptRow(page, 'review').click()
  await page.getByText('Versions and source', { exact: true }).click()
  await page.getByRole('button', { name: /Prompt revision/ }).click()
  await page.getByRole('option', { name: 'Release 1', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Edit review', exact: true }),
  ).toHaveCount(0)
  await promptRow(page, 'review').click()
  await expect(page.getByLabel('Prompt content')).toHaveText(
    'Original released instructions.',
  )
  await expect(page.locator('textarea')).toHaveCount(0)
  await promptAction(page, 'Preview prompt')
  const preview = page.getByRole('dialog', {
    name: 'Preview review',
    exact: true,
  })
  await preview.getByLabel('audience', { exact: true }).fill('API maintainers')
  await preview
    .getByRole('button', { name: 'Render preview', exact: true })
    .click()
  await expect(page.getByLabel('Rendered prompt', { exact: true })).toHaveText(
    'Review for API maintainers.',
  )
  await preview.getByRole('button', { name: 'JSON', exact: true }).click()
  await preview.getByLabel('Preview inputs (JSON)').fill('invalid json')
  await preview
    .getByRole('button', { name: 'Render preview', exact: true })
    .click()
  await expect(preview.getByRole('alert')).toBeVisible()
  await preview.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Prompt actions', exact: true }),
  ).toBeFocused()
  await promptAction(page, 'Compare revisions')
  const compare = page.getByRole('dialog', {
    name: 'Compare pack revisions',
    exact: true,
  })
  await compare.getByRole('button', { name: /Compare with/ }).click()
  await page
    .getByRole('option', { name: 'Draft · Prompt Manager', exact: true })
    .click()
  await compare
    .getByRole('button', { name: 'Compare revisions', exact: true })
    .click()
  await expect(page.getByLabel('Revision diff')).toHaveText(
    '-Original\n+Edited',
  )
  await compare.getByRole('button', { name: 'Close', exact: true }).click()
  await promptAction(page, 'Assign to profile')
  const assign = page.getByRole('dialog', {
    name: 'Assign review to a profile',
    exact: true,
  })
  await assign.getByRole('button', { name: /Consumer profile/ }).click()
  await page
    .getByRole('option', {
      name: 'Agent Manager · Codex / review',
      exact: true,
    })
    .click()
  await assign
    .getByRole('button', { name: 'Assign to profile', exact: true })
    .click()
  await expect(assign).not.toBeVisible()
  expect(
    requests.find((request) => request.op === 'prompts-bind')?.args
      .expectedBindingDigest,
  ).toBe(digest)
  expect(
    requests.find((request) => request.op === 'prompts-bind')?.args.inputs,
  ).toEqual({ audience: 'maintainers' })
  await pageView(page, 'Assignments')
  await expect(page.getByText('agents@1/review', { exact: true })).toBeVisible()
  await page
    .getByRole('button', { name: 'Clear assignment for review', exact: true })
    .click()
  expect(
    requests.find((request) => request.op === 'prompts-unbind')?.args
      .expectedBindingDigest,
  ).toBe(digest)
})

test('supports narrow layouts, enlarged text, editor focus and accessible controls', async ({
  page,
}) => {
  await fixture(page)
  await page.goto('/#/prompts')
  await expect(promptRow(page, 'review')).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await page.addStyleTag({ content: 'html { font-size: 200%; }' })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await promptRow(page, 'review').click()
    await expect(page.locator('.carrier-list-pane')).not.toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: 'Edit review', exact: true }).click()
    const editor = page.getByRole('region', {
      name: 'Edit review',
      exact: true,
    })
    await expect(editor.getByRole('textbox', { name: 'Prompt file contents', exact: true })).toBeFocused()
    const save = editor.getByRole('button', {
      name: 'Save changes',
      exact: true,
    })
    await expect(save).toBeInViewport()
    expect(
      await editor.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true)
    await editor.getByRole('button', { name: 'Cancel', exact: true }).focus()
    await expect(editor.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.keyboard.press('Escape')
    await expect(editor).not.toBeVisible()
    await page
      .getByRole('button', { name: 'Back to prompts', exact: true })
      .click()
    await expect(promptRow(page, 'review')).toBeFocused()
  }
})

test('keeps preview inputs open while the read-only content refreshes', async ({
  page,
}) => {
  const { changeDraft } = await fixture(page)
  await page.goto('/#/prompts')
  await promptRow(page, 'review').click()
  await expect(page.getByLabel('Prompt content')).toBeVisible()
  await promptAction(page, 'Preview prompt')
  const preview = page.getByRole('dialog', {
    name: 'Preview review',
    exact: true,
  })
  await preview.getByLabel('audience', { exact: true }).fill('My audience')
  changeDraft('A refreshed draft.')
  await expect(page.getByLabel('Prompt content')).toHaveText(
    'A refreshed draft.',
  )
  await expect(preview.getByLabel('audience', { exact: true })).toHaveValue(
    'My audience',
  )
  await preview.getByRole('button', { name: 'Close', exact: true }).click()
  await promptAction(page, 'Validate pack')
  await expect(
    page.getByText('Pack is valid. 2 rendering examples passed.', {
      exact: true,
    }),
  ).toBeVisible()
  await pageView(page, 'Registered sources')
  const sources = page.getByRole('dialog', {
    name: 'Registered sources',
    exact: true,
  })
  await expect(
    sources.getByText('Prompt Manager', { exact: true }),
  ).toBeVisible()
  await sources.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Prompts menu', exact: true }),
  ).toBeFocused()
})

test('keeps prompt navigation attached to the rail while the reader changes and scrolls', async ({
  page,
}) => {
  const { changeDraft } = await fixture(page)
  await page.goto('/#/prompts')
  const review = promptRow(page, 'review')
  const summary = promptRow(page, 'summarize')
  await expect(review).toBeVisible()
  const rail = await page
    .getByRole('complementary', { name: 'Workspace sidebar', exact: true })
    .boundingBox()
  const sidebar = await page
    .getByRole('region', { name: 'Prompts list', exact: true })
    .boundingBox()
  const pane = await page
    .getByRole('article', { name: 'Agent details', exact: true })
    .boundingBox()
  const navigation = (await page.getByRole('complementary', { name: 'Agent navigation', exact: true }).boundingBox())!
  expect(navigation.x).toBeCloseTo(rail!.x + rail!.width, 0)
  expect(sidebar!.x).toBeCloseTo(navigation.x + navigation.width, 0)
  expect(pane!.x).toBeCloseTo(sidebar!.x + sidebar!.width, 0)
  expect(pane!.y).toBe(sidebar!.y)
  await review.click()
  await expect(review).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('Prompt content')).toHaveText(
    'Review for {{ audience }}.',
  )
  await summary.click()
  await expect(summary).toHaveAttribute('aria-selected', 'true')
  await expect(review).toHaveAttribute('aria-selected', 'false')
  await expect(page.getByLabel('Prompt content')).toHaveText(
    'Summarize this task.',
  )
  await review.click()
  changeDraft('A long instruction.\n'.repeat(200))
  await expect(page.getByLabel('Prompt content')).toContainText(
    'A long instruction.',
  )
  await page.locator('.prompts-detail-body').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  expect(
    await page.locator('.prompts-detail-body').evaluate((el) => el.scrollTop),
  ).toBeGreaterThan(0)
  expect(
    await page.locator('.prompts-library').evaluate((el) => el.scrollTop),
  ).toBe(0)
  await expect(
    page.getByRole('button', { name: 'Edit review', exact: true }),
  ).toBeInViewport()
  await expect(summary).toBeInViewport()
  await expect(review).toBeVisible()
})

test('retains the selected prompt and unsaved edit across reconnection', async ({
  page,
}) => {
  const { requests, dropConnection } = await fixture(page)
  await page.goto('/#/prompts')
  await promptRow(page, 'review').click()
  await page.getByRole('button', { name: 'Edit review', exact: true }).click()
  const editor = page.getByRole('region', { name: 'Edit review', exact: true })
  await editor
    .getByRole('textbox', { name: 'Prompt file contents', exact: true })
    .fill('Keep this edit across reconnects.')
  const catalogs = requests.filter(
    (request) => request.op === 'prompts-catalog',
  ).length
  dropConnection()
  await expect
    .poll(
      () =>
        requests.filter((request) => request.op === 'prompts-catalog').length,
    )
    .toBeGreaterThan(catalogs)
  await expect(editor.getByRole('textbox', { name: 'Prompt file contents', exact: true })).toHaveText(
    'Keep this edit across reconnects.',
  )
  await expect(page.locator('.carrier-sidebar .carrier-connection-status')).toContainText('Connected')
  await editor
    .getByRole('button', { name: 'Save changes', exact: true })
    .click()
  await expect(editor).not.toBeVisible()
  await expect(page.getByLabel('Prompt content')).toHaveText(
    'Keep this edit across reconnects.',
  )
  expect(
    requests.find((request) => request.op === 'prompts-save')?.args
      .expectedDigest,
  ).toBe(digest)
})

test('toggles pack folders, retains their state through refreshes and reveals search matches', async ({
  page,
}) => {
  const { requests } = await fixture(page)
  await page.goto('/#/prompts')
  const tree = page.getByRole('treegrid', { name: 'Prompt tree' })
  const folder = tree.getByRole('row', { name: 'agents', exact: true })
  await expect(folder).toHaveAttribute('aria-expanded', 'true')
  await promptRow(page, 'review').click()
  await expect(page.getByLabel('Prompt content')).toBeVisible()
  await tree.getByRole('button', { name: /^Collapse agents/ }).click()
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  await expect(promptRow(page, 'review')).toHaveCount(0)
  await expect(page.getByLabel('Prompt content')).toHaveText(
    'Review for {{ audience }}.',
  )
  const catalogs = requests.filter(
    (request) => request.op === 'prompts-catalog',
  ).length
  await page
    .getByRole('button', { name: 'Refresh prompts', exact: true })
    .click()
  await expect
    .poll(
      () =>
        requests.filter((request) => request.op === 'prompts-catalog').length,
    )
    .toBeGreaterThan(catalogs)
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('searchbox', { name: 'Search prompts' }).fill('review')
  await expect(promptRow(page, 'review')).toBeVisible()
  await expect(promptRow(page, 'summarize')).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear search', exact: true }).click()
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  await folder.click()
  await expect(folder).toHaveAttribute('aria-expanded', 'true')
  await expect(promptRow(page, 'summarize')).toBeVisible()
  await folder.click()
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByLabel('Prompt content')).toHaveText(
    'Review for {{ audience }}.',
  )
})

test('navigates the file tree with arrow keys and activates a selected prompt', async ({
  page,
}) => {
  await fixture(page)
  await page.goto('/#/prompts')
  const tree = page.getByRole('treegrid', { name: 'Prompt tree' })
  const folder = tree.getByRole('row', { name: 'agents', exact: true })
  await folder.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('ArrowRight')
  await expect(folder).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(promptRow(page, 'review')).toBeFocused()
  await expect(page.getByLabel('Prompt content')).toHaveText(
    'Review for {{ audience }}.',
  )
  await page.keyboard.press('ArrowDown')
  await expect(promptRow(page, 'summarize')).toBeFocused()
  await expect(page.getByLabel('Prompt content')).toHaveText(
    'Summarize this task.',
  )
  await page.keyboard.press('ArrowLeft')
  await expect(folder).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Enter')
  await expect(folder).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('r')
  await expect(promptRow(page, 'review')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Prompt content')).toHaveText(
    'Review for {{ audience }}.',
  )
})


test('prompt bookmarks and remembered sections retain the exact revision, source file and search', async ({ page }) => {
  const { requests } = await fixture(page)
  const query = new URLSearchParams({ pack: releaseId, prompt: 'review', file: 'sections/review.md', q: 'review' })
  await page.goto(`/#/prompts?${query}`)
  await expect(page).toHaveURL(new RegExp('#/agents/prompts\\?'))
  await expect(page.getByLabel('Prompt content')).toHaveText('Original released instructions.')
  await page.getByRole('searchbox', { name: 'Search prompts', exact: true }).fill('')
  await page.getByRole('searchbox', { name: 'Search prompts', exact: true }).pressSequentially('review')
  await expect(page.getByRole('searchbox', { name: 'Search prompts', exact: true })).toHaveValue('review')
  const selected = page.url()
  const nav = page.getByRole('complementary', { name: 'Agent navigation', exact: true })
  await nav.getByRole('button', { name: 'Sessions', exact: true }).click()
  await nav.getByRole('button', { name: 'Prompts', exact: true }).click()
  await expect(page).toHaveURL(selected)
  await expect(page.getByLabel('Prompt content')).toHaveText('Original released instructions.')
  await page.reload()
  await expect(page.getByLabel('Prompt content')).toHaveText('Original released instructions.')
  await expect(page.getByRole('searchbox', { name: 'Search prompts', exact: true })).toHaveValue('review')
  expect(requests.some(row => ['prompts-bind', 'prompts-save', 'session-start'].includes(row.op))).toBe(false)
})
