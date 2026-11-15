import type { IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const SESSION_LIFETIME = 12 * 60 * 60 * 1000;
export const SESSION_IDLE = 60 * 60 * 1000;
export function authDatabasePath() {
  return resolve(
    process.env.AIXAND_AUTH_DATABASE ??
      join(homedir(), '.aixand/suite/auth/auth.db'),
  );
}
export function allowedOrigins(): string[] {
  return (
    process.env.CORS_ORIGINS ??
    'http://localhost:5186,http://localhost:5173,http://127.0.0.1:5186,http://127.0.0.1:5173'
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}
export function normalizeAddress(address = '') {
  return address.replace(/^::ffff:/, '');
}
export function trustedProxy(address?: string) {
  const peers = (process.env.AIXAND_TRUST_PROXY ?? '')
    .split(',')
    .map((value) => normalizeAddress(value.trim()))
    .filter(Boolean);
  return peers.includes(normalizeAddress(address));
}
export function loopbackHost(host: string) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(
      new URL(`http://${host}`).hostname,
    );
  } catch {
    return false;
  }
}
export function localSetupRequest(request: IncomingMessage): boolean {
  // Setup is direct and local, before configuring any production reverse proxy.
  // Never infer locality from headers that a remote client can supply.
  if (
    !['127.0.0.1', '::1'].includes(
      normalizeAddress(request.socket.remoteAddress),
    )
  )
    return false;
  if (trustedProxy(request.socket.remoteAddress)) return false;
  if (
    Object.keys(request.headers).some(
      (name) => name === 'forwarded' || name.startsWith('x-forwarded-'),
    )
  )
    return false;
  if (!loopbackHost(request.headers.host ?? '')) return false;
  // Same-origin GET status requests omit Origin; password creation must include it.
  if (!request.headers.origin)
    return request.method === 'GET' || request.method === 'HEAD';
  try {
    const origin = new URL(request.headers.origin ?? '');
    return (
      ['http:', 'https:'].includes(origin.protocol) &&
      loopbackHost(origin.host) &&
      validOrigin(request)
    );
  } catch {
    return false;
  }
}
export function secureTransport(request: IncomingMessage): boolean {
  if ('encrypted' in request.socket && request.socket.encrypted) return true;
  if (
    trustedProxy(request.socket.remoteAddress) &&
    request.headers['x-forwarded-proto'] === 'https'
  )
    return true;
  if ((process.env.AIXAND_AUTH_LOOPBACK_HTTP ?? process.env.AIXAND_AUTH_DEV_HTTP) !== '1') return false;
  if (
    !['127.0.0.1', '::1'].includes(
      normalizeAddress(request.socket.remoteAddress),
    )
  )
    return false;
  // A loopback Vite proxy can expose explicitly configured HTTP development
  // origins. This exception never applies to production or arbitrary Host values.
  if (process.env.NODE_ENV !== 'production' && process.env.AIXAND_AUTH_DEV_HTTP === '1') {
    const origins = (process.env.AIXAND_AUTH_DEV_HTTP_ORIGINS ?? '').split(',').map(value => value.trim());
    const selected = origins.find(value => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' && url.origin === value &&
          url.host === request.headers.host && allowedOrigins().includes(value);
      } catch { return false; }
    });
    if (selected && (!request.headers.origin || request.headers.origin === selected)) return true;
  }
  if (!loopbackHost(request.headers.host ?? '')) return false;
  const origin = request.headers.origin;
  return (
    !origin ||
    (origin.startsWith('http://') && loopbackHost(new URL(origin).host))
  );
}
export function validOrigin(request: IncomingMessage): boolean {
  return (
    typeof request.headers.origin === 'string' &&
    allowedOrigins().includes(request.headers.origin)
  );
}
export function clientAddress(request: IncomingMessage): string {
  // Express resolves req.ip using the explicitly configured trusted-proxy predicate.
  const expressRequest = request as IncomingMessage & { ip?: string };
  return normalizeAddress(
    expressRequest.ip ?? request.socket.remoteAddress,
  ).slice(0, 100);
}
export function cookieName(request: IncomingMessage) {
  const actualTls =
    ('encrypted' in request.socket && request.socket.encrypted) ||
    (trustedProxy(request.socket.remoteAddress) &&
      request.headers['x-forwarded-proto'] === 'https');
  const namespace = process.env.AIXAND_AUTH_COOKIE_NAMESPACE;
  if (namespace) {
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(namespace))
      throw new Error('Invalid authentication cookie namespace');
    return `${actualTls ? '__Host-' : ''}aixand-session-${namespace}`;
  }
  return actualTls ? '__Host-aixand-session' : 'aixand-dev-session';
}
