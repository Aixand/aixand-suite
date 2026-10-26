import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Header, Menu, MenuItem, MenuSection, Text } from 'react-aria-components'
import { library } from './model'
import type { NodeKind } from './model'
import { BuilderIcon } from './StepNode'

export type NodeMenuPosition = {
  anchor: { x: number; y: number }
  point: { x: number; y: number }
  bounds: { width: number; height: number }
}

export function NodeMenu({
  position,
  add,
  close,
}: {
  position: NodeMenuPosition
  add: (kind: NodeKind) => void
  close: (restoreFocus?: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState(position.anchor)

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const place = () =>
      setAnchor({
        x: Math.max(
          8,
          Math.min(
            position.anchor.x,
            position.bounds.width - menu.offsetWidth - 8,
          ),
        ),
        y: Math.max(
          8,
          Math.min(
            position.anchor.y,
            position.bounds.height - menu.offsetHeight - 8,
          ),
        ),
      })
    place()
    const observer = new ResizeObserver(place)
    observer.observe(menu)
    return () => observer.disconnect()
  }, [position])

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target))
        close()
    }
    const resize = () => close()
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('resize', resize)
    }
  }, [close])

  return (
    <div
      ref={ref}
      className="wb-context-menu nodrag nopan"
      style={{ left: anchor.x, top: anchor.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault()
          event.stopPropagation()
          close(true)
        }
      }}
    >
      <p className="wb-context-title">Add node</p>
      <Menu
        aria-label="Add workflow node"
        autoFocus="first"
        className="wb-context-items"
        onAction={(kind) => add(kind as NodeKind)}
      >
        {([
          { title: 'Agents', kinds: ['chat', 'agent', 'tool'] },
          { title: 'Flow and outputs', kinds: ['input', 'task', 'collector', 'result', 'human-inbox', 'done'] },
          { title: 'Carrier messages', kinds: ['mailbox', 'message', 'reply', 'ack'] },
          { title: 'Advanced session control', kinds: ['spawn', 'send', 'wait'] },
        ] as { title: string; kinds: NodeKind[] }[]).map((group) => <MenuSection key={group.title} aria-label={group.title}>
          <Header className="wb-context-group">{group.title}</Header>
          {group.kinds.map((kind) => library.find((item) => item.kind === kind)!).map((item) => (
          <MenuItem
            id={item.kind}
            key={item.kind}
            textValue={item.title}
            className="wb-context-item"
          >
            <span className={`wb-step-icon wb-step-icon--${item.kind}`}>
              <BuilderIcon kind={item.kind} />
            </span>
            <span>
              <Text slot="label">{item.title}</Text>
              <Text slot="description">{item.description}</Text>
            </span>
          </MenuItem>
          ))}
        </MenuSection>)}
      </Menu>
    </div>
  )
}
