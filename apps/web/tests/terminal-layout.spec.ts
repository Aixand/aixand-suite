import { expect, test } from './fixtures'
import { autoPlacement, splitTile, workspace } from '../src/terminals/layout'

const session = {
  id: 'session',
  name: 'shell',
  lifecycle: { state: 'running' },
}

test('auto-tiling follows available dimensions and chooses the largest pane', () => {
  const tab = workspace('Test')
  const first = tab.focused
  tab.panes[first] = session
  expect(autoPlacement(tab, 1200, 800).direction).toBe('right')
  expect(autoPlacement(tab, 600, 1000).direction).toBe('down')
  tab.root = splitTile(tab.root, first, 'right', 'second')
  tab.panes.second = session
  tab.focused = 'second'
  expect(autoPlacement(tab, 1200, 800)).toEqual({
    paneId: 'second',
    direction: 'down',
    reuse: false,
  })
  tab.root = splitTile(tab.root, 'second', 'down', 'third')
  tab.panes.third = session
  tab.focused = 'third'
  expect(autoPlacement(tab, 1200, 800)).toEqual({
    paneId: first,
    direction: 'down',
    reuse: false,
  })
  if (tab.root.kind === 'split') tab.root.ratio = 0.2
  expect(autoPlacement(tab, 1200, 800)).toEqual({
    paneId: 'third',
    direction: 'right',
    reuse: false,
  })
})

test('auto-tiling fills existing empty space before splitting occupied panes', () => {
  const tab = workspace('Test')
  const first = tab.focused
  tab.panes[first] = session
  tab.root = splitTile(tab.root, first, 'right', 'empty')
  tab.panes.empty = null
  if (tab.root.kind === 'split') tab.root.ratio = 0.8
  expect(autoPlacement(tab, 1200, 800)).toMatchObject({
    paneId: 'empty',
    reuse: true,
  })
})
