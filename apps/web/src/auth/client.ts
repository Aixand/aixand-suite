import { workspaceFetch, workspaceSocket } from './transport'
export async function authRequest<T>(
  path: string,
  body?: unknown,
  csrfToken?: string
): Promise<T> {
  const response = await workspaceFetch(`/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers:
      body === undefined
        ? {}
        : {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new AuthError(
      response.status,
      typeof value.message === 'string'
        ? value.message
        : 'Could not reach authentication. Check the server connection.'
    )
  return value as T
}
export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
export function sessionSocket(path: string) {
  const socket = workspaceSocket(path)
  socket.addEventListener('close', (event) => {
    if (event.code === 1008)
      window.dispatchEvent(new Event('aixand-auth-check'))
  })
  return socket
}
