import { describe, expect, it } from 'vitest';
import { agentsRequestSchema } from './protocol.js';

describe('backend discovery protocol', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const valid = (op: string, args: object) => agentsRequestSchema.safeParse({ id, op, args }).success;
  const context = { provider: 'claude', profile: 'work', backend: 'claude-sdk' };
  it('accepts profile-scoped discovery and keyed explicit refresh', () => {
    expect(valid('backend-discovery-get', context)).toBe(true);
    expect(valid('backend-discovery-refresh', { ...context, key: id, projectId: id, resources: {} })).toBe(true);
    expect(valid('backend-discovery-get', { ...context, provider: 'antigravity', backend: 'antigravity-sdk' })).toBe(true);
  });
  it('rejects mismatched providers, caller credentials and unregistered context selectors', () => {
    for (const extra of [{ backend: 'antigravity-sdk' }, { env: { ANTHROPIC_API_KEY: 'secret' } }, { cwd: '/etc' }])
      expect(valid('backend-discovery-get', { ...context, ...extra })).toBe(false);
    expect(valid('backend-discovery-refresh', context)).toBe(false);
  });
  it('accepts native, ACP, Auto, and a stable draft/model context', () => {
    for (const [provider, backend] of [['codex', 'native-codex'], ['codex', 'codex-acp'], ['opencode', 'opencode-native'], ['copilot', 'copilot-acp']])
      expect(valid('backend-discovery-get', { provider, backend, profile: null, draftId: id, model: 'fixture-one' })).toBe(true);
  });
  it('accepts bounded initial settings and rejects arbitrary provider RPC descriptors', () => {
    const create = { ...context, key: id, mode: 'chat' };
    expect(valid('chat-create', { ...create, initialConfig: [{ id: 'mode', value: 'plan' }] })).toBe(true);
    for (const initialConfig of [[{ id: 'mode', value: {} }], [{ method: 'send', value: 'plan' }], Array(17).fill({ id: 'mode', value: 'plan' })])
      expect(valid('chat-create', { ...create, initialConfig })).toBe(false);
  });
});
