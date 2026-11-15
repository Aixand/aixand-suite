import { agentContextSchema, agentsRequestSchema } from './protocol.js';

describe('spawn policy contracts', () => {
  const id = crypto.randomUUID();
  it('allows Manual as a saved default, while runtime modes remain concrete', () => {
    expect(agentsRequestSchema.safeParse({ id, op: 'spawn-settings-set', args: { defaultMode: 'manual', expectedRevision: 0 } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-workflow-start', args: { key: crypto.randomUUID(), chatId: crypto.randomUUID(), projectId: crypto.randomUUID(), permissionMode: 'manual' } }).success).toBe(false);
  });
  it('validates workflow and stage selectors and rejects ambiguous policies', () => {
    const args = { key: crypto.randomUUID(), chatId: crypto.randomUUID(), projectId: crypto.randomUUID(),
      profileSelection: { mode: 'auto', eligibleProfiles: ['work', 'backup'] },
      steps: [{ id: 'review', title: 'Review', instruction: 'Audit', dependsOn: [], profileSelection: { mode: 'specific', profile: 'backup' } }], deliveryStep: 'review' };
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-workflow-start', args }).success).toBe(true);
    for (const profileSelection of [{ mode: 'specific' }, { mode: 'auto', profile: 'work' }, { mode: 'auto', eligibleProfiles: [] }, { mode: 'auto', eligibleProfiles: ['work', 'work'] }, { mode: 'controller', eligibleProfiles: ['work'] }]) {
      expect(agentsRequestSchema.safeParse({ id, op: 'chat-workflow-start', args: { ...args, profileSelection } }).success).toBe(false);
    }
  });
});

describe('Agent requests', () => {
  const id = crypto.randomUUID();
  it('accepts native profile sign-in methods separately from installation methods', () => {
    const args = { key: crypto.randomUUID(), provider: 'codex', kind: 'profile-login', profile: 'work' };
    const valid = (extra: object) => agentsRequestSchema.safeParse({ id, op: 'agent-operation-start', args: { ...args, ...extra } }).success;
    expect(valid({})).toBe(true);
    for (const method of ['browser', 'device', 'terminal']) expect(valid({ method })).toBe(true);
    for (const method of ['npm', 'brew', 'installer', '--token']) expect(valid({ method })).toBe(false);
    for (const extra of [{ profile: undefined }, { auth: 'personal' }, { device: true }, { whenIdle: true }])
      expect(valid(extra)).toBe(false);
    for (const method of ['npm', 'brew', 'installer'])
      expect(valid({ kind: 'install', profile: undefined, method })).toBe(true);
    for (const kind of ['install', 'update', 'repair'])
      for (const method of ['browser', 'device', 'terminal'])
        expect(valid({ kind, profile: undefined, method })).toBe(false);
  });
  it('accepts a tested-version restore only as an explicit repair choice', () => {
    const args = { key: crypto.randomUUID(), provider: 'opencode', kind: 'repair', versionTarget: 'recommended', whenIdle: true };
    const valid = (extra: object) => agentsRequestSchema.safeParse({ id, op: 'agent-operation-start', args: { ...args, ...extra } }).success;
    expect(valid({})).toBe(true);
    expect(valid({ versionTarget: undefined })).toBe(true);
    for (const kind of ['install', 'update', 'install-sdk', 'disable', 'new-login']) expect(valid({ kind })).toBe(false);
    for (const versionTarget of ['latest', '2.2.0', '>=2', '../other']) expect(valid({ versionTarget })).toBe(false);
  });
  it('requires reviewed account mutations and rejects credential payloads', () => {
    const accountId = crypto.randomUUID(), key = crypto.randomUUID();
    const expectedRevision = `sha256:${'a'.repeat(64)}`;
    const valid = (op: string, args: object) => agentsRequestSchema.safeParse({ id, op, args }).success;
    expect(valid('claude-account-create', { key, name: 'personal' })).toBe(true);
    expect(valid('claude-account-bind', { key, profile: 'work', accountId, expectedRevision })).toBe(true);
    expect(valid('claude-account-check', { accountId })).toBe(true);
    for (const op of ['claude-account-logout', 'claude-account-remove']) {
      const args = { key, accountId, expectedRevision, confirmed: true };
      expect(valid(op, args)).toBe(true);
      for (const extra of [{ confirmed: false }, { expectedRevision: undefined }, { key: undefined },
        { accountId: '../other' }, { token: 'secret' }, { env: {} }])
        expect(valid(op, { ...args, ...extra })).toBe(false);
    }
    expect(valid('claude-account-migrate', { key, confirmed: true })).toBe(true);
    expect(valid('claude-account-migrate', { key })).toBe(false);
    expect(valid('claude-account-create', { key, name: 'personal', credentials: {} })).toBe(false);
    const reset = { key, scope: 'everything', confirmation: 'RESET EVERYTHING', signOutExternalClaude: true };
    expect(valid('workspace-reset', reset)).toBe(true);
    expect(valid('workspace-reset', { ...reset, scope: 'chats', confirmation: 'RESET CHATS' })).toBe(false);
  });
  it('accepts explicit revisioned Claude SDK authentication without browser credentials or paths', () => {
    const valid = (args: object) => agentsRequestSchema.safeParse({ id, op: 'sdk-auth-configure', args }).success;
    const args = { provider: 'claude', profile: 'work', method: 'profile-login', expectedRevision: `sha256:${'a'.repeat(64)}` };
    expect(valid(args)).toBe(true);
    expect(valid({ ...args, method: 'api-key' })).toBe(true);
    for (const extra of [{ provider: 'antigravity' }, { expectedRevision: undefined }, { method: 'automatic' },
      { profile: '../other' }, { configDir: '/other-account' }, { token: 'secret' }, { env: { HOME: '/other-account' } }])
      expect(valid({ ...args, ...extra })).toBe(false);
  });
  it('accepts Auto model discovery only for Codex and preserves explicit profiles', () => {
    const args = { provider: 'codex', profile: null, cwd: '/workspace' };
    expect(agentsRequestSchema.safeParse({ id, op: 'models', args: { ...args, refresh: true } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'models', args: { ...args, refresh: 'true' } }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'models', args }).success).toBe(true);
    for (const provider of ['codex', 'opencode', 'claude', 'antigravity']) {
      expect(agentsRequestSchema.safeParse({ id, op: 'models', args: { ...args, provider, profile: 'work' } }).success).toBe(true);
      if (provider !== 'codex')
        expect(agentsRequestSchema.safeParse({ id, op: 'models', args: { ...args, provider } }).success).toBe(false);
    }
    for (const profile of [undefined, '', '../outside'])
      expect(agentsRequestSchema.safeParse({ id, op: 'models', args: { ...args, profile } }).success).toBe(false);
  });
  it('requires an explicit reset scope, retry key, and matching typed confirmation', () => {
    for (const scope of ['chats', 'everything']) {
      const args = { key: crypto.randomUUID(), scope, confirmation: scope === 'chats' ? 'RESET CHATS' : 'RESET EVERYTHING' };
      expect(agentsRequestSchema.safeParse({ id, op: 'workspace-reset', args }).success).toBe(true);
      for (const extra of [{ key: undefined }, { scope: undefined }, { scope: 'all' }, { confirmation: '' }, { confirmation: undefined }, { force: true }])
        expect(agentsRequestSchema.safeParse({ id, op: 'workspace-reset', args: { ...args, ...extra } }).success).toBe(false);
    }
    expect(agentsRequestSchema.safeParse({ id, op: 'workspace-reset', args: { key: crypto.randomUUID(), scope: 'chats', confirmation: 'RESET EVERYTHING' } }).success).toBe(false);
  });
  it('accepts Suite presets and receipt-based upgrades without browser runtime bindings', () => {
    const args = { key: crypto.randomUUID(), profile: 'work', mode: 'chat' };
    for (const suiteTools of [true, false])
      expect(agentsRequestSchema.safeParse({ id, op: 'chat-create', args: { ...args, suiteTools } }).success).toBe(true);
    for (const extra of [{ suiteTools: 'true' }, { application_resources: {} }, { runtime_bindings: [] }])
      expect(agentsRequestSchema.safeParse({ id, op: 'chat-create', args: { ...args, ...extra } }).success).toBe(false);
    for (const applicationPreset of ['controller', 'basic', 'worker', 'workflow'])
      expect(agentsRequestSchema.safeParse({ id, op: 'launch-preview', args: { provider: 'codex', profile: 'work', resources: {}, applicationPreset } }).success).toBe(true);
    for (const op of ['suite-tools-refresh', 'suite-mcp-context']) {
      const context = { chatId: crypto.randomUUID(), key: crypto.randomUUID() };
      expect(agentsRequestSchema.safeParse({ id, op, args: context }).success).toBe(true);
      expect(agentsRequestSchema.safeParse({ id, op, args: { chatId: context.chatId } }).success).toBe(false);
      expect(agentsRequestSchema.safeParse({ id, op, args: { ...context, token: 'private' } }).success).toBe(false);
    }
  });
  it('requires a boolean and current revision for app approval settings', () => {
    expect(agentsRequestSchema.safeParse({ id, op: 'approval-settings-get', args: {} }).success).toBe(true);
    for (const autoApprove of [true, false])
      expect(agentsRequestSchema.safeParse({ id, op: 'approval-settings-set', args: { autoApprove, expectedRevision: 0 } }).success).toBe(true);
    for (const args of [{ autoApprove: 'true', expectedRevision: 0 }, { autoApprove: true },
      { autoApprove: true, expectedRevision: -1 }, { autoApprove: true, expectedRevision: true },
      { autoApprove: true, expectedRevision: 0, extra: true }])
      expect(agentsRequestSchema.safeParse({ id, op: 'approval-settings-set', args }).success).toBe(false);
  });
  it('accepts only named spawn presets and revisioned default changes', () => {
    for (const defaultMode of ['read-only', 'workspace-write', 'workspace-auto', 'full-access']) {
      expect(agentsRequestSchema.safeParse({ id, op: 'spawn-settings-set', args: { defaultMode, expectedRevision: 0 } }).success).toBe(true);
      expect(agentsRequestSchema.safeParse({ id, op: 'chat-workflow-start', args: {
        key: crypto.randomUUID(), chatId: crypto.randomUUID(), projectId: crypto.randomUUID(), permissionMode: defaultMode,
        steps: [{ id: 'review', title: 'Review', instruction: 'Review the project', dependsOn: [], permissionMode: 'read-only' }], deliveryStep: 'review',
      } }).success).toBe(true);
    }
    for (const args of [{ defaultMode: 'yolo', expectedRevision: 0 }, { defaultMode: 'full-access' },
      { defaultMode: 'full-access', expectedRevision: -1 }, { defaultMode: 'full-access', expectedRevision: 0, sandbox: 'danger-full-access' }])
      expect(agentsRequestSchema.safeParse({ id, op: 'spawn-settings-set', args }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'spawn-settings-get', args: {} }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-create', args: { key: crypto.randomUUID(), profile: 'work', mode: 'chat', _permissionMode: 'full-access' } }).success).toBe(false);
  });
  it('bounds chat history pages and requires exactly one cursor direction', () => {
    const chatId = crypto.randomUUID();
    const valid = (args: object) => agentsRequestSchema.safeParse({ id, op: 'chat-history', args }).success;
    expect(valid({ chatId, before: 'item-123', limit: 5 })).toBe(true);
    expect(valid({ chatId, after: 'item-123' })).toBe(true);
    for (const args of [{ chatId }, { chatId, before: 'a', after: 'b' }, { chatId, before: '' },
      { chatId, before: 'a', limit: 6 }, { chatId, before: 'a', limit: 0 }, { chatId, after: 'x'.repeat(513) }])
      expect(valid(args)).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-open', args: { chatId, recent: true } }).success).toBe(true);
  });
  it('accepts session history filters for every managed provider and rejects malformed homes', () => {
    const valid = (home: string) => agentsRequestSchema.safeParse({ id, op: 'session-list', args: { home } }).success;
    for (const provider of ['codex', 'opencode', 'claude', 'antigravity']) {
      expect(valid(`${provider}/work`)).toBe(true);
      expect(valid(`${provider}/${'x'.repeat(128)}`)).toBe(true);
    }
    for (const home of ['', '/tmp', 'claude', 'claude/', 'claude/../work', 'claude/../outside',
      'antigravity/work/extra', 'invalid provider/work', `claude/${'x'.repeat(129)}`, 'claude/work\n'])
      expect(valid(home), home).toBe(false);
  });
  it('bounds history readers and requires an identity and retry key for session launches', () => {
    const identity = { provider: 'codex', profile: 'work', id: crypto.randomUUID() };
    expect(agentsRequestSchema.safeParse({ id, op: 'session-transcript', args: identity }).success).toBe(true);
    for (const extra of [{ path: '/secret' }, { before: -1 }, { limit: 41 }, { profile: '../outside' }])
      expect(agentsRequestSchema.safeParse({ id, op: 'session-transcript', args: { ...identity, ...extra } }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'session-list', args: { home: 'codex/work', view: 'archived', limit: 25 } }).success).toBe(true);
    const launch = { ...identity, key: crypto.randomUUID(), expectedAuth: 'company', auth: 'personal' };
    expect(agentsRequestSchema.safeParse({ id, op: 'session-start', args: launch }).success).toBe(true);
    for (const extra of [{ key: undefined }, { expectedAuth: undefined }, { env: {} }, { args: ['resume'] }])
      expect(agentsRequestSchema.safeParse({ id, op: 'session-start', args: { ...launch, ...extra } }).success).toBe(false);
  });
  it('accepts bounded initial prompts only for new terminal sessions', () => {
    const args = { key: crypto.randomUUID(), provider: 'claude', profile: 'work', expectedAuth: null, cwd: '/workspace' };
    const valid = (extra: object) => agentsRequestSchema.safeParse({ id, op: 'session-start', args: { ...args, ...extra } }).success;
    expect(valid({ prompt: 'Review this project\nKeep the terminal interactive' })).toBe(true);
    expect(valid({ prompt: '--help; $(echo text)' })).toBe(true);
    expect(valid({ prompt: 'x'.repeat(12000) })).toBe(true);
    for (const prompt of ['', '   ', 'x'.repeat(12001), 'bad\0prompt', 42])
      expect(valid({ prompt })).toBe(false);
    expect(valid({ prompt: 'Review', id: crypto.randomUUID() })).toBe(false);
  });
  it('bounds login and provider operations without accepting executable commands or environment overrides', () => {
    const key = crypto.randomUUID();
    const valid = (args: object) => agentsRequestSchema.safeParse({ id, op: 'agent-operation-start', args }).success;
    expect(valid({ key, provider: 'codex', kind: 'new-login', auth: 'personal', device: true })).toBe(true);
    expect(valid({ key, provider: 'opencode', kind: 'reauthenticate', auth: 'work' })).toBe(true);
    expect(valid({ key, provider: 'codex', kind: 'update', whenIdle: true })).toBe(true);
    expect(valid({ key, provider: 'opencode', kind: 'install', method: 'npm' })).toBe(true);
    // Manager validates provider membership and method capabilities at execution.
    expect(valid({ key, provider: 'custom-agent', kind: 'new-login', auth: 'work', device: true })).toBe(true);
    for (const args of [
      { key, provider: 'codex', kind: 'new-login' },
      { key, provider: 'codex', kind: 'update', auth: 'work' },
      { key, provider: 'codex', kind: 'update', method: 'npm' },
      { key, provider: 'codex', kind: 'new-login', auth: '../outside' },
      { key, provider: 'codex', kind: 'new-login', auth: 'work', args: ['--token', 'secret'] },
      { key, provider: 'codex', kind: 'update', env: { HOME: '/tmp' } },
      { key, provider: 'codex', kind: 'update', command: 'curl' },
    ]) expect(valid(args)).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'remove-login', args: { provider: 'codex', auth: 'work' } }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'remove-login', args: { provider: 'codex', auth: 'work', confirmed: true } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'switch-auth', args: { provider: 'codex', profile: 'work', auth: null } }).success).toBe(true);
  });
  it('validates bounded discovery jobs and journaled candidate imports', () => {
    const key = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    expect(agentsRequestSchema.safeParse({ id, op: 'project-discovery-start', args: { key, root: '~/projects', mode: 'add', includeNested: false, exclude: ['archived'] } }).success).toBe(true);
    for (const args of [{ key, root: '' }, { key, root: '/tmp', add: true }, { key, root: '/tmp', includeNested: 'true' }, { key, root: '/tmp', exclude: Array(33).fill('ignored') }, { root: '/tmp' }])
      expect(agentsRequestSchema.safeParse({ id, op: 'project-discovery-start', args }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'project-import', args: { key, jobId, selection: [crypto.randomUUID()] } }).success).toBe(true);
    for (const args of [{ key, jobId, path: '/tmp' }, { key, jobId, selection: [] }, { key, jobId, selection: 'everything' }, { key, jobId: 'invalid' }])
      expect(agentsRequestSchema.safeParse({ id, op: 'project-import', args }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'project-discovery-results', args: { jobId, limit: 100, offset: 100 } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'project-discovery-results', args: { jobId, limit: 101 } }).success).toBe(false);
  });
  it('validates saved discovery filters and imports of only filtered candidates', () => {
    const key = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const valid = (args: object) => agentsRequestSchema.safeParse({ id, op: 'project-discovery-filter', args }).success;
    expect(valid({ key, jobId, scope: 'roots', query: 'undercurrent', candidateIds: [crypto.randomUUID()] })).toBe(true);
    expect(valid({ key, jobId })).toBe(true);
    expect(valid({ key, jobId, candidateIds: [] })).toBe(true);
    for (const args of [{ key, jobId, scope: 'important' }, { key, jobId, query: 'x'.repeat(513) },
      { key, jobId, candidateIds: ['invalid'] }, { key, jobId, candidateIds: Array(2001).fill(jobId) },
      { jobId }, { key, jobId, root: '/tmp' }]) expect(valid(args)).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'project-import', args: { key, jobId, selection: 'filtered' } }).success).toBe(true);
  });
  it('requires an exact project UUID and durable retry key for registry removal', () => {
    const args = { key: crypto.randomUUID(), projectId: crypto.randomUUID() };
    const valid = (values: object) => agentsRequestSchema.safeParse({ id, op: 'project-remove', args: values }).success;
    expect(valid(args)).toBe(true);
    for (const values of [{ projectId: args.projectId }, { ...args, projectId: 'Suite' },
      { ...args, projectId: ['/tmp'] }, { ...args, name: 'Suite' }, { ...args, path: '/tmp' },
      { ...args, deleteFiles: true }, { key: args.key }]) expect(valid(values)).toBe(false);
  });
  it('validates steering targets and durable queue mutations', () => {
    const args = { key: crypto.randomUUID(), chatId: crypto.randomUUID() };
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-interrupt', args: { ...args, expectedTurnId: 'active-turn' } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-interrupt', args: { ...args, expectedTurnId: '' } }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-interrupt', args }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-steer', args: { ...args, text: 'context', expectedTurnId: 'active-turn' } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-steer', args: { ...args, text: 'context' } }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-queue', args: { ...args, text: 'next task' } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-queue', args: { ...args, text: ' ', profile: 'other' } }).success).toBe(false);
    for (const op of ['chat-queue-edit', 'chat-queue-remove']) {
      const valid = { ...args, messageId: crypto.randomUUID(), expectedRevision: 1, ...(op === 'chat-queue-edit' ? { text: 'edited' } : {}) };
      expect(agentsRequestSchema.safeParse({ id, op, args: valid }).success).toBe(true);
      expect(agentsRequestSchema.safeParse({ id, op, args: { ...valid, expectedRevision: 0 } }).success).toBe(false);
    }
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-queue-resume', args }).success).toBe(true);
  });
  it('allows read-only workflow discovery and rejects unbounded pages or private runtime arguments', () => {
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-workflow-runs', args: {} }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-workflow-runs', args: { offset: 20, limit: 20 } }).success).toBe(true);
    for (const args of [{ offset: -1 }, { offset: .5 }, { limit: 0 }, { limit: 21 }, { profile: 'other' }])
      expect(agentsRequestSchema.safeParse({ id, op: 'chat-workflow-runs', args }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-workflow-open', args: { workflowId: 'JOB-test' } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-workflow-open', args: { workflowId: 'JOB-test', submission: {} } }).success).toBe(false);
  });
  it('accepts project audit workflows without exposing runtime or mailbox credentials', () => {
    const args = { key: crypto.randomUUID(), chatId: crypto.randomUUID(), projectId: crypto.randomUUID() };
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-workflow-start', args }).success).toBe(true);
    for (const extra of [{ profile: 'other' }, { cwd: '/tmp' }, { _nativeWorkflowKey: 'stage' }, { to: 'agent' }, { credentials: '/secret' }, { workflow: {} }])
      expect(agentsRequestSchema.safeParse({ id, op: 'chat-workflow-start', args: { ...args, ...extra } }).success).toBe(false);
    for (const op of ['chat-workflow-status', 'chat-workflow-cancel', 'chat-workflow-resume'])
      expect(agentsRequestSchema.safeParse({ id, op, args: { chatId: args.chatId, workflowId: 'JOB-test' } }).success).toBe(true);
  });
  it('requires a conversation identity and retry key for deletion', () => {
    const args = { key: crypto.randomUUID(), chatId: crypto.randomUUID() };
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-delete', args }).success).toBe(true);
    for (const invalid of [{ chatId: args.chatId }, { ...args, chatId: 'invalid' }, { ...args, extra: true }])
      expect(agentsRequestSchema.safeParse({ id, op: 'chat-delete', args: invalid }).success).toBe(false);
  });
  it('keeps retained-work controls independent of visible conversation identities', () => {
    const args = { key: crypto.randomUUID(), activityId: 'chat:' + crypto.randomUUID() };
    expect(agentsRequestSchema.safeParse({ id, op: 'connect-activity-stop', args }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'connect-activity-check', args: { activityId: args.activityId } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'workflow-run-action', args: { workflowId: 'JOB-retained', action: 'cancel' } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'connect-activity-stop', args: { ...args, activityId: 'arbitrary' } }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'connect-activity-stop', args: { ...args, _allowDeleted: true } }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-send', args: { key: args.key, chatId: crypto.randomUUID(), text: 'x', _nativeWorkflowKey: 'JOB-retained:step' } }).success).toBe(false);
  });
  it('validates deletion previews and requires a scope with its confirmation token', () => {
    const chatId = crypto.randomUUID();
    const args = { key: crypto.randomUUID(), chatId, scope: 'subtree', previewToken: 'a'.repeat(64) };
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-delete-preview', args: { chatId } }).success).toBe(true);
    for (const scope of ['conversation', 'subtree'])
      expect(agentsRequestSchema.safeParse({ id, op: 'chat-delete', args: { ...args, scope } }).success).toBe(true);
    for (const invalid of [{ ...args, scope: 'all' }, { ...args, previewToken: 'invalid' },
      { ...args, previewToken: undefined }, { ...args, scope: undefined }])
      expect(agentsRequestSchema.safeParse({ id, op: 'chat-delete', args: invalid }).success).toBe(false);
    for (const invalid of [{}, { chatId: 'invalid' }, { chatId, scope: 'subtree' }])
      expect(agentsRequestSchema.safeParse({ id, op: 'chat-delete-preview', args: invalid }).success).toBe(false);
  });
  it('accepts canvas-authored native chat joins and rejects malformed plans or runtime overrides', () => {
    const args = { key: crypto.randomUUID(), chatId: crypto.randomUUID(), projectId: crypto.randomUUID(),
      steps: [
        { id: 'architecture', title: 'Architecture', instruction: 'Audit architecture', dependsOn: [] },
        { id: 'security', title: 'Security', instruction: 'Audit security', dependsOn: [] },
        { id: 'tasks', title: 'Tasks', instruction: 'Merge the reports', dependsOn: ['architecture', 'security'] },
      ], deliveryStep: 'tasks' };
    const valid = (extra: object) => agentsRequestSchema.safeParse({ id, op: 'chat-workflow-start', args: { ...args, ...extra } }).success;
    expect(valid({})).toBe(true);
    for (const extra of [{ deliveryStep: 'missing' }, { deliveryStep: undefined }, { steps: undefined }, { steps: [] },
      { profile: 'other' }, { credentials: '/secret' }, { architectureInstruction: 'Ambiguous legacy request' },
      { steps: [args.steps[0], args.steps[0]] },
      { steps: [{ ...args.steps[0], dependsOn: ['tasks'] }, ...args.steps.slice(1)] },
      { steps: [...args.steps.slice(0, 2), { ...args.steps[2], dependsOn: ['missing'] }] },
      { steps: [...args.steps.slice(0, 2), { ...args.steps[2], dependsOn: ['architecture', 'architecture'] }] },
      { steps: args.steps.map((step) => ({ ...step, cwd: '/private' })) }]) expect(valid(extra)).toBe(false);
  });
  it('resolves MCP reconnects from chat identities and rejects native runtime overrides', () => {
    const args = { chatId: crypto.randomUUID() };
    expect(agentsRequestSchema.safeParse({ id, op: 'mcp-chat-reconnect', args }).success).toBe(true);
    for (const invalid of [{}, { chatId: 'invalid' }, { ...args, threadId: 'thread' },
      { ...args, provider: 'opencode' }, { ...args, config: {} }, { ...args, servers: ['lore'] }])
      expect(agentsRequestSchema.safeParse({ id, op: 'mcp-chat-reconnect', args: invalid }).success).toBe(false);
  });
  it('validates MCP selections, profile revisions, and registered preparation projects', () => {
    const projectId = crypto.randomUUID();
    expect(agentsRequestSchema.safeParse({ id, op: 'mcp-profile-set', args: {
      provider: 'codex', profile: 'work', servers: ['sonar'], expectedRevision: `sha256:${'a'.repeat(64)}`,
    } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'mcp-profile-set', args: {
      provider: 'codex', profile: 'work', servers: ['sonar'],
    } }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'mcp-prepare', args: {
      key: crypto.randomUUID(), projectId, tools: ['sonar', 'lore'],
    } }).success).toBe(true);
    for (const extra of [{ cwd: '/tmp' }, { command: 'exec' }, { env: {} }])
      expect(agentsRequestSchema.safeParse({ id, op: 'mcp-prepare', args: {
        key: crypto.randomUUID(), projectId, tools: ['sonar'], ...extra,
      } }).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'launch', args: {
      cwd: '/tmp', provider: 'codex', profile: 'work',
      mcp: { inherit: false, add: ['sonar'] },
    } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'launch', args: {
      cwd: '/tmp', provider: 'codex', profile: 'work',
      mcp: { add: ['sonar'], exclude: ['sonar'] },
    } }).success).toBe(false);
  });
  it('accepts catalog identities and requires revision checks for prompt mutations', () => {
    const packId = 'a'.repeat(64),
      expectedDigest = `sha256:${'b'.repeat(64)}`;
    expect(
      agentsRequestSchema.safeParse({ id, op: 'prompts-catalog', args: {} })
        .success,
    ).toBe(true);
    const save = {
      packId,
      file: 'sections/review.md',
      text: 'Review carefully.',
      expectedDigest,
    };
    expect(
      agentsRequestSchema.safeParse({ id, op: 'prompts-save', args: save })
        .success,
    ).toBe(true);
    for (const extra of [
      { path: '/private/other' },
      { home: '/tmp' },
      { env: {} },
    ])
      expect(
        agentsRequestSchema.safeParse({
          id,
          op: 'prompts-save',
          args: { ...save, ...extra },
        }).success,
      ).toBe(false);
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'prompts-save',
        args: { ...save, expectedDigest: undefined },
      }).success,
    ).toBe(false);
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'prompts-bind',
        args: {
          consumerId: 'agent-manager-local',
          profile: 'review',
          packId,
          prompt: 'review',
          inputs: {},
          expectedBindingDigest: null,
        },
      }).success,
    ).toBe(true);
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'prompts-snapshot',
        args: { consumerId: 'agent-manager-local', launchId: '../escape' },
      }).success,
    ).toBe(false);
  });
  it('resolves terminal targets from chat IDs and rejects browser-selected launch settings', () => {
    const chatId = crypto.randomUUID(),
      key = crypto.randomUUID();
    for (const op of ['chat-terminal-open', 'chat-terminal-release']) {
      expect(
        agentsRequestSchema.safeParse({ id, op, args: { chatId, key } })
          .success,
      ).toBe(true);
      expect(
        agentsRequestSchema.safeParse({ id, op, args: { chatId } }).success,
      ).toBe(false);
      for (const extra of [
        { threadId: crypto.randomUUID() },
        { cwd: '/tmp' },
        { app_server_run_id: 'run' },
        { env: {} },
        { args: [] },
      ])
        expect(
          agentsRequestSchema.safeParse({
            id,
            op,
            args: { chatId, key, ...extra },
          }).success,
        ).toBe(false);
    }
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'chat-terminal-status',
        args: { chatId },
      }).success,
    ).toBe(true);
  });
  it('accepts a model override for new chats and rejects invalid model values', () => {
    const args = {
      key: crypto.randomUUID(),
      profile: 'work',
      mode: 'chat',
      cwd: '/tmp',
    };
    for (const profile of ['work', null])
      expect(
        agentsRequestSchema.safeParse({
          id,
          op: 'chat-create',
          args: { ...args, profile, model: 'fixture-model' },
        }).success,
      ).toBe(true);
    for (const model of ['', ' ', 'x'.repeat(257), null, 123])
      expect(
        agentsRequestSchema.safeParse({
          id,
          op: 'chat-create',
          args: { ...args, model },
        }).success,
      ).toBe(false);
  });
  it('accepts projects with only a name and local path', () => {
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'project-create',
        args: { name: 'My project', path: '/tmp/project' },
      }).success,
    ).toBe(true);
    for (const args of [
      { name: ' ', path: '/tmp' },
      { name: 'Project', path: '' },
      { name: 'Project', path: '/tmp', command: 'exec' },
      { name: 'Project', path: '/tmp', env: {} },
    ])
      expect(
        agentsRequestSchema.safeParse({ id, op: 'project-create', args })
          .success,
      ).toBe(false);
  });
  it('bounds chat input and exposes only the supported chat operations', () => {
    const chatId = crypto.randomUUID();
    const key = crypto.randomUUID();
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'chat-launches',
        args: { chatId },
      }).success,
    ).toBe(true);
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'chat-detach',
        args: { chatId, key },
      }).success,
    ).toBe(true);
    for (const extra of [
      { _accessMode: 'danger-full-access' },
      { _originChatId: chatId },
      { _parentChatId: chatId },
      { _launchId: key },
      { _returnResult: true },
      { dynamicTools: [] },
    ])
      expect(
        agentsRequestSchema.safeParse({
          id,
          op: 'chat-create',
          args: { key, profile: 'work', mode: 'chat', ...extra },
        }).success,
      ).toBe(false);
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'chat-detach',
        args: { chatId, key, parentChatId: chatId },
      }).success,
    ).toBe(false);
    expect(
      agentsRequestSchema.safeParse({ id, op: 'chat-detach', args: { chatId } })
        .success,
    ).toBe(false);
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'chat-send',
        args: { chatId, key, text: 'hello' },
      }).success,
    ).toBe(true);
    for (const args of [
      { chatId, key, text: ' ' },
      { chatId, key, text: 'x'.repeat(32001) },
      { chatId, key, text: 'hello', method: 'command/exec' },
    ])
      expect(
        agentsRequestSchema.safeParse({ id, op: 'chat-send', args }).success,
      ).toBe(false);
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'chat-create',
        args: { key, profile: 'work', mode: 'work', cwd: '/tmp', env: {} },
      }).success,
    ).toBe(false);
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'chat-answer',
        args: {
          key,
          chatId,
          requestId: 'a'.repeat(32),
          decision: 'approveEverything',
        },
      }).success,
    ).toBe(false);
  });
  it('accepts stable native session references and captured environment identities', () => {
    const args = { provider: 'codex', profile: 'work', id: 'a'.repeat(64) };
    expect(agentsRequestSchema.safeParse({ id, op: 'session-transcript', args }).success).toBe(true);
    const launch = { ...args, key: id, expectedAuth: null, environmentId: id, profileId: id,
      expectedEnvironmentRevision: 'sha256:revision' };
    expect(agentsRequestSchema.safeParse({ id, op: 'session-start', args: launch }).success).toBe(true);
    for (const extra of [{ id: '../history' }, { environmentId: '/tmp/home' }, { profileId: 'work' }])
      expect(agentsRequestSchema.safeParse({ id, op: 'session-start', args: { ...launch, ...extra } }).success).toBe(false);
  });
  it('accepts provider-scoped chat model discovery', () => {
    expect(agentsRequestSchema.safeParse({
      id, op: 'chat-connect',
      args: { provider: 'opencode', profile: 'work', cwd: '/tmp/project' },
    }).success).toBe(true);
  });
  it('accepts explicit and automatic managed launches', () => {
    for (const profile of ['work', null]) {
      expect(
        agentsRequestSchema.safeParse({
          id,
          op: 'launch',
          args: { provider: 'codex', profile, cwd: '/tmp/project' },
        }).success,
      ).toBe(true);
      expect(
        agentsRequestSchema.safeParse({
          id,
          op: 'chat-connect',
          args: { profile },
        }).success,
      ).toBe(true);
      expect(
        agentsRequestSchema.safeParse({
          id,
          op: 'chat-create',
          args: { key: crypto.randomUUID(), profile, mode: 'chat' },
        }).success,
      ).toBe(true);
    }
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'chat-create',
        args: { key: crypto.randomUUID(), profile: '../escape', mode: 'chat' },
      }).success,
    ).toBe(false);
  });
  it('keeps launch environments, commands and SDK configuration private', () => {
    for (const extra of [
      { env: { TOKEN: 'secret' } },
      { args: ['--unsafe'] },
      { root: '/tmp/other' },
      { config: '/tmp/other' },
    ])
      expect(
        agentsRequestSchema.safeParse({
          id,
          op: 'launch',
          args: { provider: 'codex', profile: 'work', cwd: '/tmp', ...extra },
        }).success,
      ).toBe(false);
    for (const provider of ['OpenAI', 'unknown'])
      expect(
        agentsRequestSchema.safeParse({ id, op: 'catalog', args: { provider } })
          .success,
      ).toBe(false);
  });
  it('validates profile names and rejects arbitrary operations', () => {
    expect(
      agentsRequestSchema.safeParse({
        id,
        op: 'create-profile',
        args: { provider: 'codex', profile: '../escape' },
      }).success,
    ).toBe(false);
    expect(
      agentsRequestSchema.safeParse({ id, op: 'exec', args: {} }).success,
    ).toBe(false);
  });
  it('requires explicit confirmation and a managed identity for profile deletion', () => {
    const args = { provider: 'codex', profile: 'review', confirmed: true };
    expect(agentsRequestSchema.safeParse({ id, op: 'delete-profile', args }).success).toBe(true);
    for (const invalid of [
      { provider: 'codex', profile: 'review' },
      { ...args, confirmed: false },
      { ...args, profile: '../escape' },
      { ...args, root: '/tmp/other' },
      { ...args, force: true },
    ])
      expect(agentsRequestSchema.safeParse({ id, op: 'delete-profile', args: invalid }).success).toBe(false);
  });
});

describe('Agent context', () => {
  it('accepts bounded string maps and explicit detail reads', () => {
    const id = crypto.randomUUID(), chatId = crypto.randomUUID();
    expect(agentContextSchema.safeParse({ labels: { app: 'pathspec' }, metadata: { inputs: '["a","b"]' } }).success).toBe(true);
    expect(agentContextSchema.safeParse({ metadata: { text: 'é'.repeat(2048) } }).success).toBe(true);
    for (const value of [{ labels: { app: 'é'.repeat(129) } }, { metadata: { text: 'é'.repeat(2049) } },
      { metadata: { nested: {} } }, { labels: { 'agent_manager.profile': 'override' } },
      { metadata: { private: 'secret\nvalue' } }, { labels: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), 'v'])) }])
      expect(agentContextSchema.safeParse(value).success).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-metadata', args: { chatId } }).success).toBe(true);
    expect(agentsRequestSchema.safeParse({ id, op: 'sessions', args: { labels: { 'agent_manager.profile': 'work' } } }).success).toBe(true);
  });
});


describe('indexed chat search', () => {
  const id = crypto.randomUUID();
  const chatId = crypto.randomUUID();
  it('accepts bounded searches and rejects excessive query and page sizes', () => {
    const valid = (args: object) => agentsRequestSchema.safeParse({ id, op: 'chat-search', args }).success;
    expect(valid({ query: 'migration', project: 'Suite', includeTools: true, cursor: '25', limit: 25 })).toBe(true);
    expect(valid({ query: 'x'.repeat(257) })).toBe(false);
    expect(valid({ query: 'x', limit: 51 })).toBe(false);
    expect(valid({ query: 'x', cursor: '-1' })).toBe(false);
  });
  it('accepts direct match navigation and requires exactly one history boundary', () => {
    const valid = (args: object) => agentsRequestSchema.safeParse({ id, op: 'chat-history', args: { chatId, ...args } }).success;
    expect(valid({ around: 'old-message' })).toBe(true);
    expect(valid({ before: 'old-message', indexed: true })).toBe(true);
    expect(valid({ around: 'old-message', after: 'other' })).toBe(false);
    expect(valid({})).toBe(false);
    expect(agentsRequestSchema.safeParse({ id, op: 'chat-open', args: { chatId, around: 'old-message' } }).success).toBe(true);
  });
});

it('validates Codex server settings modes and revisions', () => {
  expect(agentsRequestSchema.safeParse({ id: crypto.randomUUID(), op: 'codex-server-settings-get', args: {} }).success).toBe(true);
  for (const mode of ['separate', 'shared']) {
    expect(agentsRequestSchema.safeParse({ id: crypto.randomUUID(), op: 'codex-server-settings-set', args: { mode, expectedRevision: 0 } }).success).toBe(true);
  }
  for (const args of [{ mode: 'unknown', expectedRevision: 0 }, { mode: 'shared', expectedRevision: -1 }, { mode: 'shared' }]) {
    expect(agentsRequestSchema.safeParse({ id: crypto.randomUUID(), op: 'codex-server-settings-set', args }).success).toBe(false);
  }
});
