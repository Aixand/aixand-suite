import { AuthModule } from '../src/auth/auth.module.js';
import { authFixture, fixtureCookie } from './auth-fixture.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { CarrierModule } from '../src/carrier/carrier.module.js';
import { configureApp } from '../src/configure-app.js';

const workspaceKey = 'carrier-test-workspace-key-32-characters';
const origin = 'http://localhost:5186';
let workspaceCookie = '';
let fixtureAuth: Awaited<ReturnType<typeof authFixture>>;
const python = process.env.AIXAND_TEST_CARRIER_PYTHON ?? resolve(process.platform === 'win32'
  ? '../../sdks/python/.venv/Scripts/python.exe' : '../../sdks/python/.venv/bin/python');
async function port() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const value = (server.address() as AddressInfo).port;
  await new Promise<void>((done) => server.close(() => done()));
  return value;
}
async function until<T>(
  work: () => Promise<T>,
  check: (value: T) => boolean,
  timeout = 10000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await work();
    if (check(value)) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('Timed out waiting for Carrier state');
}
type Message = {
  type: string;
  id?: string;
  result?: unknown;
  message?: string;
  code?: string;
};
class Client {
  socket: WebSocket;
  events: Message[] = [];
  pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  ready: Promise<void>;
  constructor(url: string) {
    this.socket = new WebSocket(url, { origin, headers: { Cookie: workspaceCookie } });
    this.ready = new Promise((done, fail) => {
      this.socket.on('error', fail);
      this.socket.on('message', (raw) => {
        const value = JSON.parse(raw.toString()) as Message;
        this.events.push(value);
        if (value.type === 'ready') done();
        const item = value.id ? this.pending.get(value.id) : undefined;
        if (item) {
          this.pending.delete(value.id!);
          if (value.type === 'error') item.reject(new Error(value.message));
          else item.resolve(value.result);
        }
      });
    });
  }
  async request(op: string, args = {}): Promise<any> {
    await this.ready;
    const id = randomUUID();
    return new Promise((resolveResult, reject) => {
      this.pending.set(id, { resolve: resolveResult, reject });
      this.socket.send(JSON.stringify({ id, op, args }));
    });
  }
  close() {
    this.socket.close();
  }
}

describe('Carrier real local service and shared adapter', () => {
  let root: string, upstream: string, url: string;
  let process: ChildProcess;
  let app: INestApplication;
  let peerToken: string;
  let first: Client, second: Client;
  async function boot() {
    const module = await Test.createTestingModule({
      imports: [AuthModule, CarrierModule],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    workspaceCookie = fixtureCookie(app);
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/carrier/ws`;
  }
  beforeAll(async () => {
    fixtureAuth = await authFixture();
    root = mkdtempSync(join(tmpdir(), 'aixand-carrier-e2e-'));
    const upstreamPort = await port();
    upstream = `http://127.0.0.1:${upstreamPort}`;
    for (const address of ['suite/local/user', 'peer'])
      execFileSync(
        python,
        [
          '-m',
          'carrier.cli',
          'session',
          address,
          '--db',
          join(root, 'carrier.db'),
          '--credentials',
          join(root, address === 'peer' ? 'peer.json' : 'user.json'),
        ],
        { stdio: 'ignore' },
      );
    peerToken = JSON.parse(readFileSync(join(root, 'peer.json'), 'utf8')).token;
    process = spawn(
      python,
      [
        '-m',
        'carrier.cli',
        'serve',
        '--db',
        join(root, 'carrier.db'),
        '--port',
        String(upstreamPort),
      ],
      { stdio: 'ignore' },
    );
    await until(async () => {
      try {
        return (await fetch(upstream + '/health')).ok;
      } catch {
        return false;
      }
    }, Boolean);
    for (const [key, value] of Object.entries({
      CORS_ORIGINS: origin,
      CARRIER_PYTHON: python,
      CARRIER_URL: upstream,
      CARRIER_DATABASE: join(root, 'carrier.db'),
      CARRIER_STATE_DIR: join(root, 'state'),
      CARRIER_USER_CREDENTIALS: join(root, 'user.json'),
      CARRIER_AUTO_PROVISION: '0',
      CARRIER_POLL_INTERVAL: '0.1',
      CARRIER_AGENT_CONFIG: '',
    }))
      vi.stubEnv(key, value);
    await boot();
    first = new Client(url);
    second = new Client(url);
    await Promise.all([first.ready, second.ready]);
    await until(
      () => first.request('status'),
      (value) => value.connected,
    );
  }, 30000);
  afterAll(async () => {
    first?.close();
    second?.close();
    if (app) await app.close();
    if (process && process.exitCode === null) {
      const ended = new Promise<void>((done) =>
        process.once('exit', () => done()),
      );
      process.kill();
      await ended;
    }
    if (root) rmSync(root, { recursive: true, force: true });
    fixtureAuth?.cleanup();
    vi.unstubAllEnvs();
  });
  async function peer(path: string, body?: object) {
    return (
      await fetch(upstream + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${peerToken}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      })
    ).json();
  }

  it('requires origin and workspace authentication', async () => {
    for (const [testOrigin, token] of [
      ['https://untrusted.example', workspaceKey],
      [origin, 'wrong'],
    ]) {
      const value = await new Promise<number>((done) => {
        const socket = new WebSocket(url, { origin: testOrigin });
        socket.on('open', () =>
          socket.send(JSON.stringify({ op: 'auth', token })),
        );
        socket.on('close', done);
      });
      expect(value).toBe(1008);
    }
  });
  it('shares preferences across tabs, preserves them on restart and retains acknowledged history', async () => {
    const incoming = await peer('/send', {
      to: 'suite/local/user',
      content: 'Live navigation review',
      message_id: 'live-review',
    });
    await until(
      () => first.request('snapshot'),
      (value) => value.total === 1,
    );
    await first.request('set_message_state', {
      id: incoming.id,
      read: true,
      archived: true,
    });
    expect(
      (await second.request('snapshot', { view: 'Archived' })).messages[0].read,
    ).toBe(true);
    expect((await peer('/delivery_status?message_id=live-review')).status).toBe(
      'stored',
    );
    first.close();
    second.close();
    await app.close();
    await boot();
    first = new Client(url);
    second = new Client(url);
    await Promise.all([first.ready, second.ready]);
    expect(
      (await first.request('snapshot', { view: 'Archived' })).messages[0].read,
    ).toBe(true);
    await first.request('acknowledge', { id: incoming.id });
    await first.request('set_message_state', {
      id: incoming.id,
      read: false,
      archived: false,
    });
    expect((await second.request('snapshot', { view: 'Unread' })).total).toBe(
      1,
    );
    expect((await second.request('snapshot', { view: 'Pending' })).total).toBe(
      0,
    );
    expect((await peer('/delivery_status?message_id=live-review')).status).toBe(
      'acknowledged',
    );
  });
  it('sends retry-safe replies and assembles real conversations', async () => {
    const incoming = (await first.request('messages')).messages[0];
    const args = {
      key: 'reply-operation',
      to: 'peer',
      content: 'I will review it',
      reply_to: Number(incoming.id),
    };
    const answer = await first.request('send', args);
    expect((await second.request('send', args)).id).toBe(answer.id);
    expect(
      (await peer('/receive')).messages.filter(
        (item: any) => item.content === args.content,
      ),
    ).toHaveLength(1);
    expect(
      (await first.request('conversation', { id: Number(incoming.id) })).total,
    ).toBe(2);
    expect((await first.request('messages', { view: 'Sent' })).total).toBe(1);
    await expect(
      first.request('send', { ...args, content: 'changed' }),
    ).rejects.toThrow(/Retry key/);
    expect(first.events.some((event) => event.type === 'changed')).toBe(true);
  });
  it('rejects paths and credential overrides at the browser boundary', async () => {
    await expect(
      first.request('send', {
        key: 'x',
        to: 'peer',
        content: 'x',
        credentials: '/tmp/other',
      }),
    ).rejects.toThrow('Invalid Carrier request');
  });
  it('searches and resolves exact incoming references without changing delivery or preferences', async () => {
    const sent = await peer('/send', { to: 'suite/local/user', content: JSON.stringify({
      schema: 'aixand.carrier', version: 1, kind: 'agent.update', title: 'Reference / review', body: 'Full message body\nSecond line',
    }), message_id: 'inbox-reference' });
    const search = await until(() => first.request('message_search', { search: 'Reference / review' }), (value) => value.total === 1);
    expect(search.messages[0]).toMatchObject({ id: String(sent.id), title: 'Reference / review', preview: 'Full message body\nSecond line' });
    expect(search.messages[0]).not.toHaveProperty('content');
    expect((await first.request('message_search', { search: 'reference-review' })).messages[0].id).toBe(String(sent.id));
    expect((await first.request('message_search', { search: `reference-review~${sent.id}` })).messages[0].id).toBe(String(sent.id));
    const args = { id: sent.id, instance: search.instance };
    const message = await first.request('message_get', args);
    expect(message).toMatchObject({ body: 'Full message body\nSecond line', read: false, archived: false, acknowledged_at: null });
    await first.request('set_message_state', { id: sent.id, archived: true });
    expect((await first.request('message_search', { search: 'Reference / review' })).total).toBe(1);
    expect((await first.request('message_get', args)).archived).toBe(true);
    expect((await peer('/delivery_status?message_id=inbox-reference')).status).toBe('stored');
    await expect(first.request('message_get', { ...args, instance: 'different-dataset' })).rejects.toThrow('Select this message again');
    await expect(first.request('message_get', { ...args, mailbox: 'unknown' })).rejects.toThrow('Mailbox');
    await expect(first.request('message_get', { ...args, id: Number.MAX_SAFE_INTEGER })).rejects.toThrow('no longer');
    const outgoing = (await first.request('messages', { view: 'Sent' })).messages[0];
    await expect(first.request('message_get', { ...args, id: Number(outgoing.id) })).rejects.toThrow('no longer');
  });
});
