import { requestId } from './connection'
import type { Session } from './connection'

export type Direction = 'right' | 'down'
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'
export type Tile =
  | { kind: 'pane'; id: string }
  | {
      kind: 'split'
      id: string
      direction: Direction
      ratio: number
      first: Tile
      second: Tile
    }
export type Workspace = {
  id: string
  name: string
  root: Tile
  panes: Record<string, Session | null>
  focused: string
}
export type Rect = { x: number; y: number; width: number; height: number }
export type Divider = {
  id: string
  direction: Direction
  ratio: number
  bounds: Rect
}
export const MAX_PANES = 16
export const MAX_TABS = 8

/** Reuse empty space first, otherwise bisect the largest pane's longer axis. */
export function autoPlacement(tab: Workspace, width: number, height: number) {
  const panes = Object.entries(tileLayout(tab.root).panes)
  const empty = panes.filter(([id]) => !tab.panes[id])
  const candidates = empty.length ? empty : panes
  candidates.sort(([a, first], [b, second]) => {
    const area = second.width * second.height - first.width * first.height
    return Math.abs(area) > 1e-9
      ? area
      : Number(b === tab.focused) - Number(a === tab.focused)
  })
  const [paneId, bounds] = candidates[0]
  const direction: Direction =
    bounds.width * width >= bounds.height * height ? 'right' : 'down'
  return { paneId, direction, reuse: empty.length > 0 }
}

export function workspace(name: string): Workspace {
  const pane = requestId()
  return {
    id: requestId(),
    name,
    root: { kind: 'pane', id: pane },
    panes: { [pane]: null },
    focused: pane,
  }
}
export function splitTile(
  tile: Tile,
  target: string,
  direction: Direction,
  pane: string
): Tile {
  if (tile.kind === 'pane')
    return tile.id === target
      ? {
          kind: 'split',
          id: requestId(),
          direction,
          ratio: 0.5,
          first: tile,
          second: { kind: 'pane', id: pane },
        }
      : tile
  return {
    ...tile,
    first: splitTile(tile.first, target, direction, pane),
    second: splitTile(tile.second, target, direction, pane),
  }
}
export function removeTile(tile: Tile, target: string): Tile | null {
  if (tile.kind === 'pane') return tile.id === target ? null : tile
  const first = removeTile(tile.first, target)
  const second = removeTile(tile.second, target)
  return first && second ? { ...tile, first, second } : (first ?? second)
}
export function resizeTile(tile: Tile, target: string, ratio: number): Tile {
  if (tile.kind === 'pane') return tile
  if (tile.id === target)
    return { ...tile, ratio: Math.max(0.15, Math.min(0.85, ratio)) }
  return {
    ...tile,
    first: resizeTile(tile.first, target, ratio),
    second: resizeTile(tile.second, target, ratio),
  }
}
export function tileLayout(
  tile: Tile,
  bounds: Rect = { x: 0, y: 0, width: 1, height: 1 }
): { panes: Record<string, Rect>; dividers: Divider[] } {
  if (tile.kind === 'pane')
    return { panes: { [tile.id]: bounds }, dividers: [] }
  const horizontal = tile.direction === 'right'
  const first = {
    ...bounds,
    ...(horizontal
      ? { width: bounds.width * tile.ratio }
      : { height: bounds.height * tile.ratio }),
  }
  const second = horizontal
    ? {
        ...bounds,
        x: bounds.x + first.width,
        width: bounds.width - first.width,
      }
    : {
        ...bounds,
        y: bounds.y + first.height,
        height: bounds.height - first.height,
      }
  const a = tileLayout(tile.first, first),
    b = tileLayout(tile.second, second)
  return {
    panes: { ...a.panes, ...b.panes },
    dividers: [
      { id: tile.id, direction: tile.direction, ratio: tile.ratio, bounds },
      ...a.dividers,
      ...b.dividers,
    ],
  }
}

export function dockTile(
  tile: Tile,
  target: string,
  pane: string,
  zone: Exclude<DropZone, 'center'>
): Tile {
  if (tile.kind === 'pane') {
    if (tile.id !== target) return tile
    const before = zone === 'left' || zone === 'top'
    const added: Tile = { kind: 'pane', id: pane }
    return {
      kind: 'split',
      id: requestId(),
      direction: zone === 'left' || zone === 'right' ? 'right' : 'down',
      ratio: 0.5,
      first: before ? added : tile,
      second: before ? tile : added,
    }
  }
  return {
    ...tile,
    first: dockTile(tile.first, target, pane, zone),
    second: dockTile(tile.second, target, pane, zone),
  }
}

export function dropZone(x: number, y: number): DropZone {
  if (x >= 0.3 && x <= 0.7 && y >= 0.3 && y <= 0.7) return 'center'
  const distances: [DropZone, number][] = [
    ['left', x],
    ['right', 1 - x],
    ['top', y],
    ['bottom', 1 - y],
  ]
  return distances.sort((a, b) => a[1] - b[1])[0][0]
}
