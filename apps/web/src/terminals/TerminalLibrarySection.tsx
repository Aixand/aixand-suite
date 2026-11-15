import { useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Icon } from 'bbb-design'
import type { IconName } from 'bbb-design'

export const defaultSectionHeight = 160
const minimumHeight = 64
const maximumHeight = 960
export const sectionHeight = (value: number) => Math.max(minimumHeight, Math.min(maximumHeight, value))

export function TerminalLibrarySection({ id, title, icon, count, expanded, fillAvailable = false, height, rows, toggle, resize }: {
  id: string
  title: string
  icon: IconName
  count: number
  expanded: boolean
  fillAvailable?: boolean
  height?: number
  rows: RefObject<HTMLDivElement | null>
  toggle: () => void
  resize: (height: number | undefined) => void
}) {
  const drag = useRef<{ start: number; height: number } | null>(null)
  const [resizing, setResizing] = useState(false)
  const rowsId = `terminal-section-${id}`
  const maxHeight = height ?? defaultSectionHeight
  const finish = () => { drag.current = null; setResizing(false) }
  return <section className="tw-library-section" data-section={id} data-fill={fillAvailable || undefined} aria-label={title}>
    <h3 className={`workspace-sidebar__section-label tw-app-heading${id === 'servers' ? ' tw-servers-heading' : id === 'inactive' ? ' tw-inactive-heading' : ''}`}>
      <button type="button" className="workspace-sidebar__section-heading" aria-label={title} aria-expanded={expanded} aria-controls={rowsId} onClick={toggle}>
        <Icon name={icon} />
        <span>{title}</span>
        <span className={`workspace-sidebar__count tw-section-count${id === 'inactive' ? ' tw-inactive-count' : ''}`}>{count}</span>
        <Icon name="chevron-right" className="tw-section-chevron" />
      </button>
    </h3>
    <div ref={rows} id={rowsId} className="tw-section-rows" hidden={!expanded}
      role="region" aria-label={`Terminals in ${title}`} tabIndex={0}
      style={{ maxHeight: fillAvailable ? undefined : maxHeight, height: fillAvailable ? undefined : height }}>
      {!count && <p className="tw-section-empty">{id === 'inactive' ? 'No stopped, failed, or unavailable terminals.' : 'No terminals in this section.'}</p>}
    </div>
    {expanded && !fillAvailable && <div className="tw-section-resize" role="separator" tabIndex={0}
      aria-label={`Resize ${title} section`} aria-orientation="horizontal" aria-controls={rowsId}
      aria-valuemin={minimumHeight} aria-valuemax={maximumHeight} aria-valuenow={Math.round(maxHeight)}
      aria-valuetext={`${Math.round(maxHeight)} pixels${height === undefined ? ' maximum height' : ' height'}`}
      title="Drag to resize · Up/Down arrows to adjust · Double-click to reset"
      data-resizing={resizing || undefined}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { start: event.clientY, height: rows.current?.getBoundingClientRect().height ?? maxHeight }
        setResizing(true)
      }}
      onPointerMove={event => {
        if (drag.current) resize(sectionHeight(drag.current.height + event.clientY - drag.current.start))
      }}
      onPointerUp={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        finish()
      }}
      onPointerCancel={finish} onLostPointerCapture={finish}
      onDoubleClick={() => resize(undefined)}
      onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key)) return
        event.preventDefault()
        if (event.key === 'Enter') { resize(undefined); return }
        const step = event.shiftKey ? 128 : 32
        const currentHeight = rows.current?.getBoundingClientRect().height ?? maxHeight
        resize(sectionHeight(event.key === 'Home' ? minimumHeight : event.key === 'End' ? maximumHeight
          : currentHeight + (event.key === 'ArrowUp' ? -step : step)))
      }} />}
  </section>
}
