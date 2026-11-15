import { agentsRequestSchema } from './protocol.js';

describe('Aixand Connect gateway contract', () => {
  const id = crypto.randomUUID();
  const valid = (op: string, args: object) => agentsRequestSchema.safeParse({ id, op, args }).success;

  it('accepts paired identities and rejects arbitrary remote addresses and commands', () => {
    const args = { key: crypto.randomUUID(), chatId: crypto.randomUUID(), deviceId: crypto.randomUUID(), path: 'dist/app.zip' };
    expect(valid('connect-send', args)).toBe(true);
    for (const extra of [{ host: '169.254.169.254' }, { token: 'secret' }, { command: 'sh' }, { destination: '/etc/passwd' }, { deviceId: 'anything' }])
      expect(valid('connect-send', { ...args, ...extra })).toBe(false);
    expect(valid('connect-cancel', { transferId: id, chatId: id })).toBe(true);
    expect(valid('connect-check', { transferId: id })).toBe(true);
  });

  it('bounds pairing and keeps its credential separate from transfer arguments', () => {
    const args = { key: id, peerId: 'netbird-peer', name: 'Windows PC', code: 'a'.repeat(43), port: 47831 };
    expect(valid('connect-pair', args)).toBe(true);
    for (const extra of [{ port: 0 }, { port: 65536 }, { code: '' }, { name: '' }, { ip: '127.0.0.1' }])
      expect(valid('connect-pair', { ...args, ...extra })).toBe(false);
  });

  it('addresses remote chats through paired device IDs and validated directories', () => {
    const args = { key: id, deviceId: id, profile: null, mode: 'work', cwd: '~/dev/project', permissionMode: 'workspace-write' };
    expect(valid('chat-create', args)).toBe(true);
    expect(valid('connect-codex-inspect', { deviceId: id, cwd: '~/dev/project' })).toBe(true);
    for (const extra of [{ host: '127.0.0.1' }, { token: 'secret' }, { deviceId: 'bad' }, { permissionMode: 'anything' }])
      expect(valid('chat-create', { ...args, ...extra })).toBe(false);
  });

  it('accepts local and companion approval IDs without rewriting their identity', () => {
    const args = { key: id, chatId: id, decision: 'accept' };
    for (const requestId of ['a'.repeat(32), '8576cb16-f148-4e3c-937a-51a947575fd0']) {
      const parsed = agentsRequestSchema.safeParse({ id, op: 'chat-answer', args: { ...args, requestId } });
      expect(parsed.success).toBe(true);
      if (parsed.success && parsed.data.op === 'chat-answer')
        expect(parsed.data.args.requestId).toBe(requestId);
    }
    for (const requestId of ['', 1, 'a'.repeat(31), 'a'.repeat(33), 'not-an-approval',
      '8576cb16-f148-4e3c-937a-51a947575fd0/extra', 'z'.repeat(32)])
      expect(valid('chat-answer', { ...args, requestId })).toBe(false);
  });

  it('selects a remote profile while keeping manager addresses and runtimes server-owned', () => {
    const args = { key: id, deviceId: id, profile: null, remoteProfile: 'personal', mode: 'work', cwd: '~/dev/project' };
    expect(valid('chat-create', args)).toBe(true);
    expect(valid('connect-managers-inspect', { deviceId: id })).toBe(true);
    for (const extra of [{ managerPython: '/bin/sh' }, { connectionRef: {} }, { remoteProfile: '../work' }])
      expect(valid('chat-create', { ...args, ...extra })).toBe(false);
    expect(valid('connect-managers-inspect', { deviceId: id, host: '127.0.0.1' })).toBe(false);
  });

  it('starts project tests with paired and saved identities only', () => {
    const args = { key: id, chatId: id, deviceId: id, projectId: id, instruction: 'Run tests', permissionMode: 'workspace-write' };
    expect(valid('connect-project-start', args)).toBe(true);
    for (const extra of [{ host: '127.0.0.1' }, { token: 'secret' }, { cwd: '/tmp' }, { projectId: 'bad' }, { instruction: 'x'.repeat(24001) }])
      expect(valid('connect-project-start', { ...args, ...extra })).toBe(false);
    expect(valid('connect-project-check', { chatId: id, runId: id })).toBe(true);
    expect(valid('connect-project-cancel', { chatId: id, runId: id })).toBe(true);
    expect(valid('connect-project-cancel', { chatId: id, runId: 'bad' })).toBe(false);
  });

  it('copies a project without accepting instructions or execution permissions', () => {
    const args = { key: id, chatId: id, deviceId: id, projectId: id };
    expect(valid('connect-project-copy', args)).toBe(true);
    for (const extra of [{ instruction: 'Run tests' }, { permissionMode: 'workspace-write' }, { profileSelection: { mode: 'auto' } }, { cwd: '/tmp' },
      { host: '127.0.0.1' }, { token: 'secret' }, { projectId: 'bad' }])
      expect(valid('connect-project-copy', { ...args, ...extra })).toBe(false);
  });
  it('validates device selection policies and bounded per-target overrides', () => {
    const args = { key: id, chatId: id, deviceId: id };
    for (const profileSelection of [{ mode: 'auto' }, { mode: 'direct' }, { mode: 'specific', profile: 'auto' }])
      expect(valid('connect-project-start', { ...args, profileSelection })).toBe(true);
    for (const profileSelection of [{ mode: 'specific' }, { mode: 'auto', profile: 'work' },
      { mode: 'controller' }, { mode: 'specific', profile: '../work' }, { mode: 'auto', env: {} }])
      expect(valid('connect-project-start', { ...args, profileSelection })).toBe(false);
    const matrix = { key: id, chatId: id, deviceIds: [id], includeHost: true,
      targetProfiles: [{ deviceId: id, profileSelection: { mode: 'specific', profile: 'personal' } }] };
    expect(valid('connect-project-compare', matrix)).toBe(true);
    expect(valid('connect-project-compare', { ...matrix, targetProfiles: Array(5).fill(matrix.targetProfiles[0]) })).toBe(false);
  });
  it('compares selected paired machines and optionally the Suite host with scoped controls', () => {
    const args = { key: id, chatId: id, projectId: id, deviceIds: [id], includeHost: true };
    expect(valid('connect-project-targets', {})).toBe(true);
    expect(valid('connect-project-compare', args)).toBe(true);
    for (const extra of [{ deviceIds: [] }, { deviceIds: ['bad'] }, { deviceIds: Array(5).fill(id) },
      { includeHost: 'yes' }, { cwd: '/tmp' }, { host: '127.0.0.1' }, { _projectSnapshot: id }])
      expect(valid('connect-project-compare', { ...args, ...extra })).toBe(false);
    for (const op of ['connect-project-check', 'connect-project-cancel']) {
      expect(valid(op, { chatId: id, runId: id, targetId: id })).toBe(true);
      expect(valid(op, { chatId: id, runId: id, targetId: 'bad' })).toBe(false);
    }
    expect(valid('chat-create', { key: id, profile: 'work', mode: 'work', projectId: id, _projectSnapshot: id })).toBe(false);
  });

});
