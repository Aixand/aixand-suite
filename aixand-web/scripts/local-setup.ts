import type { IncomingMessage, ServerResponse } from 'node:http'

function loopbackHost(host: string) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(
      new URL(`http://${host}`).hostname,
    )
  } catch {
    return false
  }
}

// Vite connects to the backend from loopback even when its browser client is remote.
// Check the original peer before proxying, and never trust client-supplied forwarding headers.
export function localSetup(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) {
  const path = (request.url ?? '')
    .split('?')[0]
    .toLowerCase()
    .replace(/\/+$/, '')
  if (path !== '/api/auth/setup' && path !== '/api/auth/status') return next()
  const address = request.socket.remoteAddress?.replace(/^::ffff:/, '')
  if (
    !['127.0.0.1', '::1'].includes(address ?? '') ||
    !loopbackHost(request.headers.host ?? '') ||
    Object.keys(request.headers).some(
      (name) => name === 'forwarded' || name.startsWith('x-forwarded-'),
    )
  ) {
    // Preserve remote status/login, but let the backend know this request was proxied.
    request.headers['x-forwarded-for'] = address ?? 'unknown'
    if (path === '/api/auth/status') return next()
    response.writeHead(403, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    response.end(
      JSON.stringify({
        message: 'Create the first password locally on the Suite host.',
      }),
    )
    return
  }
  next()
}
