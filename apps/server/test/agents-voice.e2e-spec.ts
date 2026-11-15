import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module.js';
import { AgentsService, type BridgeMessage } from '../src/agents/agents.service.js';
import { configureApp } from '../src/configure-app.js';
import { authFixture, fixtureCookie, fixtureOrigin } from './auth-fixture.js';

describe('Browser voice ownership', () => {
  let app: INestApplication;
  let fixture: Awaited<ReturnType<typeof authFixture>>;
  let cookie: string;
  let url: string;
  const sockets: WebSocket[] = [];
  const listeners = new Set<(message: BridgeMessage) => void>();
  const service = {
    ready: vi.fn(async () => {}),
    request: vi.fn(async (command: { id: string }, _owner?: string): Promise<BridgeMessage> => ({ type: 'result', id: command.id, result: {} })),
    releaseVoice: vi.fn(),
    subscribe: (listener: (message: BridgeMessage) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  beforeEach(async () => {
    fixture = await authFixture();
    service.request.mockClear(); service.releaseVoice.mockClear(); listeners.clear();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AgentsService).useValue(service).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    cookie = fixtureCookie(app);
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/agents/ws`;
  });
  afterEach(async () => {
    sockets.forEach((socket) => socket.terminate()); sockets.length = 0;
    await app.close(); fixture.cleanup(); vi.unstubAllEnvs();
  });
  async function connect() {
    const socket = new WebSocket(url, { origin: fixtureOrigin, headers: { Cookie: cookie } });
    sockets.push(socket);
    const messages: BridgeMessage[] = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await vi.waitFor(() => expect(messages.some((message) => message.type === 'ready')).toBe(true));
    return { socket, messages };
  }
  it('routes SDP and transcripts only to the owner and releases its lease on disconnect', async () => {
    const first = await connect(), second = await connect();
    const id = crypto.randomUUID(), key = crypto.randomUUID(), chatId = crypto.randomUUID();
    first.socket.send(JSON.stringify({ id, op: 'chat-voice-start', args: { key, chatId, sdp: 'v=0\r\n' } }));
    await vi.waitFor(() => expect(service.request).toHaveBeenCalledTimes(1));
    const owner = service.request.mock.calls[0][1]!;
    expect(owner).toMatch(/^[a-f0-9-]{36}$/);
    for (const listener of listeners) listener({ type: 'chat-voice-event', voiceOwner: owner, key, chatId, event: { kind: 'sdp', sdp: 'private-answer' } });
    await vi.waitFor(() => expect(first.messages.some((message) => message.type === 'chat-voice-event')).toBe(true));
    expect(second.messages.some((message) => message.type === 'chat-voice-event')).toBe(false);
    expect(JSON.stringify(first.messages)).not.toContain('voiceOwner');
    first.socket.close();
    await vi.waitFor(() => expect(service.releaseVoice).toHaveBeenCalledWith(owner));
  });
  it('rejects browser-supplied ownership and arbitrary native voice arguments', async () => {
    for (const extra of [{ _voiceOwner: crypto.randomUUID() }, { threadId: 'other-thread' }, { model: 'override' }]) {
      const { socket } = await connect();
      const closed = new Promise<number>((resolve) => socket.once('close', resolve));
      socket.send(JSON.stringify({ id: crypto.randomUUID(), op: 'chat-voice-start',
        args: { key: crypto.randomUUID(), chatId: crypto.randomUUID(), sdp: 'v=0\r\n', ...extra } }));
      expect(await closed).toBe(1008);
    }
    expect(service.request).not.toHaveBeenCalled();
  });
  it('does not replay a duplicate voice start on the same connection', async () => {
    const { socket, messages } = await connect();
    const command = { id: crypto.randomUUID(), op: 'chat-voice-start',
      args: { key: crypto.randomUUID(), chatId: crypto.randomUUID(), sdp: 'v=0\r\n' } };
    socket.send(JSON.stringify(command));
    await vi.waitFor(() => expect(messages.some((message) => message.id === command.id)).toBe(true));
    socket.send(JSON.stringify(command));
    await vi.waitFor(() => expect(messages.filter((message) => message.id === command.id)).toHaveLength(2));
    expect(service.request).toHaveBeenCalledTimes(1);
  });
});
