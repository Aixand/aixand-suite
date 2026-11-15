import { expect, test } from './fixtures'
import AxeBuilder from '@axe-core/playwright'

const token = 'test-workflow-workspace-key-32-characters'

test('Agents connects and creates profiles without secure-context randomUUID', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined })
  })
  const errors: string[] = []
  const ids: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/api/agents/ws')) return
    socket.on('framesent', ({ payload }) => {
      const command = JSON.parse(payload.toString())
      if (command.id) ids.push(command.id)
    })
  })
  const name = `lan_${crypto.randomUUID().slice(0, 8)}`
  await page.goto('/#/agents/profiles')
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined')
  await expect(
    page.getByRole('button', { name: 'work · Codex', exact: true }),
  ).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: 'New profile', exact: true }).click()
  await page.getByLabel('Profile name').fill(name)
  await page.getByRole('button', { name: /Saved login$/ }).click()
  await page.getByRole('option', { name: 'personal', exact: true }).click()
  await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  await expect(
    page.getByRole('button', { name: `${name} · Codex`, exact: true }),
  ).toContainText('Codex · personal')
  expect(ids.length).toBeGreaterThanOrEqual(3)
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids)
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  expect(errors).toEqual([])
  await expect(
    page.getByText('Invalid agent response.', { exact: false }),
  ).toHaveCount(0)
})

test('Agents reports malformed JSON responses and disconnects cleanly', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.routeWebSocket('**/api/agents/ws', (socket) => {
    let malformed = false
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const command = JSON.parse(raw.toString())
      if (command.op === 'auth') { socket.send('{"type":"ready"}'); return }
      if (malformed) return
      malformed = true
      socket.send('{invalid')
    })
  })
  await page.goto('/#/agents/profiles')
  await expect(page.getByRole('alert')).toHaveText(
    'Invalid agent response. Reconnect and check Terminals.',
  )
  await expect(
    page.getByRole('button', { name: 'Reconnect', exact: true }),
  ).toBeVisible()
  expect(errors).toEqual([])
})

test('real profiles persist and saved-login assignments update Saved logins and Home', async ({
  page,
}) => {
  const name = `browser_${crypto.randomUUID().slice(0, 8)}`
  await page.goto('/#/agents/profiles')
  await expect(
    page.getByRole('heading', { name: 'Builder', exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'work · Codex', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'New profile', exact: true }).click()
  await page.getByLabel('Profile name').fill(name)
  await page.getByRole('button', { name: /Saved login$/ }).click()
  await page.getByRole('option', { name: 'personal', exact: true }).click()
  await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  let card = page
    .getByRole('button', { name: `${name} · Codex`, exact: true })
  await expect(card).toContainText('Codex · personal')
  await page.reload()
  card = page
    .getByRole('button', { name: `${name} · Codex`, exact: true })
  await card.click()
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click()
  await page.getByRole('button', { name: /Saved login$/ }).click()
  await page.getByRole('option', { name: 'company', exact: true }).click()
  await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  await expect(card).toContainText('Codex · company')
  await page
    .getByRole('button', { name: /^Saved logins/ })
    .click()
  const login = page.getByRole('button', { name: 'company', exact: true })
  await expect(login).toContainText('75% weekly allowance remaining')
  await login.click()
  await expect(page.getByRole('region', { name: 'company', exact: true })).toContainText(name)
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Home', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: /Agent profiles \d+/ }),
  ).toBeVisible()
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    token,
  )
})

test('Agents and its profile form remain accessible on mobile in both themes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const theme of ['light', 'dark']) {
    await page.addInitScript(
      (value) => localStorage.setItem('aixand.appearance', value),
      theme,
    )
    await page.goto('/#/agents/profiles')
    await page.reload()
        await expect(
      page.getByRole('button', { name: 'New profile' }),
    ).toBeEnabled()
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([])
    await page.getByRole('button', { name: 'New profile' }).click()
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([])
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
  }
})
