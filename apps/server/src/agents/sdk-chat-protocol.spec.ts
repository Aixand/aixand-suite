import { describe, expect, it } from 'vitest';
import { agentsRequestSchema } from './protocol.js';

describe('SDK conversation queue modes', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const valid = (queueMode?: string) => agentsRequestSchema.safeParse({
    id, op: 'chat-queue', args: { key: id, chatId: id, text: 'Follow up', ...(queueMode ? { queueMode } : {}) },
  }).success;

  it('accepts the public delivery modes and the existing default', () => {
    expect(valid()).toBe(true);
    expect(valid('after_turn')).toBe(true);
    expect(valid('next_tool_completion')).toBe(true);
    expect(valid('after_tool')).toBe(false);
  });
});


describe('explicit Suite worker selection', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const valid = (environment: string, access: string) => agentsRequestSchema.safeParse({
    id, op: 'chat-create', args: { key: id, provider: 'opencode', profile: 'work', mode: 'chat', suiteTools: true,
      toolWorkerEnvironmentId: environment, toolWorkerPermissionMode: access },
  }).success;
  it('accepts an immutable worker target and known access ceiling', () => {
    expect(valid(id, 'read-only')).toBe(true);
    expect(valid('alias', 'read-only')).toBe(false);
    expect(valid(id, 'allow-everything')).toBe(false);
  });
});


describe('completion read acknowledgements', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  it('requires the specific completed turn so stale reads cannot acknowledge newer replies', () => {
    const valid = (args: object) => agentsRequestSchema.safeParse({ id, op: 'chat-mark-read', args }).success;
    expect(valid({ chatId: id, turnId: 'completed-turn' })).toBe(true);
    expect(valid({ chatId: id })).toBe(false);
    expect(valid({ chatId: id, turnId: '' })).toBe(false);
  });
});
