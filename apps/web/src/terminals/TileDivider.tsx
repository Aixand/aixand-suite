import type { RefObject } from 'react'
import type { Divider } from './layout'

export function TileDivider({
  divider,
  container,
  onResize,
}: {
  divider: Divider
  container: RefObject<HTMLDivElement | null>
  onResize: (ratio: number) => void
}) {
  const horizontal = divider.direction === 'right'
  const { bounds, ratio } = divider
  const coordinate = horizontal
    ? bounds.x + bounds.width * ratio
    : bounds.y + bounds.height * ratio
  return (
    <div
      className={`tile-divider ${horizontal ? 'is-vertical' : 'is-horizontal'}`}
      role="separator"
      tabIndex={0}
      aria-label={horizontal ? 'Resize columns' : 'Resize rows'}
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(ratio * 100)}
      style={
        horizontal
          ? {
              left: `${coordinate * 100}%`,
              top: `${bounds.y * 100}%`,
              height: `${bounds.height * 100}%`,
            }
          : {
              top: `${coordinate * 100}%`,
              left: `${bounds.x * 100}%`,
              width: `${bounds.width * 100}%`,
            }
      }
      onDoubleClick={() => onResize(0.5)}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        event.currentTarget.dataset.dragging = 'true'
      }}
      onPointerMove={(event) => {
        if (
          !event.currentTarget.hasPointerCapture(event.pointerId) ||
          !container.current
        )
          return
        const rect = container.current.getBoundingClientRect()
        const position = horizontal
          ? (event.clientX - rect.left) / rect.width
          : (event.clientY - rect.top) / rect.height
        const value = horizontal
          ? (position - bounds.x) / bounds.width
          : (position - bounds.y) / bounds.height
        onResize(value)
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId)
        delete event.currentTarget.dataset.dragging
      }}
      onLostPointerCapture={(event) => {
        delete event.currentTarget.dataset.dragging
      }}
      onKeyDown={(event) => {
        const negative = horizontal ? 'ArrowLeft' : 'ArrowUp',
          positive = horizontal ? 'ArrowRight' : 'ArrowDown'
        if (![negative, positive, 'Home', 'End', 'Enter'].includes(event.key))
          return
        event.preventDefault()
        onResize(
          event.key === 'Home'
            ? 0.15
            : event.key === 'End'
              ? 0.85
              : event.key === 'Enter'
                ? 0.5
                : ratio + (event.key === negative ? -0.05 : 0.05)
        )
      }}
    />
  )
}
