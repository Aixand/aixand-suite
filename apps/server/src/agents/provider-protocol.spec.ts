import { agentsRequestSchema } from './protocol.js';

describe('provider chat contracts', () => {
  const valid = (op: string, args: object) => agentsRequestSchema.safeParse({ id: crypto.randomUUID(), op, args }).success;
  it('accepts scoped provider profiles and keeps operation settings bounded', () => {
    for (const provider of ['codex', 'opencode', 'claude', 'antigravity']) {
      expect(valid('chat-create', { key: crypto.randomUUID(), provider, profile: 'work', mode: 'chat' })).toBe(true);
      expect(valid('create-profile', { provider, profile: 'work' })).toBe(true);
    }
    expect(valid('chat-create', { key: crypto.randomUUID(), provider: 'invalid/provider', profile: 'work', mode: 'chat' })).toBe(false);
    expect(valid('chat-config-set', { key: crypto.randomUUID(), chatId: crypto.randomUUID(), configId: 'model', value: 'advertised-model' })).toBe(true);
    expect(valid('chat-config-set', { key: crypto.randomUUID(), chatId: crypto.randomUUID(), configId: 'model', value: { command: 'arbitrary' } })).toBe(false);
  });
  it('rejects removed backends while allowing Antigravity SDK chats', () => {
    const args = { key: crypto.randomUUID(), profile: 'work', mode: 'chat' };
    expect(valid('chat-create', { ...args, provider: 'antigravity', backend: 'antigravity-sdk' })).toBe(true);
    expect(valid('chat-create', { ...args, backend: 'gemini-acp' })).toBe(false);
  });
  it('keeps profile sign-in distinct from saved login and maintenance', () => {
    const args = { key: crypto.randomUUID(), provider: 'claude', kind: 'profile-login', profile: 'work' };
    expect(valid('agent-operation-start', args)).toBe(true);
    for (const extra of [{ profile: undefined }, { auth: 'work' }, { method: 'npm' }, { whenIdle: true }, { device: true }])
      expect(valid('agent-operation-start', { ...args, ...extra })).toBe(false);
  });
});
