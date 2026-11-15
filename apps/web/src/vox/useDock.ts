import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'

type Edge = 'left' | 'right' | 'top' | 'bottom'
type Dock = { edge: Edge; offset: number }
type Point = { x: number; y: number }
type Viewport = { x: number; y: number; width: number; height: number }
type Drag = { id: number; start: Point; origin: Point; element: HTMLElement; moved: boolean }

const SIZE = 56, MARGIN = 16, GAP = 12, STORAGE = 'aixand.vox.position'
const DEFAULT: Dock = { edge: 'bottom', offset: 1 }
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)))

function viewport(): Viewport {
  const view = window.visualViewport
  return { x: view?.offsetLeft ?? 0, y: view?.offsetTop ?? 0,
    width: view?.width ?? window.innerWidth, height: view?.height ?? window.innerHeight }
}
function limits(view: Viewport) {
  return { left: view.x + MARGIN, right: Math.max(view.x + MARGIN, view.x + view.width - MARGIN - SIZE),
    top: view.y + MARGIN, bottom: Math.max(view.y + MARGIN, view.y + view.height - MARGIN - SIZE) }
}
function constrained(point: Point, view: Viewport): Point {
  const box = limits(view)
  return { x: clamp(point.x, box.left, box.right), y: clamp(point.y, box.top, box.bottom) }
}
function position(dock: Dock, view: Viewport): Point {
  const box = limits(view), horizontal = dock.edge === 'top' || dock.edge === 'bottom'
  return horizontal ? { x: box.left + dock.offset * (box.right - box.left), y: box[dock.edge as 'top' | 'bottom'] } :
    { x: box[dock.edge as 'left' | 'right'], y: box.top + dock.offset * (box.bottom - box.top) }
}
function snapped(point: Point, view: Viewport): Dock {
  const box = limits(view), value = constrained(point, view)
  const distances: [Edge, number][] = [['left', value.x - box.left], ['right', box.right - value.x],
    ['top', value.y - box.top], ['bottom', box.bottom - value.y]]
  const edge = distances.sort((a, b) => a[1] - b[1])[0][0]
  const offset = edge === 'left' || edge === 'right' ? (value.y - box.top) / Math.max(1, box.bottom - box.top) :
    (value.x - box.left) / Math.max(1, box.right - box.left)
  return { edge, offset: clamp(offset, 0, 1) }
}
function saved(): Dock {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE) ?? 'null')
    if (value && ['left', 'right', 'top', 'bottom'].includes(value.edge) &&
        typeof value.offset === 'number' && Number.isFinite(value.offset) && value.offset >= 0 && value.offset <= 1)
      return { edge: value.edge, offset: value.offset }
  } catch { /* Position preferences are optional when browser storage is unavailable. */ }
  return DEFAULT
}

/** Keep the call head reachable as the viewport, keyboard, and dock edge change. */
export function useDock() {
  const [dock, setDock] = useState(saved)
  const [view, setView] = useState(viewport)
  const [live, setLive] = useState<Point | null>(null)
  const drag = useRef<Drag | null>(null)
  const moved = useRef(false)
  const current = useRef({ dock, view, point: position(dock, view) })
  const frame = useRef<number | null>(null)
  const pending = useRef<Point | null>(null)
  const point = live ?? position(dock, view)
  current.current = { dock, view, point }

  function store(value: Dock) {
    setDock(value)
    try { localStorage.setItem(STORAGE, JSON.stringify(value)) } catch { /* Keep the in-memory position. */ }
  }

  useEffect(() => {
    function cancelFrame() {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
    function move(event: globalThis.PointerEvent) {
      const active = drag.current
      if (!active || event.pointerId !== active.id) return
      const dx = event.clientX - active.start.x, dy = event.clientY - active.start.y
      if (!active.moved && Math.hypot(dx, dy) < 6) return
      if (!active.moved) {
        active.moved = true; moved.current = true
        active.element.setPointerCapture(active.id)
      }
      if (event.cancelable) event.preventDefault()
      pending.current = constrained({ x: active.origin.x + dx, y: active.origin.y + dy }, current.current.view)
      if (frame.current === null) frame.current = requestAnimationFrame(() => {
        frame.current = null
        setLive(pending.current)
      })
    }
    function finish(event: globalThis.PointerEvent) {
      const active = drag.current
      if (!active || event.pointerId !== active.id) return
      cancelFrame(); drag.current = null
      if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
      if (active.moved) {
        const end = event.type === 'pointercancel' ? pending.current ?? current.current.point : constrained({
          x: active.origin.x + event.clientX - active.start.x, y: active.origin.y + event.clientY - active.start.y,
        }, current.current.view)
        store(snapped(end, current.current.view))
      }
      pending.current = null; setLive(null)
    }
    function resize() {
      cancelFrame()
      const active = drag.current
      drag.current = null; pending.current = null
      if (active?.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
      setLive(null); setView(viewport())
    }
    window.addEventListener('pointermove', move, { capture: true, passive: false })
    window.addEventListener('pointerup', finish, true)
    window.addEventListener('pointercancel', finish, true)
    window.addEventListener('resize', resize)
    window.addEventListener('blur', resize)
    window.visualViewport?.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('scroll', resize)
    return () => {
      cancelFrame()
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', finish, true)
      window.removeEventListener('pointercancel', finish, true)
      window.removeEventListener('resize', resize)
      window.removeEventListener('blur', resize)
      window.visualViewport?.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('scroll', resize)
    }
  }, [])

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || drag.current ||
        !(event.target instanceof Element) || !event.target.closest('.vox-trigger')) return
    moved.current = false
    const rect = event.currentTarget.getBoundingClientRect()
    drag.current = { id: event.pointerId, start: { x: event.clientX, y: event.clientY },
      origin: { x: rect.left, y: rect.top }, element: event.currentTarget, moved: false }
  }
  function canPress(pointerType: string) {
    if (pointerType === 'keyboard' || pointerType === 'virtual') { moved.current = false; return true }
    return !moved.current
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element) || !event.target.closest('.vox-trigger') ||
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return
    event.preventDefault()
    const box = limits(view), verticalOffset = clamp((point.y - box.top) / Math.max(1, box.bottom - box.top), 0, 1)
    if (event.key === 'Home') store(DEFAULT)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      store({ edge: event.key === 'ArrowLeft' ? 'left' : 'right', offset: verticalOffset })
    else if (dock.edge === 'left' || dock.edge === 'right')
      store({ edge: dock.edge, offset: clamp(verticalOffset + (event.key === 'ArrowUp' ? -32 : 32) / Math.max(1, box.bottom - box.top), 0, 1) })
    else store({ edge: event.key === 'ArrowUp' ? 'top' : 'bottom', offset: dock.offset })
  }

  const side = point.x + SIZE / 2 < view.x + view.width / 2 ? 'left' : 'right'
  const above = point.y + SIZE / 2 > view.y + view.height / 2
  function overlay(width: number): CSSProperties {
    const fitted = Math.min(width, Math.max(0, view.width - MARGIN * 2))
    const available = above ? point.y - view.y - MARGIN - GAP : view.y + view.height - MARGIN - point.y - SIZE - GAP
    return { width: fitted, left: clamp(side === 'left' ? point.x : point.x + SIZE - fitted,
      view.x + MARGIN, view.x + view.width - MARGIN - fitted),
      ...(above ? { bottom: window.innerHeight - point.y + GAP } : { top: point.y + SIZE + GAP }),
      maxHeight: Math.max(0, available) }
  }
  return { side, above, dragging: live !== null, pointerDown, keyDown, canPress, overlay,
    style: { left: point.x, top: point.y } satisfies CSSProperties }
}
