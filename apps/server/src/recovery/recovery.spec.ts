import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuthModule } from '../auth/auth.module.js';
import { RecoveryModule } from './recovery.module.js';
import { configureApp } from '../configure-app.js';
import { authFixture, fixtureCookie, fixtureOrigin } from '../../test/auth-fixture.js';

describe('Recovery without the agent bridge or SDK', () => {
  let app: INestApplication;
  let root: string;
  let auth: Awaited<ReturnType<typeof authFixture>>;
  let cookie: string;
  const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  beforeAll(async () => {
    auth = await authFixture();
    root = mkdtempSync(join(tmpdir(), 'suite-recovery-api-'));
    const broken = join(root, 'no-sdk');
    mkdirSync(broken);
    writeFileSync(join(broken, 'agent_manager.py'), 'raise RuntimeError("SDK fixture is deliberately unavailable")\n');
    for (const [key, value] of Object.entries({
      AGENT_MANAGER_HOME: join(root, 'manager'), AGENT_MANAGER_CONFIG: join(root, 'absent.toml'),
      AGENTS_STATE_DIR: join(root, 'state'), UNDERCURRENT_HOME: join(root, 'runtime'),
      AGENTS_PYTHON: 'python3', AGENTS_MANAGER_SOURCE: broken, AGENTS_BRIDGE_PATH: join(root, 'missing-bridge.py'),
      RECOVERY_WORKER_PATH: resolve('recovery-worker/main.py'),
    })) vi.stubEnv(key, value);
    execFileSync('python3', ['-c', [
      `import sys,json; sys.path.insert(0,${JSON.stringify(resolve('shared'))})`,
      'from chat_state import ChatState',
      `s=ChatState(); d=s.connect(True); d.execute('INSERT INTO chats VALUES (?,?)', (${JSON.stringify(chatId)},json.dumps({'id':${JSON.stringify(chatId)},'title':'Checkout recovery','provider':'codex','profile':'work','project':'Shop','cwd':'/workspace','updatedAt':42,'revision':1,'threadId':'native-thread','runId':'original-process'}))); d.commit(); d.close()`,
    ].join('\n')]);
    const module = await Test.createTestingModule({ imports: [AuthModule, RecoveryModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    cookie = fixtureCookie(app);
  }, 20_000);

  afterAll(async () => {
    await app?.close();
    if (root) rmSync(root, { recursive: true, force: true });
    auth?.cleanup();
    vi.unstubAllEnvs();
  });

  it('requires the existing authenticated session', async () => {
    await request(app.getHttpServer()).get('/api/recovery/sessions').expect(401);
  });

  it('lists and searches persisted titles even when SDK import and the bridge are broken', async () => {
    const response = await request(app.getHttpServer()).get('/api/recovery/sessions?q=Checkout').set('Cookie', cookie).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.sessions).toEqual([expect.objectContaining({ id: chatId, title: 'Checkout recovery' })]);
    expect(JSON.stringify(response.body)).not.toContain('original-process');
    expect((await request(app.getHttpServer()).get('/api/recovery/sessions?q=absent').set('Cookie', cookie).expect(200)).body.sessions).toEqual([]);
  });

  it('reports availability failure without discarding the independent catalog', async () => {
    const response = await request(app.getHttpServer()).get(`/api/chats/${chatId}/terminal`).set('Cookie', cookie).expect(200);
    expect(response.body.availability).toBe('unknown');
    expect(response.body.conversation.title).toBe('Checkout recovery');
  });

  it('protects mutations with CSRF and rejects browser-selected launch identities', async () => {
    await request(app.getHttpServer()).post(`/api/chats/${chatId}/terminal`).set('Cookie', cookie).set('Origin', fixtureOrigin)
      .send({ key: crypto.randomUUID() }).expect(403);
    const session = await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie).expect(200);
    await request(app.getHttpServer()).post(`/api/chats/${chatId}/terminal`).set('Cookie', cookie).set('Origin', fixtureOrigin)
      .set('X-CSRF-Token', session.body.csrfToken).send({ key: crypto.randomUUID(), threadId: 'browser-chosen' }).expect(400);
  });
});
