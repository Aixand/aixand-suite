import { expect, test } from './fixtures'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import type { GroupPage } from '../src/terminals/groups'
import type { Session } from '../src/terminals/connection'

async function fixture(page: Page, context = false) {
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
  await page.getByRole('button', { name: 'Manage groups', exact: true }).click()
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
  ).toContainText('infra')
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
  await page.getByRole('button', { name: 'Manage groups', exact: true }).click()
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
    await page
      .getByRole('button', { name: 'Manage groups', exact: true })
      .click()
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
      page.getByRole('button', { name: 'Manage groups', exact: true })
    ).toBeFocused()
  }
})

test('automatic context filters cross saved groups without fetching private detail', async ({ page }) => {
  const { requests } = await fixture(page, true)
  await select(page, 'Filter by group', 'Workflow: run-42 · 2')
  await expect(page.locator('.terminal-session')).toHaveCount(2)
  await expect(page.locator('.tw-session-meta')).toHaveText(['Project X · codex', 'Project X · shell'])
  await select(page, 'Filter by group', 'Role: reviewer · 1')
  await expect(page.locator('.terminal-session')).toHaveCount(1)
  expect(requests.filter((request) => request.op === 'inspect')).toHaveLength(0)
  expect(requests.filter((request) => request.op === 'group-assign')).toHaveLength(0)
});
