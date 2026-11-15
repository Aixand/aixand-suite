import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  rmSync,
  statSync,
  renameSync,
  chmodSync,
  copyFileSync,
} from 'node:fs';
import request from 'supertest';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { AuthService } from '../src/auth/auth.service.js';
import {
  AuthStore,
  initializeAuthDatabase,
  tokenHash,
} from '../src/auth/store.js';
import { hashPassword } from '../src/auth/password.js';
import * as passwords from '../src/auth/password.js';
import { SESSION_IDLE } from '../src/auth/config.js';
import { authFixture, fixturePassword, fixtureOrigin } from './auth-fixture.js';

describe('Workspace password authentication', () => {
  let app: INestApplication;
  let fixture: Awaited<ReturnType<typeof authFixture>>;
  let url: string;
  beforeEach(async () => {
    fixture = await authFixture(true);
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await app.close();
    fixture.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const body = (password = fixturePassword) => ({
    password,
    confirmation: password,
  });
  const api = () => request(app.getHttpServer());
  async function setup() {
    return api()
      .post('/api/auth/setup')
      .set('Origin', fixtureOrigin)
      .send(body())
      .expect(201);
  }
  async function login(password = fixturePassword) {
    const response = await api()
      .post('/api/auth/login')
      .set('Origin', fixtureOrigin)
      .send({ password })
      .expect(201);
    const cookies = response.headers['set-cookie'];
    return (Array.isArray(cookies) ? cookies[0] : cookies).split(';')[0];
  }
  async function closed(
    path: string,
    cookie?: string,
    origin = fixtureOrigin,
    command?: unknown,
  ) {
    return new Promise<{ code: number; messages: unknown[] }>(
      (resolve, reject) => {
        const socket = new WebSocket(url.replace('http:', 'ws:') + path, {
          origin,
          headers: cookie ? { Cookie: cookie } : {},
        });
        const messages: unknown[] = [];
        socket.on('message', (raw) =>
          messages.push(JSON.parse(raw.toString())),
        );
        socket.on('open', () => {
          if (command) socket.send(JSON.stringify(command));
        });
        socket.on('error', reject);
        socket.on('close', (code) => resolve({ code, messages }));
      },
    );
  }
  it('creates the password once, signs in immediately, and stores a private salted hash', async () => {
    const response = await setup();
    const cookie = response.headers['set-cookie'][0].split(';')[0];
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Strict');
    await api().get('/api/auth/session').set('Cookie', cookie).expect(200);
    await api().get('/api/auth/status').expect(200, { state: 'configured' });
    const credential = app.get(AuthService).store.credential();
    expect(credential.password_hash).toMatch(/^\$argon2id\$/);
    expect(credential.password_hash).not.toContain(fixturePassword);
    expect(credential).not.toHaveProperty('setup_secret_hash');
    expect(statSync(fixture.file).mode & 0o777).toBe(0o600);
    await api()
      .post('/api/auth/setup')
      .set('Origin', fixtureOrigin)
      .send(body())
      .expect(401);
  });
  it.each([
    ['X-Forwarded-For', '127.0.0.1'],
    ['X-Forwarded-Host', 'localhost:5186'],
    ['X-Forwarded-Proto', 'http'],
    ['Forwarded', 'for=127.0.0.1'],
  ])(
    'rejects forwarded setup with %s even if it claims loopback',
    async (header, value) => {
      await api()
        .post('/api/auth/setup')
        .set('Origin', fixtureOrigin)
        .set(header, value)
        .send(body())
        .expect(403);
      expect(app.get(AuthService).store.credential().state).toBe(
        'setup_pending',
      );
    },
  );
  it('rejects setup through a trusted proxy and an allowed remote origin', async () => {
    vi.stubEnv('AIXAND_TRUST_PROXY', '127.0.0.1');
    await api()
      .post('/api/auth/setup')
      .set('Origin', fixtureOrigin)
      .send(body())
      .expect(403);
    vi.stubEnv('AIXAND_TRUST_PROXY', '');
    vi.stubEnv('CORS_ORIGINS', 'https://suite.example');
    vi.stubEnv('AIXAND_TRUST_PROXY', '127.0.0.1');
    await api()
      .post('/api/auth/setup')
      .set('Origin', 'https://suite.example')
      .set('X-Forwarded-Proto', 'https')
      .send(body())
      .expect(403);
  });
  it('reports whether local setup is available without requiring Origin on a same-origin GET', async () => {
    await api()
      .get('/api/auth/status')
      .expect(200, { state: 'setup_pending', setupAllowed: true });
    await api()
      .get('/api/auth/status')
      .set('X-Forwarded-For', '192.0.2.1')
      .expect(200, { state: 'setup_pending', setupAllowed: false });
  });
  it('allows only one concurrent setup request to configure a password', async () => {
    const results = await Promise.all(
      [0, 1].map(() =>
        api().post('/api/auth/setup').set('Origin', fixtureOrigin).send(body()),
      ),
    );
    expect(results.map((response) => response.status).sort()).toEqual([
      201, 401,
    ]);
    expect(
      results.filter((response) => response.headers['set-cookie']).length,
    ).toBe(1);
    expect(
      app
        .get(AuthService)
        .store.db.prepare('SELECT count(*) AS count FROM auth_sessions')
        .get()?.count,
    ).toBe(1);
  });
  it('rolls back password creation if its initial session cannot be saved', async () => {
    const store = app.get(AuthService).store;
    store.db.exec(
      "CREATE TRIGGER reject_session BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT, 'fixture session failure'); END",
    );
    await api()
      .post('/api/auth/setup')
      .set('Origin', fixtureOrigin)
      .send(body())
      .expect(500);
    expect(store.credential().state).toBe('setup_pending');
    expect(
      store.db.prepare('SELECT count(*) AS count FROM auth_sessions').get()
        ?.count,
    ).toBe(0);
    store.db.exec('DROP TRIGGER reject_session');
    await setup();
  });
  it('validates password length, confirmation, and unexpected fields', async () => {
    for (const input of [
      body('short'),
      { ...body(), confirmation: 'different' },
      { ...body(), admin: true },
      { ...body(), secret: 'obsolete-setup-field' },
    ]) {
      await api()
        .post('/api/auth/setup')
        .set('Origin', fixtureOrigin)
        .send(input)
        .expect(400);
    }
  });
  it('logs in with a private cookie, survives refresh, and rejects incorrect passwords', async () => {
    await setup();
    await api()
      .post('/api/auth/login')
      .set('Origin', fixtureOrigin)
      .send({ password: 'incorrect' })
      .expect(401);
    const response = await api()
      .post('/api/auth/login')
      .set('Origin', fixtureOrigin)
      .send({ password: fixturePassword })
      .expect(201);
    const header = response.headers['set-cookie'];
    const cookies = Array.isArray(header) ? header : [header];
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain('SameSite=Strict');
    const cookie = cookies[0].split(';')[0];
    for (let attempt = 0; attempt < 2; attempt++)
      await api().get('/api/auth/session').set('Cookie', cookie).expect(200);
  });
  it('requires HTTPS outside explicit loopback development and ignores forged proxy headers', async () => {
    vi.stubEnv('AIXAND_AUTH_DEV_HTTP', '0');
    await api()
      .post('/api/auth/setup')
      .set('Origin', fixtureOrigin)
      .set('X-Forwarded-Proto', 'https')
      .send(body())
      .expect(403);
    vi.stubEnv('AIXAND_AUTH_DEV_HTTP', '1');
    await api()
      .post('/api/auth/setup')
      .set('Host', '192.168.1.5:5186')
      .set('Origin', fixtureOrigin)
      .send(body())
      .expect(403);
  });
  it('issues a secure host cookie only through an explicitly trusted HTTPS proxy', async () => {
    await setup();
    vi.stubEnv('AIXAND_AUTH_DEV_HTTP', '0');
    vi.stubEnv('AIXAND_TRUST_PROXY', '127.0.0.1');
    const response = await api()
      .post('/api/auth/login')
      .set('Origin', fixtureOrigin)
      .set('X-Forwarded-Proto', 'https')
      .send({ password: fixturePassword })
      .expect(201);
    expect(response.headers['set-cookie'][0]).toMatch(
      /^__Host-aixand-session=/,
    );
    expect(response.headers['set-cookie'][0]).toContain('Secure');
  });
  it('persists onboarding only for authenticated, CSRF-protected requests and rejects stale saves', async () => {
    await setup();
    const cookie = await login();
    const session = await api().get('/api/auth/session').set('Cookie', cookie).expect(200);
    expect(session.body.onboardingPending).toBe(true);
    await api().get('/api/auth/onboarding').expect(401);
    const state = await api().get('/api/auth/onboarding').set('Cookie', cookie).expect(200);
    const { revision, ...progress } = state.body;
    const input = { expectedRevision: revision, progress: { ...progress, step: 'install', selected: ['codex'], selectionInitialized: true } };
    await api().post('/api/auth/onboarding').set('Origin', fixtureOrigin).set('Cookie', cookie).send(input).expect(403);
    const save = () => api().post('/api/auth/onboarding').set('Origin', fixtureOrigin).set('Cookie', cookie)
      .set('X-CSRF-Token', session.body.csrfToken).send(input);
    const saved = await save().expect(201);
    expect(saved.body).toMatchObject({ revision: revision + 1, step: 'install', selected: ['codex'] });
    await save().expect(409);
    const newCookie = await login();
    await api().get('/api/auth/onboarding').set('Cookie', newCookie).expect(200, saved.body);
  });
  it('rejects missing or untrusted mutation origins and CSRF on logout', async () => {
    await api().post('/api/auth/setup').send(body()).expect(403);
    await api()
      .post('/api/auth/setup')
      .set('Origin', 'https://untrusted.example')
      .send(body())
      .expect(403);
    await setup();
    const cookie = await login();
    await api()
      .post('/api/auth/logout')
      .set('Origin', fixtureOrigin)
      .set('Cookie', cookie)
      .send({})
      .expect(403);
    const session = await api()
      .get('/api/auth/session')
      .set('Cookie', cookie)
      .expect(200);
    await api()
      .post('/api/auth/logout')
      .set('Origin', fixtureOrigin)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', session.body.csrfToken)
      .send({})
      .expect(201);
    await api().get('/api/auth/session').set('Cookie', cookie).expect(401);
  });
  it('throttles repeated failures despite forged forwarding addresses', async () => {
    await setup();
    for (let index = 0; index < 5; index++)
      await api()
        .post('/api/auth/login')
        .set('Origin', fixtureOrigin)
        .set('X-Forwarded-For', `192.0.2.${index}`)
        .send({ password: 'incorrect' })
        .expect(401);
    await api()
      .post('/api/auth/login')
      .set('Origin', fixtureOrigin)
      .send({ password: fixturePassword })
      .expect(429);
  });
  const paths = [
    '/api/terminals/ws',
    '/api/agents/ws',
    '/api/workflows/ws',
    '/api/workflow-jobs/ws',
    '/api/carrier/ws',
  ];
  it.each(paths)(
    'denies unauthenticated and retired-key access to %s',
    async (path) => {
      await setup();
      expect(
        await closed(path, undefined, fixtureOrigin, {
          op: 'auth',
          token: 'obsolete-workspace-key-is-never-accepted',
        }),
      ).toEqual({ code: 1008, messages: [] });
    },
  );
  it.each(paths)(
    'rejects an untrusted origin even with a valid session at %s',
    async (path) => {
      await setup();
      const cookie = await login();
      expect(await closed(path, cookie, 'https://untrusted.example')).toEqual({
        code: 1008,
        messages: [],
      });
    },
  );
  it.each(['logout', 'idle', 'absolute', 'recovery'])(
    'revokes an open gateway connection on %s',
    async (kind) => {
      await setup();
      const cookie = await login();
      const socket = new WebSocket(
        url.replace('http:', 'ws:') + '/api/workflow-jobs/ws',
        { origin: fixtureOrigin, headers: { Cookie: cookie } },
      );
      await new Promise<void>((resolve, reject) => {
        socket.once('message', () => resolve());
        socket.once('error', reject);
      });
      const closedPromise = new Promise<number>((resolve) =>
        socket.once('close', resolve),
      );
      const store = app.get(AuthService).store;
      if (kind === 'logout') {
        const session = await api()
          .get('/api/auth/session')
          .set('Cookie', cookie);
        await api()
          .post('/api/auth/logout')
          .set('Origin', fixtureOrigin)
          .set('Cookie', cookie)
          .set('X-CSRF-Token', session.body.csrfToken)
          .send({})
          .expect(201);
      } else if (kind === 'recovery')
        store.replacePassword(
          await hashPassword('replacement Suite password 9341!'),
        );
      else if (kind === 'idle')
        store.db
          .prepare('UPDATE auth_sessions SET last_activity=?')
          .run(Date.now() - SESSION_IDLE - 1);
      else store.db.exec('UPDATE auth_sessions SET expires_at=1');
      expect(await closedPromise).toBe(1008);
      await api().get('/api/auth/session').set('Cookie', cookie).expect(401);
      if (kind === 'recovery') {
        await api()
          .post('/api/auth/login')
          .set('Origin', fixtureOrigin)
          .send({ password: fixturePassword })
          .expect(401);
        await login('replacement Suite password 9341!');
      }
    },
  );
  it('rejects commands immediately after credential revocation without contacting Runner', async () => {
    await setup();
    const cookie = await login();
    const socket = new WebSocket(
      url.replace('http:', 'ws:') + '/api/workflow-jobs/ws',
      { origin: fixtureOrigin, headers: { Cookie: cookie } },
    );
    const messages: unknown[] = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve) =>
      socket.once('message', () => resolve()),
    );
    const closedPromise = new Promise<number>((resolve) =>
      socket.once('close', resolve),
    );
    app.get(AuthService).store.db.exec('DELETE FROM auth_sessions');
    socket.send(JSON.stringify({ id: 'health', op: 'health', args: {} }));
    expect(await closedPromise).toBe(1008);
    expect(messages).toEqual([{ type: 'ready' }]);
  });
  it('never reopens setup after host recovery or invalid database changes', async () => {
    await setup();
    const store = app.get(AuthService).store;
    expect(() => initializeAuthDatabase(fixture.file)).toThrow(
      'already exists',
    );
    expect(() =>
      store.db.exec('UPDATE workspace_auth SET password_hash=NULL'),
    ).toThrow();
    store.db.exec('DELETE FROM workspace_auth');
    expect(() => store.credential()).toThrow('invalid');
  });
  it('fails closed when authentication data disappears and never recreates it', async () => {
    await setup();
    rmSync(fixture.file);
    expect(() => new AuthStore(fixture.file)).toThrow('missing');
    expect(() => new AuthStore(fixture.file, { initialize: true })).toThrow(
      'missing',
    );
    expect(() => app.get(AuthService).store.credential()).toThrow('missing');
    expect(existsSync(fixture.file)).toBe(false);
  });
  it('stores session tokens only as digests', async () => {
    await setup();
    const cookie = await login();
    const token = cookie.split('=')[1];
    const row = app
      .get(AuthService)
      .store.db.prepare(
        'SELECT token_hash FROM auth_sessions WHERE token_hash=?',
      )
      .get(tokenHash(token))!;
    expect(row.token_hash).toBe(tokenHash(token));
    expect(row.token_hash).not.toBe(token);
  });
  it('rejects malformed password hashes and detects an atomic database replacement', async () => {
    await setup();
    const store = app.get(AuthService).store;
    expect(() => store.replacePassword('$argon2id$invalid')).toThrow(
      'supported',
    );
    renameSync(fixture.file, fixture.file + '.previous');
    copyFileSync(fixture.file + '.previous', fixture.file);
    expect(() => store.credential()).toThrow('replaced');
  });
  it('refuses a shared parent directory without changing its permissions or creating a database', () => {
    chmodSync(fixture.directory, 0o755);
    const file = fixture.file + '.new';
    expect(() => initializeAuthDatabase(file)).toThrow(
      'private authentication directory',
    );
    expect(statSync(fixture.directory).mode & 0o777).toBe(0o755);
    expect(existsSync(file)).toBe(false);
    chmodSync(fixture.directory, 0o700);
  });
  it('cannot create a session from a password verification that raced with host recovery', async () => {
    await setup();
    let release!: (value: boolean) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(passwords, 'verifyPassword').mockImplementation(() => {
      started();
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    });
    const pending = api()
      .post('/api/auth/login')
      .set('Origin', fixtureOrigin)
      .send({ password: fixturePassword })
      .then((response) => response);
    await waiting;
    app
      .get(AuthService)
      .store.replacePassword(
        await hashPassword('race replacement passphrase 712!'),
      );
    release(true);
    expect((await pending).status).toBe(401);
    expect(
      app
        .get(AuthService)
        .store.db.prepare('SELECT count(*) AS count FROM auth_sessions')
        .get()?.count,
    ).toBe(0);
  });
});
