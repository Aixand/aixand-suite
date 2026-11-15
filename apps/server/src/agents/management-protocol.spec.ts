import { describe, expect, it } from 'vitest';
import { agentsRequestSchema } from './protocol.js';

const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const revision = `sha256:${'a'.repeat(64)}`;
const accepts = (op: string, args: unknown) => agentsRequestSchema.safeParse({ id: key, op, args }).success;

describe('profile management protocol', () => {
  it('accepts bounded inspection, action history and authenticated challenge requests', () => {
    expect(accepts('agent-profile-get', { provider: 'codex', profile: 'work' })).toBe(true);
    expect(accepts('agent-management-actions', { chatId: key })).toBe(true);
    expect(accepts('agent-login-challenge', { operationId: key })).toBe(true);
    expect(accepts('agent-profile-get', { provider: 'codex', profile: '../escape' })).toBe(false);
    expect(accepts('agent-login-challenge', { operationId: key, token: 'fixture' })).toBe(false);
  });

  it('accepts Codex structured login with a guarded target and origin', () => {
    expect(accepts('agent-operation-start', { key, provider: 'codex', kind: 'new-login', auth: 'personal',
      device: true, structured: true, assignProfile: 'work', expectedRevision: revision, sourceChatId: key })).toBe(true);
    expect(accepts('agent-operation-start', { key, provider: 'codex', kind: 'new-login', auth: 'personal', assignProfile: 'work' })).toBe(false);
    expect(accepts('agent-operation-start', { key, provider: 'opencode', kind: 'new-login', auth: 'personal', structured: true })).toBe(true);
    expect(accepts('agent-operation-start', { key, provider: 'codex', kind: 'update', structured: true })).toBe(false);
  });

  it('preserves terminal login and accepts native profile revisions', () => {
    expect(accepts('agent-operation-start', { key, provider: 'codex', kind: 'new-login', auth: 'personal', device: true })).toBe(true);
    expect(accepts('agent-operation-start', { key, provider: 'claude', kind: 'profile-login', profile: 'work', expectedRevision: revision })).toBe(true);
  });
});
