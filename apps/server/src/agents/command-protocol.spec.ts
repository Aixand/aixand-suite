import { agentsRequestSchema } from './protocol.js';

describe('Command request boundary', () => {
  const monitorId = crypto.randomUUID();
  const valid = (op: string, args: object) => agentsRequestSchema.safeParse({ id: crypto.randomUUID(), op, args }).success;
  it('accepts durable mandates, revision checks, exact targets and bounded observations', () => {
    expect(valid('command-create', { key: crypto.randomUUID(), title: 'Checkout', instruction: 'Finish and verify checkout.',
      watches: [{ kind: 'chat', targetId: monitorId }, { kind: 'timer', intervalSeconds: 60 }],
      limits: { maxEvaluations: 100, maxActionsPerEvaluation: 30 } })).toBe(true);
    expect(valid('command-update', { key: crypto.randomUUID(), monitorId, expectedRevision: 2, freshSession: true })).toBe(true);
    expect(valid('command-list', { before: 50, limit: 20 })).toBe(true);
    expect(valid('command-action', { monitorId, actionId: crypto.randomUUID(), offset: 16000 })).toBe(true);
  });
  it('rejects browser impersonation of supervisor checkpoints and private source responses', () => {
    expect(valid('checkpoint_monitor', { monitorId, state: 'completed' })).toBe(false);
    expect(valid('command-checkpoint', { monitorId, state: 'completed' })).toBe(false);
    expect(valid('command-source-response', { id: monitorId, result: {} })).toBe(false);
    expect(valid('command-create', { key: crypto.randomUUID(), title: 'X', instruction: 'Y', _automationId: monitorId })).toBe(false);
  });
  it('rejects unbounded schedules, missing revisions and caller filesystem overrides', () => {
    expect(valid('command-list', { limit: 101 })).toBe(false);
    expect(valid('command-update', { key: crypto.randomUUID(), monitorId, direction: 'Change' })).toBe(false);
    for (const extra of [{ cwd: '/tmp' }, { watches: [{ kind: 'timer', intervalSeconds: 1 }] }, { limits: { maxEvaluations: 0 } }])
      expect(valid('command-create', { key: crypto.randomUUID(), title: 'X', instruction: 'Y', ...extra })).toBe(false);
  });
});
