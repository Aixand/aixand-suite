import { agentsRequestSchema } from './protocol.js';

describe('Manager Suites public operations', () => {
  const id = crypto.randomUUID();
  const revision = 'sha256:' + 'a'.repeat(64);
  const valid = (op: string, args: object) => agentsRequestSchema.safeParse({ id, op, args }).success;
  it('scopes background inspection and process controls to exact conversations', () => {
    expect(valid('chat-background', { chatId: id })).toBe(true);
    expect(valid('chat-background-agent', { chatId: id, agentId: 'native-child' })).toBe(true);
    expect(valid('chat-background-process', { chatId: id, processId: '42' })).toBe(true);
    expect(valid('chat-background-stop', { key: id, chatId: id, processId: '42' })).toBe(true);
    expect(valid('chat-background-stop', { chatId: id, processId: '42' })).toBe(false);
    expect(valid('chat-background-stop', { key: id, chatId: id, processId: '' })).toBe(false);
    expect(valid('chat-background-agent', { chatId: id, agentId: 'x'.repeat(257) })).toBe(false);
  });
  it('repairs terminal commands independently of accounts and validates command preference', () => {
    const args = { key: id, provider: 'copilot', kind: 'setup-command', whenIdle: true };
    for (const terminalPolicy of ['keep', 'prefer'])
      expect(valid('agent-operation-start', { ...args, terminalPolicy })).toBe(true);
    expect(valid('agent-operation-start', { ...args, terminalPolicy: 'overwrite' })).toBe(false);
    expect(valid('agent-operation-start', { ...args, auth: 'company' })).toBe(false);
    expect(valid('agent-operation-start', { ...args, kind: 'new-login', auth: 'company', terminalPolicy: 'prefer' })).toBe(false);
  });
  it('inspects creation by its original request key even without a conversation', () => {
    expect(valid('chat-create-status', { key: id })).toBe(true);
    expect(valid('chat-create-status', {})).toBe(false);
    expect(valid('chat-create-status', { chatId: id })).toBe(false);
  });
  it('requires revision guards and immutable source/release identities', () => {
    const binding = { provider: 'codex', profile: 'work', skills: [{ store: '/tmp/fixture', reference: 'local/audit@1' }], expectedRevision: null };
    expect(valid('skills-profile-set', binding)).toBe(true);
    expect(valid('skills-profile-set', { ...binding, skills: [{ store: '/tmp/fixture', reference: 'audit' }] })).toBe(false);
    const { expectedRevision: _revision, ...unguarded } = binding;
    expect(valid('skills-profile-set', unguarded)).toBe(false);
    expect(valid('skills-save', { entryId: revision, file: 'refs/bytes.bin', content_b64: 'AP8=', executable: true, expectedDigest: revision })).toBe(true);
    expect(valid('skills-save', { entryId: revision, file: 'SKILL.md', content_b64: 'not base64!', expectedDigest: revision })).toBe(false);
  });
  it('keeps original chat envelopes and accepts explicit backend choices', () => {
    const args = { key: id, profile: 'work', mode: 'chat' };
    expect(valid('chat-create', args)).toBe(true);
    expect(valid('chat-create', { ...args, backend: 'codex-acp' })).toBe(true);
    expect(valid('chat-create', { ...args, provider: 'claude', backend: 'claude-sdk' })).toBe(true);
    expect(valid('chat-create', { ...args, provider: 'antigravity', backend: 'antigravity-sdk' })).toBe(true);
    expect(valid('chat-create', { ...args, provider: 'copilot', backend: 'copilot-sdk', model: 'advertised-model' })).toBe(true);
    expect(valid('chat-create', { ...args, provider: 'claude', backend: 'copilot-sdk' })).toBe(false);
    expect(valid('chat-create', { ...args, backend: 'native-codex', permissionMode: 'full-access' })).toBe(true);
    for (const extra of [{ backend: 'invented' }, { argv: ['sh'] }, { env: { TOKEN: 'raw-secret' } }, { connectionRef: {} }])
      expect(valid('chat-create', { ...args, ...extra })).toBe(false);
    expect(valid('chat-answer', { key: id, chatId: id, requestId: 'a'.repeat(32), response: { outcome: 'selected', option_id: 'allow:once' } })).toBe(true);
    expect(valid('chat-answer', { key: id, chatId: id, requestId: 'a'.repeat(32), response: { outcome: 'cancelled' } })).toBe(true);
  });
  it('accepts explicit SDK credentials and bounded saved-session recovery', () => {
    expect(valid('sdk-credential-save', { provider: 'claude', name: 'billing', apiKey: 'fixture-key', method: 'api-key' })).toBe(true);
    expect(valid('sdk-credential-save', { provider: 'codex', name: 'billing', apiKey: 'fixture-key' })).toBe(false);
    expect(valid('sdk-credential-assign', { provider: 'antigravity', profile: 'work', name: 'billing', expectedRevision: revision })).toBe(true);
    expect(valid('chat-backend-resume', { key: id, chatId: id })).toBe(true);
    expect(valid('chat-backend-history', { chatId: id, cursor: 0, limit: 100 })).toBe(true);
    expect(valid('chat-backend-history', { chatId: id, cursor: -1 })).toBe(false);
  });
  it('requires guarded application mappings and bounds reconnect scope', () => {
    const args = { applicationId: 'suite', logicalPrompt: 'review', target: { kind: 'release', reference: 'recipe@1/review' }, expectedRevision: revision };
    expect(valid('prompts-application-set', args)).toBe(true);
    expect(valid('prompts-application-set', { ...args, expectedRevision: null })).toBe(false);
    expect(valid('prompts-application-set', { ...args, target: { kind: 'draft', source_id: 'exact', pack_path: '/tmp/recipe', prompt: 'review' } })).toBe(true);
    expect(valid('mcp-chat-reconnect', { chatId: id, scope: 'session', operationId: 'stable-intent', expectedSelectionDigest: revision })).toBe(true);
    expect(valid('mcp-chat-reconnect', { chatId: id, scope: 'all' })).toBe(false);
  });
  it('validates owned identities, state guards, bounded chunks and managed targets', () => {
    const identity = { publisherId: 'pathspec', resourceId: 'default', storeId: revision };
    expect(valid('prompts-managed-show', identity)).toBe(true);
    expect(valid('prompts-managed-apply', { ...identity, expectedRevision: revision, resolutions: { '/files/body.md': { take: 'publisher' } } })).toBe(true);
    expect(valid('prompts-managed-apply', identity)).toBe(false);
    expect(valid('skills-managed-upload-chunk', { ...identity, uploadId: 'a'.repeat(32), offset: 0, content_b64: 'AP8=' })).toBe(true);
    expect(valid('skills-managed-upload-chunk', { ...identity, uploadId: 'a'.repeat(32), offset: -1, content_b64: 'AP8=' })).toBe(false);
    expect(valid('skills-managed-upload-chunk', { ...identity, uploadId: 'a'.repeat(32), offset: 0, content_b64: 'AAAA'.repeat(12001) })).toBe(false);
    expect(valid('prompts-managed-ensure', { ...identity, publisherId: '../escape', path: '/tmp/pack' })).toBe(false);
    expect(valid('prompts-application-set', { applicationId: 'pathspec', logicalPrompt: 'review', expectedRevision: revision,
      target: { kind: 'managed', publisher_id: 'pathspec', package_id: 'default', prompt: 'review' } })).toBe(true);
  });
});
