import { Test } from '@nestjs/testing';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AppController } from '../src/app.controller.js';
import { AppService } from '../src/app.service.js';
import { configureApp } from '../src/configure-app.js';
import { serveProductionFrontend } from '../src/production.js';
import { authFixture, fixturePassword } from './auth-fixture.js';

@Controller('client-test')
class ProtectedController { @Get() read() { return { protected: true }; } }

describe('Bundled Desktop against a frontend-free authenticated backend', () => {
  let app: INestApplication;
  let fixture: Awaited<ReturnType<typeof authFixture>>;
  let sockets: WebSocketServer;
  let client: { origin: string; address: string; close(): Promise<void> };
  let cookie: string;
  beforeEach(async () => {
    fixture = await authFixture(true);
    const web = join(fixture.directory, 'desktop-web'); mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<title>Desktop-owned interface</title>');
    writeFileSync(join(web, 'recovery.html'), '<title>Desktop recovery</title>');
    vi.stubEnv('AIXAND_AUTH_DEV_HTTP', '0'); vi.stubEnv('AIXAND_AUTH_LOOPBACK_HTTP', '1');
    vi.stubEnv('AIXAND_AUTH_COOKIE_NAMESPACE', 'client-test');
    const module = await Test.createTestingModule({ imports: [AuthModule], controllers: [AppController, ProtectedController], providers: [AppService] }).compile();
    app = module.createNestApplication(); configureApp(app); serveProductionFrontend(app, null);
    await app.listen(0, '127.0.0.1');
    const backend = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    vi.stubEnv('CORS_ORIGINS', backend);
    sockets = new WebSocketServer({ server: app.getHttpServer(), path: '/api/client-test/ws' });
    sockets.on('connection', (socket, request) => { if (app.get(AuthService).authorizeSocket(socket, request)) socket.send('authenticated'); });
    const { startClient } = await import(new URL('../../../scripts/runtime/desktop-client.mjs', import.meta.url).href);
    client = await startClient({ backend, web, profile: 'real-auth-test' });
    const entry = await fetch(client.address, { redirect: 'manual' }); expect(entry.status).toBe(303);
    cookie = entry.headers.get('set-cookie')!.split(';')[0];
    expect((await fetch(backend)).status).toBe(404);
  });
  afterEach(async () => {
    await client?.close();
    for (const socket of sockets?.clients || []) socket.terminate();
    if (sockets) await new Promise<void>(ready => sockets.close(() => ready()));
    await app?.close(); fixture?.cleanup(); vi.unstubAllEnvs();
  });
  async function request(path: string, body?: object, csrf?: string, origin = client.origin) {
    const response = await fetch(client.origin + '/api/' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) cookie += '; ' + value.split(';')[0];
    return response;
  }
  async function setup() {
    expect((await request('auth/setup', { password: fixturePassword, confirmation: fixturePassword })).status).toBe(201);
    const session = await request('auth/session'); expect(session.status).toBe(200); return session.json();
  }
  it('preserves password setup, protected endpoints, CSRF and logout while the backend has no web pages', async () => {
    expect((await fetch(client.origin, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await request('client-test')).status).toBe(401);
    const { csrfToken } = await setup();
    expect((await request('client-test')).status).toBe(200);
    expect((await request('auth/logout', {})).status).toBe(403);
    expect((await request('auth/logout', {}, csrfToken, 'https://untrusted.example')).status).toBe(403);
    expect((await request('auth/logout', {}, csrfToken)).status).toBe(201);
    // Use the empty replacement cookie, not the earlier session value.
    cookie = cookie.split('; ').filter(value => !value.includes('session-')).join('; ');
    expect((await request('auth/session')).status).toBe(401);
  });
  it('retains cookie and origin authentication across WebSocket upgrades', async () => {
    await setup();
    const socket = new WebSocket(client.origin.replace('http:', 'ws:') + '/api/client-test/ws', { origin: client.origin, headers: { Cookie: cookie } });
    try {
      await new Promise<void>((ready, fail) => { socket.once('error', fail); socket.once('message', message => { expect(String(message)).toBe('authenticated'); ready(); }); });
    } finally { socket.terminate(); }
  });
});
