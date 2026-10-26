import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProductionEnvironment, productionConfiguration } from './production.js';
import { cookieName, secureTransport } from './auth/config.js';
import type { IncomingMessage } from 'node:http';

describe('Production configuration', () => {
  let original: NodeJS.ProcessEnv;
  let directory: string;
  beforeEach(() => {
    original = { ...process.env };
    for (const key of Object.keys(process.env))
      if (key.startsWith('AIXAND_PRODUCTION_')) delete process.env[key];
    directory = mkdtempSync(join(tmpdir(), 'aixand-production-config-'));
    mkdirSync(join(directory, 'web'));
    for (const file of ['index.html', 'recovery.html']) writeFileSync(join(directory, 'web', file), '<html></html>');
    process.env.AIXAND_PRODUCTION_WEB_DIST = join(directory, 'web');
    process.env.AIXAND_AUTH_DATABASE = join(directory, 'auth.db');
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(directory, { recursive: true, force: true });
  });

  it('uses 8753 and isolates production origins and cookie names from development', () => {
    Object.assign(process.env, { PORT: '3001', HOST: '0.0.0.0', CORS_ORIGINS: 'http://localhost:5173', AIXAND_AUTH_DEV_HTTP: '1' });
    expect(productionConfiguration()).toMatchObject({ port: 8753, host: '127.0.0.1', transport: 'loopback' });
    expect(process.env.CORS_ORIGINS).toBe('http://127.0.0.1:8753,http://localhost:8753');
    expect(process.env.AIXAND_AUTH_COOKIE_NAMESPACE).toMatch(/^prod-[a-f0-9]{12}$/);
    expect(process.env.AIXAND_AUTH_LOOPBACK_HTTP).toBe('1');
    expect(process.env.AIXAND_AUTH_DEV_HTTP).toBe('0');
  });
  it.each(['0', '87532', '3.5', 'not-a-port'])('rejects invalid production port %s', value => {
    process.env.AIXAND_PRODUCTION_PORT = value;
    expect(() => productionConfiguration()).toThrow('AIXAND_PRODUCTION_PORT');
  });
  it('accepts an explicitly configured SSH forwarding origin', () => {
    process.env.AIXAND_PRODUCTION_ORIGINS = 'http://127.0.0.1:18753';
    expect(productionConfiguration().origins).toEqual(['http://127.0.0.1:18753']);
  });
  it('requires exact origins and a private listener', () => {
    process.env.AIXAND_PRODUCTION_ORIGINS = 'http://127.0.0.1:8753/path';
    expect(() => productionConfiguration()).toThrow('exact HTTP(S) origins');
    delete process.env.AIXAND_PRODUCTION_ORIGINS;
    process.env.AIXAND_PRODUCTION_HOST = '0.0.0.0';
    expect(() => productionConfiguration()).toThrow('binds loopback');
  });
  it('requires explicit HTTPS proxy settings and disables both loopback HTTP flags', () => {
    process.env.AIXAND_PRODUCTION_TRANSPORT = 'https-proxy';
    expect(() => productionConfiguration()).toThrow('HTTPS frontend origins');
    process.env.AIXAND_PRODUCTION_ORIGINS = 'https://suite.example';
    expect(() => productionConfiguration()).toThrow('AIXAND_PRODUCTION_TRUST_PROXY');
    process.env.AIXAND_PRODUCTION_TRUST_PROXY = '127.0.0.1';
    productionConfiguration();
    expect(process.env.AIXAND_AUTH_LOOPBACK_HTTP).toBe('0');
    expect(process.env.AIXAND_AUTH_DEV_HTTP).toBe('0');
  });
  it('keeps the loopback HTTP exception limited to local peers and hosts', () => {
    productionConfiguration();
    const incoming = (peer: string, host: string, origin: string) => ({
      socket: { remoteAddress: peer }, headers: { host, origin },
    }) as IncomingMessage;
    expect(secureTransport(incoming('127.0.0.1', '127.0.0.1:8753', 'http://127.0.0.1:8753'))).toBe(true);
    expect(secureTransport(incoming('192.0.2.1', '127.0.0.1:8753', 'http://127.0.0.1:8753'))).toBe(false);
    expect(secureTransport(incoming('127.0.0.1', 'suite.example', 'http://suite.example'))).toBe(false);
    process.env.AIXAND_AUTH_LOOPBACK_HTTP = '0';
    process.env.AIXAND_AUTH_DEV_HTTP = '1';
    expect(secureTransport(incoming('127.0.0.1', '127.0.0.1:8753', 'http://127.0.0.1:8753'))).toBe(false);
  });
  it('gives production instances stable cookie names with secure prefixes for HTTPS', () => {
    productionConfiguration();
    const request = { socket: { remoteAddress: '127.0.0.1' }, headers: {} } as IncomingMessage;
    const name = cookieName(request);
    expect(name).toMatch(/^aixand-session-prod-/);
    productionConfiguration();
    expect(cookieName(request)).toBe(name);
    process.env.AIXAND_AUTH_DATABASE = join(directory, 'another-auth.db');
    productionConfiguration();
    expect(cookieName(request)).not.toBe(name);
    process.env.AIXAND_TRUST_PROXY = '127.0.0.1';
    request.headers['x-forwarded-proto'] = 'https';
    expect(cookieName(request)).toMatch(/^__Host-aixand-session-prod-/);
  });
  it('fails before application startup when the frontend build is absent', () => {
    rmSync(join(directory, 'web/recovery.html'));
    expect(() => productionConfiguration()).toThrow('missing recovery.html');
  });
  it('starts headless without frontend files and retains the production authentication boundary', () => {
    rmSync(join(directory, 'web'), { recursive: true });
    process.env.AIXAND_PRODUCTION_MODE = 'headless';
    expect(productionConfiguration()).toMatchObject({ mode: 'headless', frontend: null, host: '127.0.0.1' });
    expect(process.env.AIXAND_AUTH_LOOPBACK_HTTP).toBe('1');
    expect(process.env.CORS_ORIGINS).toBe('http://127.0.0.1:8753,http://localhost:8753');
    process.env.AIXAND_PRODUCTION_HOST = '0.0.0.0';
    expect(() => productionConfiguration()).toThrow('binds loopback');
  });
  it('rejects unknown production modes', () => {
    process.env.AIXAND_PRODUCTION_MODE = 'typo';
    expect(() => productionConfiguration()).toThrow('AIXAND_PRODUCTION_MODE');
  });
  it('loads deployment settings over the existing .env while respecting explicit environment overrides', () => {
    writeFileSync(join(directory, '.env'), 'AIXAND_PRODUCTION_PORT=9001\nPORT=3001\n');
    writeFileSync(join(directory, '.env.production'), 'AIXAND_PRODUCTION_PORT=8753\n');
    loadProductionEnvironment(directory);
    expect(process.env.AIXAND_PRODUCTION_PORT).toBe('8753');
    process.env.AIXAND_PRODUCTION_PORT = '9002';
    loadProductionEnvironment(directory);
    expect(process.env.AIXAND_PRODUCTION_PORT).toBe('9002');
  });
});
