import { agentsRequestSchema } from './protocol.js';

describe('provider software operations', () => {
  const valid = (args: object) => agentsRequestSchema.safeParse({ id: crypto.randomUUID(), op: 'agent-operation-start', args }).success;
  for (const kind of ['uninstall', 'disable', 'enable']) {
    it(`${kind} requires confirmation of the current installation and rejects shell commands`, () => {
      const args = { key: crypto.randomUUID(), provider: 'claude', kind, installationRevision: `sha256:${'a'.repeat(64)}`, confirmed: true, whenIdle: true };
      expect(valid(args)).toBe(true);
      for (const change of [{ confirmed: undefined }, { confirmed: false }, { installationRevision: undefined },
        { installationRevision: 'old' }, { command: 'rm -rf' }, { path: '/arbitrary' }, { method: 'npm' },
        { auth: 'work' }, { profile: 'work' }, { device: true }])
        expect(valid({ ...args, ...change })).toBe(false);
    });
  }
});
