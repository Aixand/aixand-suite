import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { authFixture, fixtureCookie, fixtureOrigin } from './auth-fixture.js';

describe('Workflow WebSocket boundary', () => {
  let app: INestApplication;
  let url: string, cookie: string;
  let fixture: Awaited<ReturnType<typeof authFixture>>;
  beforeEach(async () => {
    fixture = await authFixture();
    vi.stubEnv('WORKFLOW_BRIDGE_PATH', '/nonexistent/aixand-test-bridge');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/workflows/ws`;
    cookie = fixtureCookie(app);
  });
  afterEach(async () => {
    await app.close();
    fixture.cleanup();
    vi.unstubAllEnvs();
  });
  function connect(origin: string, authenticated = false, message?: unknown) {
    return new Promise<{ code: number; reason: string; messages: unknown[] }>(
      (resolve, reject) => {
        const socket = new WebSocket(url, {
          origin,
          headers: authenticated ? { Cookie: cookie } : {},
        });
        const messages: unknown[] = [];
        socket.on('open', () => {
          if (message) socket.send(JSON.stringify(message));
        });
        socket.on('message', (raw) =>
          messages.push(JSON.parse(raw.toString())),
        );
        socket.on('error', reject);
        socket.on('close', (code, reason) =>
          resolve({ code, reason: reason.toString(), messages }),
        );
      },
    );
  }
  it('rejects an untrusted origin before launching a bridge', async () => {
    const result = await connect('https://untrusted.example', true);
    expect(result.code).toBe(1008);
    expect(result.reason).toContain('Origin');
    expect(result.messages).toEqual([]);
  });
  it('never accepts the retired workspace key without a session', async () => {
    const result = await connect(fixtureOrigin, false, {
      op: 'auth',
      token: 'retired-key-with-at-least-32-characters',
    });
    expect(result.code).toBe(1008);
    expect(result.reason).toContain('Sign in');
    expect(result.messages).toEqual([]);
  });
  it('rejects commands without a session', async () => {
    const result = await connect(fixtureOrigin, false, {
      op: 'run',
      id: crypto.randomUUID(),
      args: {},
    });
    expect(result.code).toBe(1008);
    expect(result.messages).toEqual([]);
  });
  it('reports a missing bridge after successful session authentication', async () => {
    const result = await connect(fixtureOrigin, true);
    expect(result.code).toBe(1011);
    expect(result.messages).toContainEqual({
      type: 'fatal',
      message:
        'Workflow bridge could not start. Build it with npm run workflow:build in aixand-server.',
    });
  });
});
