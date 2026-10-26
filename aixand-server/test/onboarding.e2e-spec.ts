import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { OnboardingModule } from '../src/onboarding/onboarding.module.js';
import { AgentsService } from '../src/agents/agents.service.js';
import { configureApp } from '../src/configure-app.js';
import { authFixture, fixtureCookie, fixtureOrigin } from './auth-fixture.js';

describe('authenticated onboarding and host browsing', () => {
  let app: INestApplication, fixture: Awaited<ReturnType<typeof authFixture>>;
  let cookie: string, csrf: string;
  const manager = vi.fn(async ({ op }: { op: string }) => ({ type: 'result', result: op === 'providers'
    ? { schema: 'agent-manager/provider-catalog-1', configured: false, inventoryComplete: true, providers: [] }
    : op === 'agent-operations' ? { operations: [] } : [] }));
  beforeEach(async () => {
    fixture = await authFixture();
    vi.stubEnv('AGENTS_CWD', fixture.directory);
    manager.mockClear();
    const module = await Test.createTestingModule({ imports: [AuthModule, OnboardingModule] })
      .overrideProvider(AgentsService).useValue({ request: manager }).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
    cookie = fixtureCookie(app);
    csrf = (await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie)).body.csrfToken;
  });
  afterEach(async () => { await app.close(); fixture.cleanup(); vi.unstubAllEnvs(); });
  const api = () => request(app.getHttpServer());
  const post = (path: string) => api().post('/api/' + path).set('Cookie', cookie).set('Origin', fixtureOrigin).set('X-CSRF-Token', csrf);

  it('requires a session before inspecting host directories or Manager inventory', async () => {
    for (const path of ['filesystem/locations', 'filesystem/directories?path=/', 'auth/onboarding/status'])
      await api().get('/api/' + path).expect(401);
    expect(manager).not.toHaveBeenCalled();
    mkdirSync(join(fixture.directory, 'project'));
    writeFileSync(join(fixture.directory, 'private.txt'), 'file contents must not be returned');
    const response = await api().get('/api/filesystem/directories').query({ path: fixture.directory }).set('Cookie', cookie).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.entries).toEqual([{ name: 'project', path: join(fixture.directory, 'project') }]);
  });

  it('protects start and completion with CSRF and origin checks', async () => {
    for (const [path, body] of [['start', { manual: true }], ['complete', { expectedRevision: 1, skipProjects: true }], ['reconcile', { expectedRevision: 1 }]] as const) {
      await api().post('/api/auth/onboarding/' + path).set('Origin', fixtureOrigin).send(body).expect(401);
      await api().post('/api/auth/onboarding/' + path).set('Cookie', cookie).set('Origin', fixtureOrigin).send(body).expect(403);
      await api().post('/api/auth/onboarding/' + path).set('Cookie', cookie).set('Origin', 'https://other.example').set('X-CSRF-Token', csrf).send(body).expect(403);
    }
    expect(manager).not.toHaveBeenCalled();
  });

  it('starts an empty workspace once and rejects a client-authored completion flag', async () => {
    const first = await post('auth/onboarding/start').send({}).expect(201);
    const second = await post('auth/onboarding/start').send({}).expect(201);
    expect(second.body.revision).toBe(first.body.revision);
    const { revision, ...progress } = first.body;
    const draft = { auth: '', loginName: 'personal', profileName: 'work', operationId: null, nativeProfile: null, done: true, deferred: false };
    await post('auth/onboarding').send({ expectedRevision: revision, progress: { ...progress, status: 'complete', step: 'done', selected: ['example'], drafts: { example: draft } } }).expect(403);
    await post('auth/onboarding/complete').send({ expectedRevision: revision, skipProjects: true }).expect(400);
    expect((await api().get('/api/auth/onboarding').set('Cookie', cookie)).body.status).toBe('pending');
  });
});
