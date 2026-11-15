import { AuthModule } from '../src/auth/auth.module.js';
import { authFixture, fixtureCookie } from './auth-fixture.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { WorkflowsModule } from '../src/workflows/workflows.module.js';
import { configureApp } from '../src/configure-app.js';

describe('Durable workflow job gateway', () => {
  let app: INestApplication;
  let runner: Server;
  let home: string;
  let url: string, cookie: string;
  let fixtureAuth: Awaited<ReturnType<typeof authFixture>>;
  const requests: Record<string, unknown>[] = [];
  const clients = new Set<WebSocket>();
  beforeEach(async () => {
    fixtureAuth = await authFixture();
    requests.length = 0;
    home = await mkdtemp(join(tmpdir(), 'workflow-jobs-test-'));
    vi.stubEnv('WORKFLOW_RUNNER_HOME', home);
    vi.stubEnv('CORS_ORIGINS', 'http://localhost:5186');
    runner = createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer) as Record<string, unknown>;
        requests.push(request);
        socket.end(
          JSON.stringify({
            ok: true,
            data:
              request.op === 'submit'
                ? { job: { id: 'retained-job', state: 'queued' } }
                : { state: 'running' },
          }) + '\n',
        );
      });
    });
    await new Promise<void>((resolve) =>
      runner.listen(join(home, 'runner.sock'), resolve),
    );
    const module = await Test.createTestingModule({
      imports: [AuthModule, WorkflowsModule],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    cookie = fixtureCookie(app);
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/workflow-jobs/ws`;
  });
  afterEach(async () => {
    for (const socket of clients) socket.terminate();
    clients.clear();
    await app.close();
    await new Promise<void>((resolve) => runner.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    fixtureAuth.cleanup();
    vi.unstubAllEnvs();
  });
  function open(origin = 'http://localhost:5186', authenticated = false) {
    const socket = new WebSocket(url, { origin, headers: authenticated ? { Cookie: cookie } : {} });
    clients.add(socket);
    return socket;
  }
  function message(socket: WebSocket): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
      socket.once('error', reject);
    });
  }
  async function authenticated() {
    const socket = open(undefined, true);
    const ready = message(socket);
    expect(await ready).toEqual({ type: 'ready' });
    return socket;
  }
  it('rejects untrusted origins and unauthenticated submissions without contacting Runner', async () => {
    for (const origin of [
      'https://untrusted.example',
      'http://localhost:5186',
    ]) {
      const socket = open(origin);
      const closed = new Promise<number>((resolve) =>
        socket.once('close', resolve),
      );
      socket.on('open', () =>
        socket.send(JSON.stringify({ id: 'submit', op: 'submit', args: {} })),
      );
      expect(await closed).toBe(1008);
    }
    expect(requests).toEqual([]);
  });
  it('submits the supplied IR with Suite context and leaves the durable job running after disconnect', async () => {
    const socket = await authenticated();
    const submission = {
      key: 'stable-key',
      workflow: { ir_version: '0.1' },
      inputs: {},
      metadata: {},
    };
    const reply = message(socket);
    socket.send(
      JSON.stringify({ id: 'submit', op: 'submit', args: { submission } }),
    );
    expect(await reply).toEqual({
      type: 'result',
      id: 'submit',
      result: { job: { id: 'retained-job', state: 'queued' } },
    });
    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => resolve()),
    );
    socket.close();
    await closed;
    expect(requests).toEqual([{ op: 'submit', submission: { ...submission, metadata: {
      agent_context: { labels: { app: 'aixand-suite', feature: 'workflow' }, metadata: { 'suite.submission_key': 'stable-key' } },
    } } }]);
    const recovered = await authenticated();
    const events = message(recovered);
    recovered.send(
      JSON.stringify({
        id: 'events',
        op: 'events',
        args: { id: 'retained-job', after: 10, limit: 100 },
      }),
    );
    expect((await events).type).toBe('result');
    expect(requests.at(-1)).toEqual({
      op: 'events',
      id: 'retained-job',
      after: 10,
      limit: 100,
    });
  });
  it('reconciles the retained job identity without submitting a new workflow', async () => {
    const socket = await authenticated();
    const reply = message(socket);
    socket.send(JSON.stringify({ id: 'reconcile', op: 'resume', args: { id: 'retained-job' } }));
    expect(await reply).toEqual({ type: 'result', id: 'reconcile', result: { state: 'running' } });
    expect(requests).toEqual([{ op: 'resume', id: 'retained-job' }]);
  });
  it('forwards revisions, holds, adoption and continuation controls through the authenticated transport', async () => {
    const socket = await authenticated();
    const commands = [
      { op: 'plan', args: { id: 'retained-job' } },
      { op: 'hold', args: { id: 'retained-job' } },
      { op: 'release', args: { id: 'retained-job' } },
      { op: 'amend', args: { id: 'retained-job', key: 'edit-1', expected_revision: 3,
        workflow: { format: 'aixand.workflow-graph', version: 2 }, authoring: { name: 'Revised' } } },
      { op: 'enable_edits', args: { id: 'retained-job', key: 'enable-1', groups: { node: ['old_step'] }, identities: { stable: 'old_step' } } },
      { op: 'continuations', args: { id: 'retained-job' } },
      { op: 'cancel_continuation', args: { id: 'follow-up' } },
    ];
    for (const [index, command] of commands.entries()) {
      const reply = message(socket);
      socket.send(JSON.stringify({ id: `control-${index}`, ...command }));
      expect((await reply).type).toBe('result');
      expect(requests.at(-1)).toEqual({ op: command.op, ...command.args });
    }
  });
  it('retains full continuation inputs and their result mapping while attributing the child to Suite', async () => {
    const socket = await authenticated();
    const target = { key: 'child-key', workflow: { format: 'aixand.workflow-graph', version: 2 },
      inputs: { options: { include: ['architecture', 'security'] } }, metadata: {} };
    const reply = message(socket);
    socket.send(JSON.stringify({ id: 'follow-up', op: 'continue', args: {
      id: 'retained-job', key: 'next-1', target, input_map: { previous_result: '/result' },
    } }));
    expect((await reply).type).toBe('result');
    expect(requests).toEqual([{ op: 'continue', id: 'retained-job', key: 'next-1',
      input_map: { previous_result: '/result' }, target: { ...target, metadata: {
        agent_context: { labels: { app: 'aixand-suite', feature: 'workflow' }, metadata: { 'suite.submission_key': 'child-key' } },
      } } }]);
  });
  it('rejects browser-selected socket paths and unsupported operations', async () => {
    for (const command of [
      { id: 'health', op: 'health', args: { home: '/tmp/other' } },
      { id: 'exec', op: 'exec', args: {} },
      { id: 'bad-revision', op: 'amend', args: { id: 'retained-job', key: 'change', expected_revision: 0, workflow: {} } },
      { id: 'bad-mapping', op: 'continue', args: { id: 'retained-job', key: 'next', target: { key: 'child', workflow: {} }, input_map: { previous_result: 42 } } },
    ]) {
      const socket = await authenticated();
      const closed = new Promise<number>((resolve) =>
        socket.once('close', resolve),
      );
      socket.send(JSON.stringify(command));
      expect(await closed).toBe(1008);
    }
    expect(requests).toEqual([]);
  });
});
