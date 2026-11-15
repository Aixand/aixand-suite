import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module.js';
import { VoxService, type VoxMessage } from '../src/vox/vox.service.js';
import { configureApp } from '../src/configure-app.js';
import { authFixture, fixtureCookie, fixtureOrigin } from './auth-fixture.js';

describe('Vox gateway', () => {
  let app: INestApplication, url: string, cookie: string;
  let fixture: Awaited<ReturnType<typeof authFixture>>;
  const sockets: WebSocket[] = [];
  const listeners = new Set<(message: VoxMessage) => void>();
  const service = {
    ready: vi.fn(async () => {}), request: vi.fn(async (_owner: string, command: { id: string }) => ({ type: 'result', id: command.id, result: {} })), release: vi.fn(),
    subscribe: (listener: (message: VoxMessage) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  beforeEach(async () => {
    fixture = await authFixture(); service.request.mockClear(); service.release.mockClear(); listeners.clear();
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(VoxService).useValue(service).compile();
    app = module.createNestApplication(); configureApp(app); await app.listen(0, '127.0.0.1');
    cookie = fixtureCookie(app);
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/vox/ws`;
  });
  afterEach(async () => {
    sockets.forEach((socket) => socket.terminate()); sockets.length = 0;
    await app.close(); fixture.cleanup(); vi.unstubAllEnvs();
  });
  async function connect(authenticated = true) {
    const socket = new WebSocket(url, { origin: fixtureOrigin, headers: authenticated ? { Cookie: cookie } : {} });
    sockets.push(socket);
    const messages: VoxMessage[] = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return { socket, messages };
  }
  async function ready() {
    const result = await connect(); await vi.waitFor(() => expect(result.messages.some((message) => message.type === 'ready')).toBe(true)); return result;
  }
  it('authenticates sessions and rejects forged ownership and arbitrary tool operations', async () => {
    const unauthenticated = await connect(false);
    expect(await new Promise<number>((done) => unauthenticated.socket.once('close', done))).toBe(1008);
    for (const command of [
      { op: 'start', args: { key: crypto.randomUUID(), profile: null, owner: 'forged' } },
      { op: 'vox-tool', args: { tool: 'start_investigation' } },
      { op: 'offer', args: { sessionId: crypto.randomUUID(), type: 'offer', sdp: 'invalid' } },
      { op: 'wake-offer', args: { key: crypto.randomUUID(), type: 'offer', sdp: 'v=0', owner: 'forged' } },
      { op: 'wake-debug', args: { key: crypto.randomUUID(), enabled: 'true' } },
      { op: 'wake-offer', args: { key: crypto.randomUUID(), type: 'offer', sdp: 'v=0', debug: 'true' } },
    ]) {
      const { socket } = await ready();
      const closed = new Promise<number>((done) => socket.once('close', done));
      socket.send(JSON.stringify({ id: crypto.randomUUID(), ...command }));
      expect(await closed).toBe(1008);
    }
    expect(service.request).not.toHaveBeenCalled();
  });
  it('keeps events with their browser owner and releases only that owner on disconnect', async () => {
    const first = await ready(), second = await ready();
    first.socket.send(JSON.stringify({ id: crypto.randomUUID(), op: 'start', args: { key: crypto.randomUUID(), profile: 'work' } }));
    await vi.waitFor(() => expect(service.request).toHaveBeenCalledTimes(1));
    const owner = service.request.mock.calls[0][0];
    for (const listener of listeners) listener({ type: 'event', owner, sessionId: crypto.randomUUID(), event: { kind: 'message', text: 'Private reply' } });
    await vi.waitFor(() => expect(first.messages.some((message) => message.type === 'event')).toBe(true));
    expect(second.messages.some((message) => message.type === 'event')).toBe(false);
    expect(JSON.stringify(first.messages)).not.toContain('"owner"');
    first.socket.close(); await vi.waitFor(() => expect(service.release).toHaveBeenCalledWith(owner));
  });
  it('deduplicates repeated conversation-start requests', async () => {
    const { socket, messages } = await ready();
    const command = { id: crypto.randomUUID(), op: 'start', args: { key: crypto.randomUUID(), profile: null } };
    socket.send(JSON.stringify(command));
    await vi.waitFor(() => expect(messages.some((message) => message.id === command.id)).toBe(true));
    socket.send(JSON.stringify(command));
    await vi.waitFor(() => expect(messages.filter((message) => message.id === command.id)).toHaveLength(2));
    expect(service.request).toHaveBeenCalledTimes(1);
  });
  it('authenticates wake signaling and filters wake events by owner', async () => {
    const first = await ready(), second = await ready();
    const key = crypto.randomUUID();
    first.socket.send(JSON.stringify({ id: crypto.randomUUID(), op: 'wake-offer', args: { key, type: 'offer', sdp: 'v=0\r\n' } }));
    await vi.waitFor(() => expect(service.request).toHaveBeenCalledTimes(1));
    const owner = service.request.mock.calls[0][0];
    for (const listener of listeners) listener({ type: 'wake-event', owner, event: { kind: 'keyword', action: 'wake' } });
    await vi.waitFor(() => expect(first.messages.some((message) => message.type === 'wake-event')).toBe(true));
    expect(second.messages.some((message) => message.type === 'wake-event')).toBe(false);
  });
  it('passes debug changes with the authenticated browser owner', async () => {
    const { socket, messages } = await ready();
    const key = crypto.randomUUID(), id = crypto.randomUUID();
    socket.send(JSON.stringify({ id, op: 'wake-debug', args: { key, enabled: false } }));
    await vi.waitFor(() => expect(messages.some((message) => message.id === id)).toBe(true));
    expect(service.request.mock.calls[0][0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(service.request.mock.calls[0][1]).toEqual({ id, op: 'wake-debug', args: { key, enabled: false } });
  });
});
