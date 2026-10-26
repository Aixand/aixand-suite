import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** Add a keyboard stop only when content actually needs to scroll. */
export function ScrollRegion({ as: Element = 'div', label, className, children }: {
  as?: 'div' | 'pre'; label: string; className?: string; children: ReactNode
}) {
  const ref = useRef<HTMLDivElement & HTMLPreElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [children])
  return <Element ref={ref} className={className} role={overflowing ? 'region' : undefined}
    aria-label={overflowing ? label : undefined} tabIndex={overflowing ? 0 : undefined}>{children}</Element>
}
