import type { ComponentProps } from 'react'

// Content may contain a hash link, a copied workspace URL, or a route path.
// Keep app destinations on the current document so its router and drafts survive.
export function workspaceLink(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined
  try {
    const current = new URL(base)
    const destination = new URL(href, current)
    if (destination.origin !== current.origin) return undefined
    if (destination.hash.startsWith('#/') && [current.pathname, '/', '/index.html'].includes(destination.pathname))
      return destination.hash
    if (/^\/(?:home|chat|command|terminals|workflows|carrier|agents|settings)(?:\/|$)/.test(destination.pathname))
      return `#${destination.pathname}${destination.search}${destination.hash}`
  } catch {
    // Leave invalid or non-web URLs to the browser's normal link behavior.
  }
  return undefined
}

export function ContentLink({ href, ...props }: ComponentProps<'a'>) {
  const internal = workspaceLink(href, window.location.href)
  return <a {...props} href={internal ?? href} target={internal ? undefined : '_blank'}
    rel={internal ? undefined : 'noopener noreferrer'} />
}
