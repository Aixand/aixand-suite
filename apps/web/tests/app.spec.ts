import { expect, test } from './fixtures'
import AxeBuilder from '@axe-core/playwright'

const workspaceRoutes = ['home', 'chat', 'terminals', 'workflows', 'carrier', 'agents', 'agents/profiles', 'prompts', 'skills', 'settings']

test('Home links to all workspace pages and Terminals returns Home', async ({
  page,
}) => {
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'Home' }),
  ).toBeVisible()
  const navigation = page.getByRole('navigation', {
    name: 'Workspace navigation',
  })
  const names = [
    'Home',
    'Chat',
    'Terminals',
    'Workflows',
    'Carrier',
    'Agents',
  ]
  await expect(navigation.getByRole('link')).toHaveCount(names.length)
  for (const name of names) {
    await expect(
      navigation.getByRole('link', { name, exact: true }),
    ).toBeVisible()
  }
  const sidebar = page.getByRole('complementary', { name: 'Workspace sidebar' })
  const sidebarBounds = await sidebar.boundingBox()
  const topbar = page.locator('.app-body > .topbar')
  await navigation.getByRole('link', { name: 'Terminals', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Terminals', exact: true, level: 1 }),
  ).toBeVisible()
  await expect(navigation).toBeVisible()
  await expect(
    navigation.getByRole('link', { name: 'Terminals', exact: true }),
  ).toHaveAttribute('aria-current', 'page')
  expect(await sidebar.boundingBox()).toEqual(sidebarBounds)
  await expect(topbar).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /^Color mode:/ }),
  ).toHaveCount(1)
  const mainBounds = (await page.getByRole('main').boundingBox())!
  const terminalBounds = (await page
    .locator('.terminal-workspace')
    .boundingBox())!
  expect(terminalBounds).toEqual(mainBounds)
  const terminalSidebar = page.getByRole('complementary', {
    name: 'Terminal sessions',
  })
  await expect(terminalSidebar).toBeVisible()
  const terminalSidebarBounds = (await terminalSidebar.boundingBox())!
  expect(terminalSidebarBounds.width).toBeGreaterThanOrEqual(200)
  expect(terminalSidebarBounds.x).toBe(mainBounds.x)
  expect(terminalSidebarBounds.y).toBe(mainBounds.y)
  expect(terminalSidebarBounds.height).toBe(mainBounds.height)
  expect(terminalSidebarBounds.x).toBe(sidebarBounds!.x + sidebarBounds!.width)
  await navigation.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Home' }),
  ).toBeFocused()
})

test('invalid and removed pages offer a way Home', async ({ page }) => {
  for (const route of ['missing', 'pathspec', 'workflow']) {
    await page.goto(`/#/${route}`)
    await expect(page.getByRole('heading', { name: 'This page isn’t here' })).toBeVisible()
    await page.getByRole('button', { name: 'Back to Home' }).click()
    await expect(page).toHaveURL(/#\/home$/)
  }
})

test('permanent icon navigation has quick hints and keyboard access', async ({
  page,
}) => {
  await page.goto('/')
  await expect(
    page.getByRole('button', { name: /(?:Collapse|Expand) sidebar/ }),
  ).toHaveCount(0)
  await expect(
    page.getByText('Personal workspace', { exact: true }),
  ).toHaveCount(0)
  await expect(page.getByText('Aixand workspace', { exact: true })).toHaveCount(
    0,
  )
  const navigation = page.getByRole('navigation', {
    name: 'Workspace navigation',
  })
  const carrier = navigation.getByRole('link', {
    name: 'Carrier',
    exact: true,
  })
  const rail = page.getByRole('complementary', { name: 'Workspace sidebar' })
  const railBounds = (await rail.boundingBox())!
  expect(railBounds.width).toBeLessThanOrEqual(72)
  // Move into the page before the trigger, as a pointer entering the rail would.
  await page.getByRole('main').hover()
  await carrier.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Carrier', {
    timeout: 500,
  })
  await page.getByRole('main').hover()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await carrier.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(carrier).toBeFocused()
  await expect(page.getByRole('tooltip')).toHaveText('Carrier')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#\/carrier$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  await expect(carrier).toHaveAttribute('aria-current', 'page')
  await expect(carrier).toBeVisible()
  expect(await rail.boundingBox()).toEqual(railBounds)
  await page.reload()
  await expect(carrier).toBeVisible()
  expect((await rail.boundingBox())!.width).toBe(railBounds.width)
})

test('rail theme toggle supports keyboard use and persists both themes', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const toggle = page.getByRole('button', { name: /^Color mode:/ })
  await expect(toggle).toHaveAccessibleName('Color mode: System')
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.aixand-app')).toHaveAttribute(
    'data-bbb-mode',
    'dark',
  )
  await expect(toggle).toHaveAccessibleName('Color mode: Dark')
  await expect(toggle).toBeFocused()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.aixand-app')).toHaveAttribute(
    'data-bbb-mode',
    'dark',
  )
  await page.emulateMedia({ colorScheme: 'dark' })
  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(page.locator('.aixand-app')).toHaveAttribute('data-bbb-mode', 'light')
  await expect(toggle).toHaveAccessibleName('Color mode: Light')
  await expect(toggle).toBeFocused()
  await page.reload()
  await expect(page.locator('.aixand-app')).toHaveAttribute('data-bbb-mode', 'light')
})

for (const mode of ['light', 'dark']) {
  test(`navigation, theme, and terminal tooltips have readable contrast in ${mode}`, async ({ page }) => {
    await page.routeWebSocket(/\/api\/(agents|carrier|terminals)\/ws/, () => {})
    await page.addInitScript(value => localStorage.setItem('aixand.appearance', value), mode)
    await page.goto('/#/terminals')
    await expect(page.locator('.tw-tabbar')).toBeVisible()
    const triggers = [
      { target: page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Carrier', exact: true }), label: 'Carrier' },
      { target: page.getByRole('button', { name: /^Color mode:/ }), label: `Color mode: ${mode === 'light' ? 'Light' : 'Dark'}` },
      { target: page.getByRole('button', { name: 'New workspace tab', exact: true }), label: 'New workspace tab' },
    ]
    for (const { target, label } of triggers) {
      for (const interaction of ['hover', 'focus']) {
        if (interaction === 'hover') {
          await page.getByRole('main').hover()
          await target.hover()
        } else {
          await page.keyboard.press('Tab')
          await target.focus()
        }
        const tooltip = page.getByRole('tooltip')
        await expect(tooltip).toHaveText(label)
        await expect(tooltip).toHaveAttribute('data-bbb-mode', mode)
        const contrast = await tooltip.evaluate(element => {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 1
          const context = canvas.getContext('2d')!
          const luminance = (color: string) => {
            // Normalize modern color(srgb ...) and color-mix results to RGB bytes.
            context.fillStyle = color
            context.fillRect(0, 0, 1, 1)
            const channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(value => {
              const channel = value / 255
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
            })
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
          }
          const style = getComputedStyle(element)
          const foreground = luminance(style.color)
          const background = luminance(style.backgroundColor)
          return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
        })
        expect(contrast, `${mode} ${label} ${interaction}`).toBeGreaterThanOrEqual(4.5)
        expect((await new AxeBuilder({ page }).include('[role="tooltip"]').analyze()).violations).toEqual([])
        await page.screenshot({ path: test.info().outputPath(`${mode}-${label.startsWith('Switch') ? 'theme' : label === 'Carrier' ? 'navigation' : 'terminal'}-${interaction}-tooltip.png`) })
        await page.keyboard.press('Escape')
        await expect(tooltip).toHaveCount(0)
        await page.getByRole('main').hover()
        await page.getByRole('main').focus()
      }
    }
  })
}

test('main screens pass automated accessibility checks in both themes', async ({
  page,
}) => {
  test.setTimeout(90_000)
  for (const mode of ['light', 'dark']) {
    await page.addInitScript(
      (value) => localStorage.setItem('aixand.appearance', value),
      mode,
    )
    for (const route of workspaceRoutes) {
      await page.goto(`/#/${route}`)
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeAttached()
      await expect(page.locator('.topbar')).toHaveCount(0)
      const main = (await page.getByRole('main').boundingBox())!
      expect(main.y, `${route} starts at the top`).toBe(0)
      expect(main.height, `${route} fills the viewport`).toBe(page.viewportSize()!.height)
      const sidebar = page.locator('.command-history-sidebar, .tw-sidebar, .carrier-sidebar, .prompts-sidebar').first()
      if (await sidebar.isVisible()) {
        const bounds = (await sidebar.boundingBox())!
        expect(bounds.y).toBe(0)
        expect(bounds.height).toBe(main.height)
      }
      if (route === 'home') {
        await page.getByRole('main').hover()
        await page
          .getByRole('navigation', { name: 'Workspace navigation' })
          .getByRole('link', { name: 'Carrier', exact: true })
          .hover()
        await expect(page.getByRole('tooltip')).toBeVisible()
      }
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
      expect(results.violations, `${mode} ${route}`).toEqual([])
    }
  }
})

test('icon navigation, enlarged text, and responsive screens', async ({
  page,
}) => {
  test.setTimeout(120_000)
  for (const width of [320, 390, 768, 900, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const route of workspaceRoutes) {
      await page.goto(`/#/${route}`)
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeAttached()
      if (width < 400)
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%'
        })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        `${route} at ${width}`,
      ).toBe(true)
      expect(
        await page
          .getByRole('main')
          .evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        `${route} content at ${width}`,
      ).toBe(true)
      if (route === 'terminals') {
        const split = await page
          .getByRole('button', { name: 'Split down', exact: true })
          .boundingBox()
        expect(split).not.toBeNull()
        expect(
          split!.x + split!.width,
          `Terminal actions at ${width}`,
        ).toBeLessThanOrEqual(width + 1)
        const terminalBounds = (await page
          .locator('.terminal-workspace')
          .boundingBox())!
        expect(
          split!.x + split!.width,
          `Terminal actions inside container at ${width}`,
        ).toBeLessThanOrEqual(terminalBounds.x + terminalBounds.width)
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/carrier')
  const navigation = page.getByRole('navigation', {
    name: 'Workspace navigation',
  })
  await expect(navigation).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Open navigation' }),
  ).toHaveCount(0)
  await page
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('link', { name: 'Terminals' })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/terminals$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused()
  await page
    .getByRole('button', { name: 'Show terminal list', exact: true })
    .click()
  const terminalSidebar = page.getByRole('complementary', {
    name: 'Terminal sessions',
  })
  await expect(terminalSidebar).toBeVisible()
  expect((await terminalSidebar.boundingBox())!.height).toBe(
    (await page.getByRole('main').boundingBox())!.height,
  )
  await page
    .getByRole('button', { name: 'Close terminal list', exact: true })
    .click()
  await expect(terminalSidebar).toBeHidden()
  await expect(
    page.getByRole('button', { name: 'Show terminal list', exact: true }),
  ).toBeFocused()
  await navigation.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page).toHaveURL(/#\/home$/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
