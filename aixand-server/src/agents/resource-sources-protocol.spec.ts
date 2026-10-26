import { describe, it, expect } from 'vitest';
import { agentsRequestSchema } from './protocol';

describe('resource source request contracts', () => {
  const envelope = { id: '10000000-0000-4000-8000-000000000001', op: 'skills-managed-source-job-start',
    args: { key: '20000000-0000-4000-8000-000000000002', operation: 'discover', request: { url: 'https://github.com/example/skills' } } };
  it('accepts bounded public GitHub discovery', () => {
    expect(agentsRequestSchema.safeParse(envelope).success).toBe(true);
  });
  it('rejects unrelated or injected source request fields', () => {
    expect(agentsRequestSchema.safeParse({ ...envelope, args: { ...envelope.args, request: { ...envelope.args.request, command: 'execute' } } }).success).toBe(false);
  });
  it('requires a guarded installation request and an MCP operation', () => {
    const args = { ...envelope.args, operation: 'install', request: { publisher: 'github-123', identifier: 'server', expected_revision: 'sha256:' + 'a'.repeat(64) } };
    expect(agentsRequestSchema.safeParse({ ...envelope, args }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ ...envelope, op: 'mcp-managed-source-job-start', args }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ ...envelope, op: 'mcp-managed-source-job-start', args: { ...args, request: { publisher: 'github-123', identifier: 'server' } } }).success).toBe(false);
  });
});
