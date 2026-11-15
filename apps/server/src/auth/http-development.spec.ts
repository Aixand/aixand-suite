import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { secureTransport } from './config.js';

const origin = 'http://10.10.0.7:5174';
function request(host = '10.10.0.7:5174', suppliedOrigin: string | null = origin, peer = '127.0.0.1') {
  return { socket: { remoteAddress: peer }, headers: { host, ...(suppliedOrigin ? { origin: suppliedOrigin } : {}) } } as unknown as IncomingMessage;
}
afterEach(() => vi.unstubAllEnvs());
function enable() {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('AIXAND_AUTH_DEV_HTTP', '1');
  vi.stubEnv('AIXAND_AUTH_LOOPBACK_HTTP', '1');
  vi.stubEnv('AIXAND_AUTH_DEV_HTTP_ORIGINS', origin);
  vi.stubEnv('CORS_ORIGINS', origin);
}
describe('explicit HTTP browser development', () => {
  it('accepts the configured browser origin through the loopback proxy', () => {
    enable();
    expect(secureTransport(request())).toBe(true);
    expect(secureTransport(request('10.10.0.7:5174', null))).toBe(true);
  });
  it('requires the HTTP flag and the origin in both explicit lists', () => {
    enable();
    vi.stubEnv('AIXAND_AUTH_DEV_HTTP', '0');
    expect(secureTransport(request())).toBe(false);
    enable(); vi.stubEnv('CORS_ORIGINS', 'http://localhost:5173');
    expect(secureTransport(request())).toBe(false);
  });
  it('rejects unconfigured hosts, foreign origins and direct remote requests', () => {
    enable();
    expect(secureTransport(request('other.test:5174'))).toBe(false);
    expect(secureTransport(request('10.10.0.7:5174', 'http://other.test:5174'))).toBe(false);
    expect(secureTransport(request('10.10.0.7:5174', origin, '10.10.0.10'))).toBe(false);
  });
  it('never enables the LAN exception in production', () => {
    enable(); vi.stubEnv('NODE_ENV', 'production');
    expect(secureTransport(request())).toBe(false);
  });
});
