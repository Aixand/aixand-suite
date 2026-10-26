import { commandSchema } from './protocol.js';

const id = '395143ae-5758-42dd-9c39-9551c01e1fbd';
describe('Terminal request bounds', () => {
  it('requires explicit cleanup confirmation and keeps the CLI selection fixed', () => {
    expect(commandSchema.safeParse({ id, op: 'clean', args: { confirmed: true } }).success).toBe(true);
    for (const args of [{}, { confirmed: false }, { confirmed: 'true' },
      { confirmed: true, force: true }, { confirmed: true, name: 'running' },
      { confirmed: true, all: true }])
      expect(commandSchema.safeParse({ id, op: 'clean', args }).success).toBe(false);
  });
  it('requires an explicit boolean for My terminals and rejects arbitrary label writes', () => {
    for (const myTerminal of [true, false])
      expect(commandSchema.safeParse({
        id, op: 'set-my-terminal', args: { sessionId: 'session-1', myTerminal },
      }).success).toBe(true);
    for (const args of [
      { sessionId: 'session-1' },
      { sessionId: '', myTerminal: true },
      { sessionId: 'session-1', myTerminal: 'true' },
      { sessionId: 'session-1', myTerminal: true, labels: { app: 'changed' } },
    ]) expect(commandSchema.safeParse({ id, op: 'set-my-terminal', args }).success).toBe(false);
  });
  it('requires one explicit session and stop mode for lifecycle operations', () => {
    for (const op of ['stop', 'restart']) {
      for (const force of [false, true])
        expect(
          commandSchema.safeParse({
            id,
            op,
            args: { sessionId: 'session-1', force },
          }).success,
        ).toBe(true);
      for (const args of [
        { sessionId: 'session-1' },
        { sessionId: '', force: true },
        { sessionId: 'session-1', force: 'true' },
        { sessionId: 'session-1', force: true, all: true },
      ])
        expect(commandSchema.safeParse({ id, op, args }).success).toBe(false);
    }
  });
  it('requires explicit confirmation before removing a finished session', () => {
    expect(
      commandSchema.safeParse({
        id,
        op: 'remove',
        args: { sessionId: 'session-1', confirmed: true },
      }).success,
    ).toBe(true);
    for (const confirmed of [undefined, false, 'true'])
      expect(
        commandSchema.safeParse({
          id,
          op: 'remove',
          args: { sessionId: 'session-1', confirmed },
        }).success,
      ).toBe(false);
    expect(
      commandSchema.safeParse({
        id,
        op: 'remove',
        args: { sessionId: 'session-1', confirmed: true, force: true },
      }).success,
    ).toBe(false);
  });
  it('validates group membership preconditions and bounded group operations', () => {
    const assign = {
      id,
      op: 'group-assign',
      args: { sessionId: 'session-1', from: 'backend', to: 'frontend' },
    };
    expect(commandSchema.safeParse(assign).success).toBe(true);
    expect(
      commandSchema.safeParse({
        ...assign,
        args: { sessionId: 'session-1', to: 'frontend' },
      }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ ...assign, args: { ...assign.args, to: null } })
        .success,
    ).toBe(true);
    for (const name of ['', '../group', 'a'.repeat(49), 'two words']) {
      expect(
        commandSchema.safeParse({
          id,
          op: 'group-create',
          args: { name, persistent: true },
        }).success,
      ).toBe(false);
    }
    expect(
      commandSchema.safeParse({
        id,
        op: 'group-delete',
        args: { group: 'backend', stop: true },
      }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({
        id,
        op: 'create',
        args: { name: 'api', group: 'backend', columns: 80, rows: 24 },
      }).success,
    ).toBe(true);
  });
  it('bounds inspector reads and subscriptions to supported operations', () => {
    for (const op of ['inspect', 'events', 'watch-events']) {
      expect(
        commandSchema.safeParse({ id, op, args: { sessionId: 'session-1' } })
          .success,
      ).toBe(true);
      expect(
        commandSchema.safeParse({ id, op, args: { sessionId: '' } }).success,
      ).toBe(false);
    }
    expect(
      commandSchema.safeParse({
        id,
        op: 'watch-events',
        args: { sessionId: 'session-1', after: '18446744073709551615' },
      }).success,
    ).toBe(true);
    expect(
      commandSchema.safeParse({
        id,
        op: 'watch-events',
        args: { sessionId: 'session-1', after: '-1' },
      }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({
        id,
        op: 'inspect',
        args: { sessionId: 'session-1', environment_values: true },
      }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ id, op: 'unwatch', args: { kind: 'terminal' } })
        .success,
    ).toBe(false);
  });
  it('accepts raw control and UTF-8 bytes without command interpretation', () => {
    expect(
      commandSchema.safeParse({
        id,
        op: 'input',
        args: {
          sessionId: 'session-1',
          data: Buffer.from('\x03你好\r').toString('base64'),
        },
      }).success,
    ).toBe(true);
  });
  it('accepts independent pane IDs and rejects malformed pane routing', () => {
    for (const op of ['attach', 'detach']) {
      const args = op === 'attach' ? { sessionId: 'session-1' } : {};
      for (const paneId of [undefined, id])
        expect(
          commandSchema.safeParse({ id, op, args: { ...args, paneId } })
            .success,
        ).toBe(true);
      expect(
        commandSchema.safeParse({
          id,
          op,
          args: { ...args, paneId: 'invalid' },
        }).success,
      ).toBe(false);
    }
  });
  it('rejects invalid encodings, large input, and unsafe geometry', () => {
    for (const data of ['%', 'a'.repeat(44_004)])
      expect(
        commandSchema.safeParse({
          id,
          op: 'input',
          args: { sessionId: 'session-1', data },
        }).success,
      ).toBe(false);
    expect(
      commandSchema.safeParse({
        id,
        op: 'resize',
        args: { sessionId: 'session-1', columns: 0, rows: 24 },
      }).success,
    ).toBe(false);
  });
  it('does not expose arbitrary product operations or executable selection', () => {
    expect(
      commandSchema.safeParse({ id, op: 'shutdown_daemon', args: {} }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({
        id,
        op: 'create',
        args: { name: 'shell', columns: 80, rows: 24, program: '/bin/other' },
      }).success,
    ).toBe(false);
  });
});
