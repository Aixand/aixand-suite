import { Test } from '@nestjs/testing';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AppController } from '../src/app.controller.js';
import { AppService } from '../src/app.service.js';
import { configureApp } from '../src/configure-app.js';
import { serveProductionFrontend } from '../src/production.js';
import { authFixture, fixturePassword } from './auth-fixture.js';

@Controller('production-test')
class ProtectedController {
  @Get() read() { return { protected: true }; }
}

describe('Production frontend and API share one server', () => {
  let app: INestApplication;
  let fixture: Awaited<ReturnType<typeof authFixture>>;
  let sockets: WebSocketServer;
  let origin: string;
  beforeEach(async () => {
    fixture = await authFixture(true);
    const frontend = join(fixture.directory, 'web');
    mkdirSync(join(frontend, 'assets'), { recursive: true });
    writeFileSync(join(frontend, 'index.html'), '<!doctype html><title>Aixand workspace</title>');
    writeFileSync(join(frontend, 'recovery.html'), '<!doctype html><title>Aixand recovery</title>');
    writeFileSync(join(frontend, 'assets/main-0123456789.js'), 'console.log("production");');
    writeFileSync(join(frontend, '.env'), 'fixture=must-not-be-served');
    vi.stubEnv('AIXAND_AUTH_DEV_HTTP', '0');
    vi.stubEnv('AIXAND_AUTH_LOOPBACK_HTTP', '1');
    vi.stubEnv('AIXAND_AUTH_COOKIE_NAMESPACE', 'production-test');
    const module = await Test.createTestingModule({
      imports: [AuthModule], controllers: [AppController, ProtectedController], providers: [AppService],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    serveProductionFrontend(app, frontend);
    await app.listen(0, '127.0.0.1');
    origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    vi.stubEnv('CORS_ORIGINS', origin);
    sockets = new WebSocketServer({ server: app.getHttpServer(), path: '/api/production-test/ws' });
    sockets.on('connection', (socket, incoming) => {
      if (app.get(AuthService).authorizeSocket(socket, incoming)) socket.send('authenticated');
    });
  });
  afterEach(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await app.close();
    fixture.cleanup();
    vi.unstubAllEnvs();
  });
  const api = () => request(app.getHttpServer());
  async function setup() {
    const response = await api().post('/api/auth/setup').set('Origin', origin)
      .send({ password: fixturePassword, confirmation: fixturePassword }).expect(201);
    const cookie = response.headers['set-cookie'][0].split(';')[0];
    expect(cookie).toMatch(/^aixand-session-production-test=/);
    return cookie;
  }

  it('serves HTML, recovery, cached hashed assets, HEAD, and health through the same listener', async () => {
    await api().get('/').expect(200).expect('Content-Type', /html/).expect('Cache-Control', 'no-cache');
    await api().head('/').expect(200);
    await api().get('/recovery.html').expect(200).expect(/Aixand recovery/);
    await api().get('/assets/main-0123456789.js').expect(200)
      .expect('Cache-Control', 'public, max-age=31536000, immutable');
    await api().get('/api/health').expect(200, { status: 'ok', service: 'aixand-server' });
  });
  it('does not expose dotfiles, traversal paths, or replace missing API responses with HTML', async () => {
    await api().get('/.env').expect(404);
    await api().get('/%2e%2e%2fsecret').expect(404);
    await api().get('/missing.js').expect(404);
    await api().get('/api/production-test').expect(401).expect('Content-Type', /json/);
    const cookie = await setup();
    await api().get('/api/missing').set('Cookie', cookie).expect(404).expect('Content-Type', /json/);
  });
  it('preserves local first-password setup, session cookies, origin checks, CSRF, and sign-out', async () => {
    const cookie = await setup();
    await api().get('/api/production-test').set('Cookie', cookie).expect(200, { protected: true });
    const session = await api().get('/api/auth/session').set('Cookie', cookie).expect(200);
    await api().post('/api/auth/logout').set('Origin', origin).set('Cookie', cookie).send({}).expect(403);
    await api().post('/api/auth/logout').set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', cookie).set('X-CSRF-Token', session.body.csrfToken).send({}).expect(403);
    await api().post('/api/auth/logout').set('Origin', origin).set('Cookie', cookie)
      .set('X-CSRF-Token', session.body.csrfToken).send({}).expect(201);
    await api().get('/api/auth/session').set('Cookie', cookie).expect(401);
  });
  it('authenticates WebSockets on the frontend port and rejects an unlisted development origin', async () => {
    const cookie = await setup();
    const endpoint = origin.replace('http:', 'ws:') + '/api/production-test/ws';
    const connected = new WebSocket(endpoint, { origin, headers: { Cookie: cookie } });
    await new Promise<void>((resolve, reject) => {
      connected.once('error', reject);
      connected.once('message', raw => { expect(raw.toString()).toBe('authenticated'); connected.close(); resolve(); });
    });
    const rejected = new WebSocket(endpoint, { origin: 'http://127.0.0.1:5173', headers: { Cookie: cookie } });
    await new Promise<void>((resolve, reject) => {
      rejected.once('error', reject);
      rejected.once('close', code => { expect(code).toBe(1008); resolve(); });
    });
  });
});
