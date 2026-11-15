import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AgentsService } from './agents.service.js';
import { AuthStore } from '../auth/store.js';

describe('Agent bridge startup', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('handles monitor inbox observations through private IPC without broadcasting payloads', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'suite-command-source-'));
    const fixture = resolve(root, 'source.py');
    writeFileSync(fixture, `import json, sys
print(json.dumps({'type':'ready'}), flush=True)
request = json.loads(sys.stdin.readline())
print(json.dumps({'type':'command-source-request','id':'source','operation':'carrier-observations','args':{'mailbox':'user'}}), flush=True)
response = json.loads(sys.stdin.readline())
print(json.dumps({'type':'result','id':request['id'],'result':response['args']}), flush=True)
for line in sys.stdin: pass
`);
    vi.stubEnv('AGENTS_BRIDGE_PATH', fixture);
    const service = new AgentsService();
    const messages: unknown[] = [];
    const unsubscribe = service.subscribe(message => messages.push(message));
    const source = vi.fn(async () => ({ messages: [{ content: 'private report' }], cursor: 1, instance: 'fixture' }));
    service.setCommandSource(source);
    try {
      const result = await service.request({ id: crypto.randomUUID(), op: 'command-list', args: {} });
      expect(result).toMatchObject({ type: 'result', result: { id: 'source', result: { cursor: 1 } } });
      expect(source).toHaveBeenCalledWith('carrier-observations', { mailbox: 'user' });
      expect(messages).toEqual([]);
    } finally {
      unsubscribe();
      await service.onApplicationShutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads the local Connect package before initializing chats', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'suite-bridge-startup-'));
    const config = resolve(root, 'providers.toml');
    writeFileSync(config, ['codex', 'opencode'].map(provider =>
      `[providers.${provider}]\nexecutable="true"\nnative_home=${JSON.stringify(resolve(root, provider))}\n`,
    ).join('\n'));
    for (const [key, value] of Object.entries({
      AGENT_MANAGER_CONFIG: config,
      AGENT_MANAGER_HOME: resolve(root, 'agents'),
      AIXAND_AUTH_DATABASE: resolve(root, 'auth/auth.db'),
      AGENTS_STATE_DIR: resolve(root, 'state'),
      AGENTS_SCRATCH_DIR: resolve(root, 'scratch'),
      AGENTS_CWD: root,
      UNDERCURRENT_HOME: resolve(root, 'runtime'),
      SKILL_MANAGER_HOME: resolve(root, 'skills'),
      PROMPT_MANAGER_HOME: resolve(root, 'prompts'),
      MCP_MANAGER_HOME: resolve(root, 'mcps'),
      SERVER_MANAGER_HOME: resolve(root, 'servers'),
      SKILLS_SOURCE_PATHS: '',
      PROMPTS_PACK_PATHS: '',
      SUITE_CHAT_PROVIDERS: '',
      SUITE_WORKFLOW_SOCKET: '',
      CARRIER_DATABASE: '',
    })) vi.stubEnv(key, value);
    vi.stubEnv('AGENTS_BRIDGE_PATH', resolve('agent-bridge/main.py'));
    vi.stubEnv('AIXAND_CONNECT_SOURCE', undefined);
    const auth = new AuthStore(resolve(root, 'auth/auth.db'), { initialize: true });
    auth.beginOnboarding();
    const { revision, ...progress } = auth.onboarding()!;
    auth.saveOnboarding({ ...progress, step: 'done', status: 'complete', selected: ['codex'],
      drafts: { codex: { auth: 'personal', loginName: 'personal', profileName: 'work', nativeProfile: null,
        operationId: null, done: true, deferred: false } } }, revision);
    const credential = auth.credential();
    const service = new AgentsService();
    try {
      await service.ready();
      await expect(service.request({ id: crypto.randomUUID(), op: 'chat-list', args: {} }))
        .resolves.toMatchObject({ type: 'result', result: [] });
      await expect(service.request({ id: crypto.randomUUID(), op: 'project-create', args: { name: 'Reset fixture', path: root } }))
        .resolves.toMatchObject({ type: 'result', result: { name: 'Reset fixture' } });
      const events: unknown[] = [];
      const unsubscribe = service.subscribe(message => events.push(message));
      const key = crypto.randomUUID();
      const savedOnboarding = auth.onboarding();
      await expect(service.request({ id: crypto.randomUUID(), op: 'workspace-reset', args: { key, scope: 'everything', confirmation: 'RESET EVERYTHING' } }))
        .resolves.toMatchObject({ type: 'error', code: 'unsupported' });
      expect(events).not.toContainEqual({ type: 'workspace-reset', key, scope: 'everything' });
      expect(auth.onboarding()).toEqual(savedOnboarding);
      expect(auth.credential()).toEqual(credential);
      unsubscribe();
      await expect(service.request({ id: crypto.randomUUID(), op: 'project-list', args: {} }))
        .resolves.toMatchObject({ type: 'result', result: [{ name: 'Reset fixture' }] });
    } finally {
      await service.onApplicationShutdown();
      auth.close();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('identifies a missing module from split stderr without exposing traceback content', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'suite-bridge-missing-module-'));
    const fixture = resolve(root, 'missing.py');
    writeFileSync(fixture, `import sys, time
sys.stderr.write('Traceback: /private/credentials/private-value\\n' + 'x' * 10000 + '\\nModuleNotFound')
sys.stderr.flush()
time.sleep(.02)
sys.stderr.write("Error: No module named 'resource_sources'\\n")
sys.stderr.flush()
sys.exit(1)
`);
    vi.stubEnv('AGENTS_BRIDGE_PATH', fixture);
    const service = new AgentsService();
    try {
      const result = await service.request({ id: crypto.randomUUID(), op: 'chat-list', args: {} });
      expect(result).toMatchObject({ type: 'error', code: 'unavailable', message: expect.stringContaining('"resource_sources"') });
      expect(result.message).toContain('"aixand-resource-sources"');
      expect(result.message).toContain('AGENTS_PYTHON');
      expect(result.message).not.toMatch(/private|Traceback|xxxxx/);
    } finally {
      await service.onApplicationShutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a missing module after ready without replaying a pending mutation', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'suite-bridge-disconnect-'));
    const fixture = resolve(root, 'disconnect.py');
    const requests = resolve(root, 'requests.jsonl');
    writeFileSync(fixture, `import sys
print('{"type":"ready"}', flush=True)
request = sys.stdin.readline()
with open(${JSON.stringify(requests)}, 'a') as output:
    output.write(request)
sys.stderr.write("ModuleNotFoundError: No module named 'mcp_manager'\\n")
sys.exit(1)
`);
    vi.stubEnv('AGENTS_BRIDGE_PATH', fixture);
    const service = new AgentsService();
    try {
      await service.ready();
      const command = { id: crypto.randomUUID(), op: 'create-profile' as const, args: { provider: 'codex' as const, profile: 'work' } };
      const result = await service.request(command);
      expect(result).toMatchObject({ type: 'error', code: 'bridge_lost', message: expect.stringContaining('"aixand-mcp-manager"') });
      expect(result.message).toContain('Pending mutations were not retried');
      const sent = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ op: command.op, args: command.args });
    } finally {
      await service.onApplicationShutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
