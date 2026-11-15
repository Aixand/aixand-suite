import { describe, expect, it } from 'vitest';
import { agentsRequestSchema } from './protocol.js';

const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const expectedRevision = `sha256:${'a'.repeat(64)}`;
const valid = (op: string, args: object) => agentsRequestSchema.safeParse({ id: key, op, args }).success;

describe('account profile updates', () => {
  it('accepts one guarded save of account, chat credentials, model and preference', () => {
    expect(valid('agent-profile-update', { key, provider: 'claude', profile: 'work', expectedRevision,
      changes: { claudeAccountId: key, sdkAuthentication: 'api-key', sdkCredential: 'billing', model: 'model', preferred: true } })).toBe(true);
    expect(valid('agent-profile-update', { key, provider: 'codex', profile: 'work', expectedRevision,
      changes: { auth: null, preferIfUnset: true } })).toBe(true);
  });
  it('rejects secrets, unknown changes, missing revisions and invalid paths', () => {
    const args = { key, provider: 'claude', profile: 'work', expectedRevision, changes: {} };
    for (const changes of [{ apiKey: 'secret' }, { claudeAccountId: '../escape' }, { preferred: 'yes' }])
      expect(valid('agent-profile-update', { ...args, changes })).toBe(false);
    expect(valid('agent-profile-update', { ...args, expectedRevision: undefined })).toBe(false);
    expect(valid('agent-profile-check', { provider: 'copilot', profile: 'work' })).toBe(true);
    expect(valid('agent-profile-check', { provider: 'copilot', profile: '../escape' })).toBe(false);
  });
});
