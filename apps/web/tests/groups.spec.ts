import { expandTerminalSection, openTerminalGroups } from './terminal-helpers'
import { expect, test } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import type { GroupPage, TerminalGroup } from '../src/terminals/groups'
import type { Session } from '../src/terminals/connection'

async function fixture(page: Page, context = false, extraGroups: TerminalGroup[] = []) {
  const requests: { op: string; args: Record<string, unknown> }[] = []
  const sessions: Session[] = ['api', 'web', 'logs'].map((name) => ({
    id: name,
    name,
    lifecycle: { state: 'running' },
  }))
  if (context) {
    sessions[0].profile = 'codex'
    sessions[1].profile = 'shell'
    sessions[0].labels = { app: 'pathspec', 'project.id': 'x', 'project.name': 'Project X', 'workflow.run_id': 'run-42', role: 'implementer' }
    sessions[1].labels = { app: 'pathspec', 'project.id': 'x', 'project.name': 'Project X', 'workflow.run_id': 'run-42', role: 'reviewer' }
    sessions[2].labels = { app: 'aixand-suite' }
  }
  const data: GroupPage = {
    defaults: { cwd: '/srv/projects', shell: '/bin/bash' },
    groups: [
      {
        id: 'backend-id',
        name: 'backend',
        cwd: '/srv/backend',
        shell: '/bin/bash',
        persistent: true,
        deleting: false,
        pending_name: null,
        members: [
          { key: 'api-slot', session_id: 'api', name: 'api', restorable: true },
          {
            key: 'lost-slot',
            session_id: 'lost',
            name: 'saved-shell',
            restorable: true,
          },
        ],
      },
      {
        id: 'frontend-id',
        name: 'frontend',
        cwd: '/srv/frontend',
        shell: '/bin/bash',
        persistent: true,
        deleting: false,
        pending_name: null,
        members: [
          { key: 'web', session_id: 'web', name: 'web', restorable: false },
        ],
      },
      ...extraGroups,
    ],
  }
  await page.routeWebSocket('**/api/terminals/ws', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      requests.push(command)
      const args = command.args ?? {}
      if (command.op === 'auth') {
        socket.send(JSON.stringify({ type: 'ready' }))
        return
      }
      if (command.op === 'ack') return
      let result: unknown = null
      if (command.op === 'groups') result = data
      // Deliberately paginate, including a group member on the second page.
      if (command.op === 'list')
        result = args.cursor
          ? {
              items: sessions.slice(1),
              next_cursor: null,
              total: sessions.length,
            }
          : {
              items: sessions.slice(0, 1),
              next_cursor: 'second',
              total: sessions.length,
            }
      if (command.op === 'group-create')
        data.groups.push({
          id: args.name,
          name: args.name,
          cwd: args.cwd ?? data.defaults.cwd,
          shell: args.shell ?? data.defaults.shell,
          persistent: args.persistent,
          deleting: false,
          pending_name: null,
          members: [],
        })
      if (command.op === 'group-assign') {
        const from = data.groups.find((group) => group.name === args.from)
        const member = from?.members.find(
          (member) => member.session_id === args.sessionId
        ) ?? {
          key: args.sessionId,
          session_id: args.sessionId,
          name: args.sessionId,
          restorable: false,
        }
        if (from) from.members = from.members.filter((item) => item !== member)
        data.groups
          .find((group) => group.name === args.to)
          ?.members.push(member)
      }
      if (command.op === 'group-delete')
        data.groups = data.groups.filter((group) => group.name !== args.group)
      if (command.op === 'group-reconcile') {
        const group = data.groups.find(group => group.name === args.group)
        if (group) group.pending_name = null
      }
      if (command.op === 'create') {
        const session = {
          id: args.name,
          name: args.name,
          lifecycle: { state: 'running' },
        }
        sessions.push(session)
        data.groups
          .find((group) => group.name === args.group)
          ?.members.push({
            key: `slot-${args.name}`,
            session_id: args.name,
            name: args.name,
            restorable: true,
          })
        result = { session }
      }
      if (command.op === 'group-restore') {
        const member = data.groups
          .find((group) => group.name === args.group)!
          .members.find((member) => member.session_id === args.sessionId)!
        member.session_id = 'restored-session'
        sessions.push({
          id: member.session_id,
          name: member.name,
          lifecycle: { state: 'running' },
        })
        result = { notices: [] }
      }
      if (command.op === 'set-my-terminal') {
        const session = sessions.find(session => session.id === args.sessionId)!
        session.labels = { ...session.labels, 'aixand.my_terminal': 'true' }
        result = { session }
      }
      if (command.op === 'attach') result = { stream: args.paneId }
      socket.send(JSON.stringify({ type: 'result', id: command.id, result }))
      if (command.op === 'attach') {
        const bytes = Buffer.from(`${args.sessionId}_OUTPUT\r\n`)
        socket.send(
          JSON.stringify({
            type: 'output',
            stream: args.paneId,
            sequence: '1',
            start: '0',
            offset: String(bytes.length),
            data: bytes.toString('base64'),
          })
        )
      }
    })
  })
  await page.goto('/#/terminals')
  await expandTerminalSection(page)
  if (context) await expandTerminalSection(page, 'Pathspec')
  await expect(
    page.getByRole('button', { name: context ? /^api running App: pathspec Profile: codex/ : 'api running', exact: !context })
  ).toBeVisible()
  return { requests, data, sessions }
}

async function select(page: Page, label: string, option: string) {
  if (label === 'Filter by group') {
    await page.getByRole('button', { name: /^Filter terminals:/ }).click()
    await page.getByRole('menuitemradio', { name: option, exact: true }).click()
    return
  }
  await page.getByRole('button', { name: new RegExp(label) }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

for (const mode of ['light', 'dark']) {
  test(`tooltips stay anchored when menus and modals close in ${mode} mode`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('aixand.appearance', value), mode)
    await fixture(page)
    const observation = await page.evaluateHandle(() => {
      const invalid: { text: string; placement: string | null; exiting: boolean; x: number; y: number }[] = []
      const sample = () => {
        for (const tooltip of document.querySelectorAll<HTMLElement>('.bbb-tooltip')) {
          const style = getComputedStyle(tooltip)
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
          const bounds = tooltip.getBoundingClientRect()
          if (!tooltip.hasAttribute('data-placement') || tooltip.hasAttribute('data-exiting') || bounds.x === 0 && bounds.y === 0)
            invalid.push({ text: tooltip.textContent ?? '', placement: tooltip.getAttribute('data-placement'),
              exiting: tooltip.hasAttribute('data-exiting'), x: bounds.x, y: bounds.y })
        }
      }
      const observer = new MutationObserver(sample)
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-placement', 'data-exiting'] })
      let frame: number
      const tick = () => { sample(); frame = requestAnimationFrame(tick) }
      frame = requestAnimationFrame(tick)
      return { invalid, stop: () => { observer.disconnect(); cancelAnimationFrame(frame) } }
    })
    const options = page.getByRole('button', { name: 'Terminal options', exact: true })
    for (let attempt = 0; attempt < 2; attempt++) {
      await options.hover()
      await expect(page.getByRole('tooltip', { name: 'Terminal options', exact: true })).toBeVisible()
      await options.click()
      await page.getByRole('menuitem', { name: 'Manage groups', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Manage groups', exact: true })
      await dialog.getByRole('button', { name: 'Delete group backend', exact: true }).hover()
      await expect(page.getByRole('tooltip', { name: 'Delete group', exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
      await expect(dialog).not.toBeVisible()
      await page.mouse.move(800, 400)
      await expect(page.getByRole('tooltip')).toHaveCount(0)
    }
    await page.keyboard.press('Tab')
    await options.focus()
    await expect(page.getByRole('tooltip', { name: 'Terminal options', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    expect(await observation.evaluate(capture => { capture.stop(); return capture.invalid })).toEqual([])
    await observation.dispose()
  })
}

test('filters the whole catalog while mixed-group panes stay attached', async ({
  page,
}) => {
  const { requests } = await fixture(page)
  await page
    .getByRole('button', { name: 'api running', exact: true })
    .click()
  await select(page, 'Filter by group', 'frontend · 1')
  await page
    .getByRole('button', { name: 'web running', exact: true })
    .click({ modifiers: ['Shift'] })
  await expect(page.locator('.terminal-live[data-session-id]')).toHaveCount(2)
  await expect(page.locator('.tile-header .tile-group-badge')).toHaveText([
    'backend',
    'frontend',
  ])
  await page.screenshot({ path: '/tmp/aixand-groups-mixed.png' })
  await page.getByRole('button', { name: 'Hide terminal list' }).click()
  await page.getByRole('button', { name: 'Show terminal list' }).click()
  await expect(
    page.getByRole('button', { name: /^Filter terminals:/ })
  ).toHaveAccessibleName(/frontend/)
  const attached = requests.filter((item) =>
    ['attach', 'detach'].includes(item.op)
  ).length
  await select(page, 'Filter by group', 'Ungrouped · 1')
  await expect(
    page.getByRole('button', { name: 'logs running', exact: true })
  ).toBeVisible()
  await expect(page.locator('.terminal-live[data-session-id]')).toHaveCount(2)
  expect(
    requests.filter((item) => ['attach', 'detach'].includes(item.op))
  ).toHaveLength(attached)
  expect(
    requests.some((item) => item.op === 'list' && item.args.cursor === 'second')
  ).toBe(true)
  expect(
    requests.some((item) => item.op === 'group-restore' || item.op === 'create')
  ).toBe(false)
})

test('creates empty groups and grouped shells, moves membership, restores, and deletes without stopping', async ({
  page,
}) => {
  const { requests, data } = await fixture(page)
  await openTerminalGroups(page)
  await page.getByLabel('Group name', { exact: true }).fill('infra')
  await page.getByRole('button', { name: 'Create group', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Group created')
  expect(requests.filter((item) => item.op === 'create')).toHaveLength(0)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await select(page, 'Filter by group', 'infra · 0')
  await expect(page.getByLabel('Session name')).toHaveCount(0)
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await expect(page.getByLabel('Session name')).toBeFocused()
  await expect(
    page.getByRole('button', { name: /New terminal group/ })
  ).toHaveAccessibleName('New terminal group: infra')
  await page.getByLabel('Session name').fill('deploy')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'New terminal', exact: true })).toBeFocused()
  await expect(page.getByRole('dialog', { name: 'New terminal', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'New terminal', exact: true }).click()
  await expect(page.getByLabel('Session name')).toHaveValue('deploy')
  await page.getByRole('button', { name: 'Create terminal', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'New terminal', exact: true })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'deploy running', exact: true })
  ).toBeVisible()
  expect(requests.find((item) => item.op === 'create')?.args.group).toBe(
    'infra'
  )
  await page
    .getByRole('button', { name: 'Manage terminal deploy', exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Group', exact: true }).hover()
  await page.getByRole('menuitemradio', { name: 'backend', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(
    page.locator('.terminal-live[data-session-id=deploy]')
  ).toBeVisible()
  await expect(page.locator('.tile-group-badge')).toContainText('backend')
  expect(
    data.groups
      .find((group) => group.name === 'backend')!
      .members.find((member) => member.name === 'deploy')!.key
  ).toBe('slot-deploy')
  await select(page, 'Filter by group', 'backend · 3')
  await expect(
    page.getByRole('button', { name: /saved-shell unavailable/ })
  ).toBeDisabled()
  await page
    .getByRole('button', { name: 'Manage terminal saved-shell', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('menuitem', { name: 'Restore shell', exact: true }))
    .toHaveAccessibleDescription(/Previous commands and applications will not resume/)
  await page.getByRole('menuitem', { name: 'Restore shell', exact: true }).click()
  await expect(
    page.getByRole('button', {
      name: 'saved-shell running',
      exact: true,
    })
  ).toBeVisible()
  await openTerminalGroups(page)
  await page
    .getByRole('button', { name: 'Delete group backend', exact: true })
    .click()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await expect(
    page.getByRole('button', { name: /^Filter terminals:/ })
  ).toHaveAccessibleName(/All terminals/)
  await expect(
    page.locator('.terminal-live[data-session-id=deploy]')
  ).toBeVisible()
  await expect(page.locator('.tile-group-badge')).toHaveCount(0)
  expect(
    requests.some((item) => item.op === 'stop' || item.op === 'detach')
  ).toBe(false)
})

test('reflects external membership changes and supports narrow layouts and keyboard dialogs', async ({
  page,
}) => {
  const { data } = await fixture(page)
  data.groups[0].members.push({
    key: 'logs',
    session_id: 'logs',
    name: 'logs',
    restorable: false,
  })
  await expect(
    page.getByRole('button', { name: 'logs running', exact: true })
  ).toBeVisible({ timeout: 8000 })
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%'
    })
    await openTerminalGroups(page)
    await expect(
      page.getByRole('dialog', { name: 'Manage groups', exact: true })
    ).toBeVisible()
    const heading = page.getByRole('heading', {
      name: 'Manage groups',
      exact: true,
    })
    expect(
      await heading.evaluate(
        (el) =>
          el.getBoundingClientRect().height /
          parseFloat(getComputedStyle(el).lineHeight)
      )
    ).toBeLessThanOrEqual(3)
    await expect(page.getByLabel('Group name', { exact: true })).toBeVisible()
    await page.screenshot({ path: `/tmp/aixand-groups-${width}.png` })
    const violations = (await new AxeBuilder({ page }).analyze()).violations
    expect(violations).toEqual([])
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)
    await page.getByLabel('Group name', { exact: true }).fill(`narrow-${width}`)
    await page
      .getByRole('button', { name: 'Create group', exact: true })
      .click()
    await expect(page.getByRole('status')).toContainText('Group created')
    await expect(page.getByLabel('Group name', { exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(
      page.getByRole('button', { name: 'Terminal options', exact: true })
    ).toBeFocused()
  }
})

test('automatic context filters cross saved groups without fetching private detail', async ({ page }) => {
  const { requests } = await fixture(page, true)
  await select(page, 'Filter by group', 'Workflow: run-42 · 2')
  await expect(page.locator('.terminal-session')).toHaveCount(2)
  await expect(page.locator('.terminal-session').nth(0)).toHaveAttribute('title', /Project X · codex/)
  await expect(page.locator('.terminal-session').nth(1)).toHaveAttribute('title', /Project X · shell/)
  await expect(page.locator('.terminal-session')).toHaveText(['api', 'web'])
  await select(page, 'Filter by group', 'Role: reviewer · 1')
  await expect(page.locator('.terminal-session')).toHaveCount(1)
  expect(requests.filter((request) => request.op === 'inspect')).toHaveLength(0)
  expect(requests.filter((request) => request.op === 'group-assign')).toHaveLength(0)
});

test('manage groups keeps a large catalog compact, searchable, and independently scrollable', async ({ page }) => {
  const extraGroups = Array.from({ length: 60 }, (_, index): TerminalGroup => ({
    id: `group-${index}`, name: `project-${String(index + 1).padStart(2, '0')}`,
    cwd: '/srv/projects', shell: '/bin/bash', persistent: true, deleting: false, pending_name: null, members: [],
  }))
  const { requests } = await fixture(page, false, extraGroups)
  await page.getByRole('button', { name: 'api running', exact: true }).click()
  const emulator = page.locator('.terminal-emulator .xterm')
  await expect(emulator).toHaveCount(1)
  await emulator.evaluate(element => element.setAttribute('data-retained', 'yes'))
  for (const mode of ['light', 'dark']) {
    if (await page.locator('.aixand-app').getAttribute('data-bbb-mode') !== mode)
      await page.getByRole('button', { name: /^Color mode:/ }).click()
    await openTerminalGroups(page)
    const dialog = page.getByRole('dialog', { name: 'Manage groups', exact: true })
    const list = dialog.getByRole('list', { name: 'Terminal groups' })
    const search = dialog.getByRole('searchbox', { name: 'Search groups', exact: true })
    await expect(search).toBeFocused()
    await expect(list.getByRole('listitem')).toHaveCount(62)
    await expect(dialog.getByText('/srv/backend', { exact: true })).toBeHidden()
    await expect(dialog.getByLabel('Default directory', { exact: true })).toBeHidden()
    expect((await dialog.boundingBox())!.height).toBeLessThan(520)
    expect((await list.getByRole('listitem').first().boundingBox())!.height).toBeLessThanOrEqual(40)
    expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    const searchBounds = await search.boundingBox()
    const createBounds = await dialog.getByLabel('Group name', { exact: true }).boundingBox()
    await list.focus()
    await list.press('End')
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(await search.boundingBox()).toEqual(searchBounds)
    expect(await dialog.getByLabel('Group name', { exact: true }).boundingBox()).toEqual(createBounds)
    await search.fill('  FRONT  ')
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await expect(list.getByRole('button', { name: 'Delete group frontend', exact: true })).toBeVisible()
    await search.fill('no-such-group')
    await expect(list).toContainText('No matching groups.')
    await dialog.getByRole('button', { name: 'Clear group search', exact: true }).click()
    await expect(list.getByRole('listitem')).toHaveCount(62)
    const details = dialog.getByText('backend', { exact: true }).locator('..')
    await details.press('Enter')
    await expect(dialog.getByText('/srv/backend', { exact: true })).toBeVisible()
    await details.press('Enter')
    await expect(dialog.getByText('/srv/backend', { exact: true })).toBeHidden()
    const violations = (await new AxeBuilder({ page }).include('.tw-group-modal').analyze()).violations
    expect(violations).toEqual([])
    await list.evaluate(element => { element.scrollTop = 0 })
    await page.screenshot({ path: `artifacts/terminal-groups/${mode}-compact.png` })
    await page.keyboard.press('Escape')
  }
  await expect(emulator).toHaveAttribute('data-retained', 'yes')
  expect(requests.filter(request => request.op === 'attach')).toHaveLength(1)
  expect(requests.filter(request => ['detach', 'stop', 'create', 'group-delete', 'group-assign'].includes(request.op))).toHaveLength(0)
})

test('compact group creation keeps optional shell settings and reveals the created group after search', async ({ page }) => {
  const { requests } = await fixture(page)
  await openTerminalGroups(page)
  const dialog = page.getByRole('dialog', { name: 'Manage groups', exact: true })
  const search = dialog.getByRole('searchbox', { name: 'Search groups', exact: true })
  await search.fill('no-such-group')
  const name = dialog.getByLabel('Group name', { exact: true })
  await name.fill('invalid name')
  await expect(dialog.getByRole('button', { name: 'Create group', exact: true })).toBeDisabled()
  await expect(dialog.getByText('Use letters, numbers, underscores, or hyphens.', { exact: true })).toBeVisible()
  await name.fill('tools')
  await dialog.getByText('Shell defaults', { exact: true }).click()
  await dialog.getByLabel('Default directory', { exact: true }).fill('/srv/tools')
  await dialog.getByLabel('Default shell', { exact: true }).fill('/bin/zsh')
  await dialog.getByText('Save new shells for restoration', { exact: true }).click()
  await expect(dialog.getByRole('checkbox', { name: 'Save new shells for restoration', exact: true })).not.toBeChecked()
  await name.press('Enter')
  await expect(dialog.getByRole('status')).toHaveText('Group created.')
  await expect(search).toHaveValue('')
  await expect(name).toBeFocused()
  expect(requests.find(request => request.op === 'group-create')?.args)
    .toEqual({ name: 'tools', cwd: '/srv/tools', shell: '/bin/zsh', persistent: false })
  await search.fill('tools')
  await dialog.getByText('tools', { exact: true }).click()
  await expect(dialog.getByText('/srv/tools', { exact: true })).toBeVisible()
  await expect(dialog.getByText('/bin/zsh', { exact: true })).toBeVisible()
  await expect(dialog.getByText('No shell restoration', { exact: true })).toBeVisible()
  expect(requests.filter(request => request.op === 'create')).toHaveLength(0)
})

test('compact groups retain pending creation and shutdown states and their action restrictions', async ({ page }) => {
  const groups: TerminalGroup[] = [
    { id: 'pending', name: 'pending', cwd: '/srv/pending', shell: '/bin/bash', persistent: true,
      deleting: false, pending_name: 'pending-shell', members: [] },
    { id: 'closing', name: 'closing', cwd: '/srv/closing', shell: '/bin/bash', persistent: true,
      deleting: true, pending_name: null, members: [] },
  ]
  const { requests } = await fixture(page, false, groups)
  await openTerminalGroups(page)
  const dialog = page.getByRole('dialog', { name: 'Manage groups', exact: true })
  await expect(dialog.getByText('Creation pending', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Shutdown pending', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Delete group pending', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Delete group closing', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Check creation for group pending', exact: true }).click()
  await expect(dialog.getByText('Creation pending', { exact: true })).toBeHidden()
  await expect(dialog.getByRole('button', { name: 'Delete group pending', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('searchbox', { name: 'Search groups', exact: true })).toBeFocused()
  expect(requests.filter(request => request.op === 'group-reconcile')).toHaveLength(1)
  expect(requests.filter(request => ['create', 'group-delete', 'stop'].includes(request.op))).toHaveLength(0)
})
