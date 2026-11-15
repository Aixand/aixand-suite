import { useLayoutEffect, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'

// A stable portal keeps row menus alive when a session moves between sections.
export function TerminalLibrarySlot({ container, order, children }: {
  container: RefObject<HTMLDivElement | null>
  order: number
  children: ReactNode
}) {
  const [slot] = useState(() => {
    const element = document.createElement('div')
    element.className = 'tw-library-slot'
    return element
  })
  useLayoutEffect(() => {
    const parent = container.current
    if (!parent) return
    slot.dataset.order = String(order)
    const next = Array.from(parent.children).find(child =>
      child !== slot && child instanceof HTMLElement && Number(child.dataset.order) > order
    ) ?? null
    if (slot.parentElement !== parent || slot.nextElementSibling !== next)
      parent.insertBefore(slot, next)
  }, [container, order, slot])
  useLayoutEffect(() => () => slot.remove(), [slot])
  return createPortal(children, slot)
}
