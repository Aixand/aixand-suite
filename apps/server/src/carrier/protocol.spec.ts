import { parseRequest } from './protocol.js';

describe('Carrier request boundary', () => {
  it('accepts bounded delegated-work reads and rejects arbitrary task storage or cursors', () => {
    const taskId = '414ada5e-cc96-50bb-9c84-cece1c5d35b3';
    expect(parseRequest({ id: 'read', op: 'delegated_tasks', args: {} }).args).toEqual({ limit: 50 });
    expect(parseRequest({ id: 'read', op: 'delegated_task', args: { taskId } }).args).toEqual({ taskId });
    for (const args of [{ limit: 101 }, { before: 0 }, { before: Number.MAX_SAFE_INTEGER + 1 }, { database: '/other.db' }])
      expect(() => parseRequest({ id: 'read', op: 'delegated_tasks', args })).toThrow();
    expect(() => parseRequest({ id: 'read', op: 'delegated_task', args: { taskId: 'other' } })).toThrow();
  });
  it('accepts a model choice and bounds invalid model overrides', () => {
    const args = { key: 'launch', provider: 'opencode', profile: 'work', prompt: 'hello' };
    expect(parseRequest({ id: 'request', op: 'launch', args: { ...args, model: 'fixture/fast' } }).args).toMatchObject({ model: 'fixture/fast' });
    for (const model of ['', ' ', 'x'.repeat(257), null])
      expect(() => parseRequest({ id: 'request', op: 'launch', args: { ...args, model } })).toThrow();
  });
  it('accepts explicit addressed sends with separate durable keys', () => {
    expect(
      parseRequest({
        id: 'request',
        op: 'send',
        args: { key: 'durable', to: 'peer', content: 'hello', reply_to: 12 },
      }).args,
    ).toMatchObject({ mailbox: 'user', key: 'durable', reply_to: 12 });
  });
  it.each([
    {
      op: 'send',
      args: {
        key: 'a',
        to: 'peer',
        content: 'x',
        credentials: '/tmp/private.json',
      },
    },
    {
      op: 'send',
      args: { key: 'a', to: 'peer', content: 'x', reply_to: '12' },
    },
    { op: 'send', args: { key: 'a', to: 'peer', content: 'x'.repeat(100001) } },
    { op: 'set_message_state', args: { id: 1 } },
    { op: 'messages', args: { limit: 101 } },
    {
      op: 'launch',
      args: { key: 'a', profile: 'default', prompt: 'x', cwd: '/browser/path' },
    },
    { op: 'recover', args: { key: 'a', manifest: '/browser/path' } },
  ])('rejects invalid or browser-controlled configuration %#', (value) => {
    expect(() => parseRequest({ id: 'request', ...value })).toThrow();
  });
});
