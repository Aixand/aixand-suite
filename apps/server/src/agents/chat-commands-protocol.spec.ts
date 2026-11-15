import { describe, expect, it } from 'vitest';
import { agentsRequestSchema } from './protocol.js';

describe('session command protocol', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const valid = (op: string, args: object) => agentsRequestSchema.safeParse({ id, op, args }).success;

  it('accepts session-scoped discovery, commands and explicit setting values', () => {
    expect(valid('chat-commands', { chatId: id })).toBe(true);
    expect(valid('chat-command', { chatId: id, key: id, command: 'review', arguments: 'Focus on tests' })).toBe(true);
    expect(valid('chat-config-set', { chatId: id, key: id, configId: 'serviceTier', value: 'fast' })).toBe(true);
    expect(valid('chat-create', { key: id, provider: 'opencode', profile: 'work', backend: 'opencode-acp', mode: 'chat' })).toBe(true);
    expect(valid('chat-create', { key: id, provider: 'opencode', profile: 'work', backend: 'opencode-native', mode: 'chat' })).toBe(true);
    expect(valid('chat-send', { key: id, chatId: id, text: 'Follow up', followupMode: 'steer' })).toBe(true);
    expect(valid('chat-send', { key: id, chatId: id, text: 'Later task', followupMode: 'queue' })).toBe(true);
    expect(valid('chat-send', { key: id, chatId: id, text: 'Follow up', followupMode: 'interrupt' })).toBe(false);
  });

  it('rejects caller-selected wire methods, extra identities and oversized arguments', () => {
    for (const extra of [{ method: 'thread/start' }, { provider: 'claude' }, { connectionRef: {} }, { arguments: 'x'.repeat(24001) }])
      expect(valid('chat-command', { chatId: id, key: id, command: 'review', ...extra })).toBe(false);
    expect(valid('chat-commands', { chatId: id, cwd: '/etc' })).toBe(false);
    expect(valid('chat-command', { chatId: id, key: id, command: '' })).toBe(false);
  });
});
