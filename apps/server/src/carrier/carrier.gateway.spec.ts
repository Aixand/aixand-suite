import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { CarrierGateway } from './carrier.gateway.js';
import type { CarrierService } from './carrier.service.js';
import type { AgentsService } from '../agents/agents.service.js';
import type { AuthService } from '../auth/auth.service.js';

const taskId = '414ada5e-cc96-50bb-9c84-cece1c5d35b3';
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(authorized = true) {
  const carrier = { subscribe: vi.fn(() => vi.fn()), start: vi.fn(async () => {}), request: vi.fn() };
  const agents = { setCommandSource: vi.fn(), request: vi.fn(async () => ({ type: 'result', result: { tasks: [], next_before: null } })) };
  let receive: (raw: Buffer, binary: boolean) => void = () => {};
  const auth = { authorizeSocket: vi.fn(() => authorized), canSend: vi.fn(() => true),
    onMessage: vi.fn((_socket: unknown, callback: (raw: Buffer, binary: boolean) => void) => { receive = callback; }) };
  const socket = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, bufferedAmount: 0,
    send: vi.fn(), ping: vi.fn(), close: vi.fn(), terminate: vi.fn() });
  const gateway = new CarrierGateway(carrier as unknown as CarrierService, auth as unknown as AuthService, agents as unknown as AgentsService);
  gateway.handleConnection(socket as unknown as WebSocket, {} as IncomingMessage);
  return { carrier, agents, socket, send: (op: string, args: object) => receive(Buffer.from(JSON.stringify({ id: 'read', op, args })), false) };
}

it('routes historical task reads through the workspace agent bridge, not Carrier mailbox mutations', async () => {
  const f = fixture();
  try {
    await settle();
    f.send('delegated_tasks', { limit: 20 });
    await settle();
    expect(f.agents.request).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'suite-delegated-tasks', args: { limit: 20 } }));
    f.send('delegated_task', { taskId });
    await settle();
    expect(f.agents.request).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'suite-delegated-task', args: { taskId } }));
    expect(f.carrier.request).not.toHaveBeenCalled();
    expect(JSON.parse(f.socket.send.mock.calls.at(-1)![0])).toMatchObject({ type: 'result', id: 'read' });
  } finally { f.socket.emit('close'); }
});

it('does not read tasks for an unauthorized socket or accept browser-selected storage', async () => {
  const denied = fixture(false);
  denied.send('delegated_tasks', {});
  expect(denied.agents.request).not.toHaveBeenCalled();
  expect(denied.carrier.start).not.toHaveBeenCalled();
  const f = fixture();
  try {
    await settle();
    f.send('delegated_task', { taskId, credentials: '/private/receiver.json' });
    await settle();
    expect(f.agents.request).not.toHaveBeenCalled();
    expect(JSON.parse(f.socket.send.mock.calls.at(-1)![0])).toMatchObject({ type: 'error', code: 'invalid_request' });
  } finally { f.socket.emit('close'); }
});

it('returns a task read failure without sending it to the mailbox adapter', async () => {
  const f = fixture();
  f.agents.request.mockResolvedValue({ type: 'error', code: 'not_found', message: 'Delegated work not found in this workspace' } as never);
  try {
    await settle(); f.send('delegated_task', { taskId }); await settle();
    expect(JSON.parse(f.socket.send.mock.calls.at(-1)![0])).toMatchObject({ type: 'error', code: 'not_found' });
    expect(f.carrier.request).not.toHaveBeenCalled();
  } finally { f.socket.emit('close'); }
});
