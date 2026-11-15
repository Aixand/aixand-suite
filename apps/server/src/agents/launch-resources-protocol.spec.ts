import { describe, expect, it } from 'vitest';
import { agentsRequestSchema } from './protocol.js';
const id = '40000000-0000-4000-8000-000000000001';
const skill = { kind: 'managed', publisher_id: 'undercurrent', skill_id: 'undercurrent' };
describe('shared resource request transport', () => {
  it('accepts owned targets without a release or host store path', () => {
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-create', args: { key: id, profile: 'work', mode: 'chat', resources: { skills: { add: [{ target: skill }] } } } }).success).toBe(true);
  });
  it('accepts revision-guarded aggregate profile defaults and offline previews', () => {
    expect(agentsRequestSchema.safeParse({ id, op: 'profile-resources-set', args: { provider: 'codex', profile: 'work', expectedRevision: 'sha256:' + 'a'.repeat(64), resources: { skills: [{ target: skill, required: true }], mcp: [{ target: 'sonar' }] } } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'launch-preview', args: { provider: 'codex', profile: 'work', resources: { inherit_profile: false } } }).success).toBe(true);
  });
  it('rejects unknown request versions and nonboolean required policies', () => {
    for (const resources of [{ schema: 'agent-manager/resource-request-99' }, { skills: { add: [{ target: skill, required: 'false' }] } }, { skills: { add: [{ target: { ...skill, script: 'unexpected' } }] } }]) {
      expect(agentsRequestSchema.safeParse({ id, op: 'chat-create', args: { key: id, profile: 'work', mode: 'chat', resources } }).success).toBe(false);
    }
  });
});

it('accepts managed MCP identities, revision pins and guarded reconciliation', () => {
  const target = { kind: 'managed', publisher_id: 'sonar', server_id: 'default', revision: 'sha256:' + 'b'.repeat(64) };
  expect(agentsRequestSchema.safeParse({ id, op: 'chat-create', args: { key: id, profile: 'work', mode: 'chat', resources: { schema: 'agent-manager/resource-request-2', mcp: { add: [{ target, required: false }] } } } }).success).toBe(true);
  expect(agentsRequestSchema.safeParse({ id, op: 'mcp-managed-apply', args: { publisherId: 'sonar', resourceId: 'default', expectedRevision: 'sha256:' + 'a'.repeat(64), take: 'managed' } }).success).toBe(true);
  expect(agentsRequestSchema.safeParse({ id, op: 'mcp-managed-save', args: { publisherId: 'sonar', resourceId: 'default', definition: { command: 'sonar' } } }).success).toBe(false);
});
