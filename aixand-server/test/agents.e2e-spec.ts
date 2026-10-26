import { authFixture, fixtureCookie } from './auth-fixture.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createConnection, type AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, delimiter } from 'node:path';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';

const token = 'test-agent-workspace-key-at-least-32-characters';
const origin = 'http://localhost:5186';
describe('Agents SDK gateway', () => {
  let app: INestApplication;
  let url: string;
  let work: string;
  let cookie: string;
  let fixtureAuth: Awaited<ReturnType<typeof authFixture>>;
  const sockets: WebSocket[] = [];
  beforeEach(async (context) => {
    fixtureAuth = await authFixture();
    work = mkdtempSync(resolve(tmpdir(), 'aixand-agents-api-'));
    const preparedPython = resolve('../aixand-ir/.venv/bin/python');
    const python = process.env.AIXAND_TEST_AGENTS_PYTHON ?? (existsSync(preparedPython) ? preparedPython : 'python3');
    cpSync(resolve('../../manager-suites/prompt-manager/packs'), resolve(work, 'prompt-packs'), { recursive: true });
    vi.stubEnv(
      'PYTHONPATH',
      [
        resolve('../../manager-suites/agent-manager'),
        resolve('../../undercurrent/python/src'),
        resolve('../../manager-suites/mcp-manager/src'),
      ].join(delimiter),
    );
    const fixture = JSON.parse(
      execFileSync(python, ['agent-bridge/tests/fixture.py', work], {
        encoding: 'utf8',
      }),
    ) as { config: string; home: string };
    for (const [key, value] of Object.entries({
      CORS_ORIGINS: origin,
      AGENTS_PYTHON: context.task.name === 'reports an unavailable interpreter after authentication'
        ? '/nonexistent/aixand-python'
        : python,
      AGENT_MANAGER_HOME: fixture.home,
      AGENT_MANAGER_CONFIG: fixture.config,
      PROMPT_MANAGER_HOME: resolve(work, 'prompts'),
      SKILL_MANAGER_HOME: resolve(work, 'skills'),
      SKILLS_SOURCE_PATHS: '',
      PROMPTS_PACK_PATHS: resolve(work, 'prompt-packs'),
      AGENTS_CWD: work,
      AGENTS_STATE_DIR: resolve(work, 'chat-state'),
      SUITE_WORKFLOW_SOCKET: resolve(work, 'native-workflows.sock'),
      WORKFLOW_RUNNER_HOME: resolve(work, 'runner'),
      UNDERCURRENT_HOME: resolve(work, 'undercurrent'),
      UNDERCURRENT_PYTHON_BRIDGE: resolve(
        '../../undercurrent/target/debug/uc-python-bridge',
      ),
    }))
      vi.stubEnv(key, value);
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    cookie = fixtureCookie(app);
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/agents/ws`;
  });
  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    await app.close();
    fixtureAuth.cleanup();
    vi.unstubAllEnvs();
    rmSync(work, { recursive: true, force: true });
  });
  async function connect(key = token, browserOrigin = origin) {
    const socket = new WebSocket(url, { origin: browserOrigin, headers: key === token ? { Cookie: cookie } : {} });
    sockets.push(socket);
    const messages: Record<string, unknown>[] = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((done, reject) => {
      socket.once('open', () => {
        done();
      });
      socket.once('error', reject);
    });
    return { socket, messages };
  }
  async function ready() {
    const connection = await connect();
    await vi.waitFor(() =>
      expect(
        connection.messages.some((message) => message.type === 'ready'),
      ).toBe(true),
    );
    return connection;
  }
  async function request(
    connection: Awaited<ReturnType<typeof connect>>,
    op: string,
    args = {},
    id = crypto.randomUUID(),
  ) {
    connection.socket.send(JSON.stringify({ id, op, args }));
    await vi.waitFor(() =>
      expect(connection.messages.some((message) => message.id === id)).toBe(
        true,
      ),
    );
    return connection.messages.find((message) => message.id === id)!;
  }
  it('rejects invalid keys, origins and unauthenticated operations', async () => {
    for (const [key, browserOrigin] of [
      ['x'.repeat(40), origin],
      [token, 'https://untrusted.example'],
    ]) {
      const { socket } = await connect(key, browserOrigin);
      const code = await new Promise<number>((done) =>
        socket.once('close', done),
      );
      expect(code).toBe(1008);
    }
  });
  it('browses registered local project files through the authenticated gateway', async () => {
    const connection = await ready();
    const directory = resolve(work, 'project');
    mkdirSync(resolve(directory, 'src'), { recursive: true });
    writeFileSync(resolve(directory, 'src', 'hello.py'), 'print("Hello from this machine")\n');
    writeFileSync(resolve(directory, '.hidden'), 'test fixture');
    symlinkSync(work, resolve(directory, 'outside'), 'dir');
    const created = await request(connection, 'project-create', { name: 'Local files', path: directory });
    expect(created.type).toBe('result');
    const projectId = (created.result as { id: string }).id;
    const listing = await request(connection, 'project-files-list', { projectId });
    expect(listing.type).toBe('result');
    expect((listing.result as { entries: { name: string }[] }).entries.map((entry) => entry.name)).toEqual(['src', 'outside']);
    const preview = await request(connection, 'project-file-read', { projectId, path: 'src/hello.py' });
    expect(preview.result).toMatchObject({ projectId, path: 'src/hello.py', kind: 'text', content: 'print("Hello from this machine")\n' });
    const blocked = await request(connection, 'project-file-read', { projectId, path: 'outside/config.json' });
    expect(blocked.type).toBe('error');
    expect(String(blocked.message)).toContain('Linked paths');
    expect((await request(connection, 'project-files-list', { projectId: crypto.randomUUID() })).type).toBe('error');
  });
  it('persists app approval settings and broadcasts them to authenticated browsers', async () => {
    const first = await ready();
    const second = await ready();
    expect((await request(first, 'approval-settings-get')).result).toEqual({ autoApprove: false, revision: 0 });
    expect((await request(first, 'approval-settings-set', { autoApprove: true, expectedRevision: 0 })).result)
      .toEqual({ autoApprove: true, revision: 1 });
    await vi.waitFor(() => expect(second.messages).toContainEqual({
      type: 'approval-settings-changed', settings: { autoApprove: true, revision: 1 },
    }));
    expect((await request(second, 'approval-settings-get')).result).toEqual({ autoApprove: true, revision: 1 });
    expect((await request(second, 'approval-settings-set', { autoApprove: false, expectedRevision: 0 })).type).toBe('error');
    expect((await request(first, 'approval-settings-get')).result).toEqual({ autoApprove: true, revision: 1 });
  });
  it('persists spawn access and broadcasts it to other authenticated browsers', async () => {
    const first = await ready();
    const second = await ready();
    expect((await request(first, 'spawn-settings-get')).result).toEqual({ defaultMode: 'read-only', revision: 0 });
    expect((await request(first, 'spawn-settings-set', { defaultMode: 'full-access', expectedRevision: 0 })).result)
      .toEqual({ defaultMode: 'full-access', revision: 1 });
    await vi.waitFor(() => expect(second.messages).toContainEqual({
      type: 'spawn-settings-changed', settings: { defaultMode: 'full-access', revision: 1 },
    }));
    expect((await request(second, 'spawn-settings-get')).result).toEqual({ defaultMode: 'full-access', revision: 1 });
    expect((await request(second, 'spawn-settings-set', { defaultMode: 'read-only', expectedRevision: 0 })).type).toBe('error');
    expect((await request(first, 'spawn-settings-get')).result).toEqual({ defaultMode: 'full-access', revision: 1 });
  });
  it('authors and releases skill bytes through the public gateway with revision conflicts', async () => {
    const connection = await ready();
    const source = resolve(work, 'skill-source'); mkdirSync(source);
    const registered = await request(connection, 'skills-source-register', {
      sourceId: 'fixture', paths: [source], writable: true, expectedRevision: null,
    });
    expect(registered.type, String(registered.message ?? '')).toBe('result');
    const created = await request(connection, 'skills-create', {
      sourceId: 'fixture', name: 'audit', files: {
        'SKILL.md': { content_b64: Buffer.from('---\nname: audit\ndescription: Offline fixture\n---\nInstructions\n').toString('base64') },
        'refs/bytes.bin': { content_b64: 'AP8B' },
      },
    });
    expect(created.type).toBe('result');
    const entry = created.result as { id: string; digest: string };
    const released = await request(connection, 'skills-release', { entryId: entry.id, version: '1', expectedDigest: entry.digest });
    expect(released.type).toBe('result');
    expect((released.result as { reference: string }).reference).toBe('fixture/audit@1');
    expect((await request(connection, 'skills-file', { entryId: 'fixture/audit@1', file: 'refs/bytes.bin' })).result).toEqual({ content_b64: 'AP8B' });
    const changed = await request(connection, 'skills-save', { entryId: entry.id, file: 'refs/bytes.bin', content_b64: 'AQI=', expectedDigest: entry.digest });
    expect(changed.type).toBe('result');
    expect((await request(connection, 'skills-save', { entryId: entry.id, file: 'refs/bytes.bin', content_b64: '', expectedDigest: entry.digest })).code).toBe('conflict');
    expect(connection.messages.some(message => message.type === 'skills-changed')).toBe(true);
    const binding = (await request(connection, 'skills-profile-get', { provider: 'codex', profile: 'work' })).result as { revision: string | null };
    expect((await request(connection, 'skills-profile-set', { provider: 'codex', profile: 'work', skills: [{ store: resolve(work, 'skills'), reference: 'fixture/audit@1' }], expectedRevision: binding.revision })).type).toBe('result');
    expect((await request(connection, 'skills-profile-set', { provider: 'codex', profile: 'work', skills: [], expectedRevision: binding.revision })).code).toBe('conflict');
  });

  it('loads real profiles and saved logins without a running daemon', async () => {
    const connection = await ready();
    const response = await request(connection, 'catalog');
    expect(response.type).toBe('result');
    expect(response.result).toMatchObject({
      profiles: expect.arrayContaining([
        expect.objectContaining({
          id: 'codex/work',
          provider: 'codex',
          profile: 'work',
          auth: 'personal',
          weekly_left: null,
          resets_at: null,
          active_runs: 0,
        }),
      ]),
    });
    const budget = await request(connection, 'budgets', {
      provider: 'codex',
      auth: 'personal',
    });
    expect(budget.result).toMatchObject({
      supported: true,
      rows: [
        {
          profile: 'personal',
          bucket: 'default',
          weekly_left: 75,
          resets_at: 1800000000,
        },
      ],
    });
    expect(JSON.stringify(connection.messages)).not.toContain(
      'offline-fixture-private-token',
    );
  });
  it('manages saved logins, profile copies, and provider inspection without exposing credentials', async () => {
    const connection = await ready();
    expect((await request(connection, 'rename-login', { provider: 'codex', auth: 'personal', newName: 'renamed' })).type).toBe('result');
    expect((await request(connection, 'duplicate-profile', { provider: 'codex', profile: 'work', newName: 'copy' })).result).toMatchObject({ created: true });
    expect((await request(connection, 'rename-profile', { provider: 'codex', profile: 'copy', newName: 'copied' })).type).toBe('result');
    const catalog = await request(connection, 'catalog');
    expect(catalog.result).toMatchObject({ profiles: expect.arrayContaining([
      expect.objectContaining({ profile: 'work', auth: 'renamed' }),
      expect.objectContaining({ profile: 'copied', auth: 'renamed' }),
    ]) });
    expect((await request(connection, 'remove-login', { provider: 'codex', auth: 'renamed', confirmed: true })).type).toBe('error');
    for (const profile of ['work', 'copied'])
      expect((await request(connection, 'switch-auth', { provider: 'codex', profile, auth: null })).type).toBe('result');
    expect((await request(connection, 'remove-login', { provider: 'codex', auth: 'renamed', confirmed: true })).result).toMatchObject({ removed: true });
    const providers = await request(connection, 'providers');
    expect(providers.result).toMatchObject({ providers: expect.arrayContaining([
      expect.objectContaining({ provider: 'codex', installed: true, version: '1.2.3', canUpdate: false }),
    ]) });
    expect(JSON.stringify(connection.messages)).not.toContain('offline-fixture-private-token');
    expect(connection.messages.some((message) => message.type === 'profiles-changed')).toBe(true);
  });
  it('discovers and imports projects with durable retries and broadcasts without a daemon', async () => {
    const root = resolve(work, 'projects');
    for (const name of ['one', 'two']) {
      mkdirSync(resolve(root, name), { recursive: true });
      writeFileSync(resolve(root, name, 'package.json'), '{}');
    }
    mkdirSync(resolve(root, 'one', 'nested'));
    writeFileSync(resolve(root, 'one', 'nested', 'package.json'), '{}');
    const connection = await ready();
    const args = { key: crypto.randomUUID(), root, mode: 'add' };
    const started = await request(connection, 'project-discovery-start', args);
    expect(started.type).toBe('result');
    const jobId = (started.result as { id: string }).id;
    let job: Record<string, any>;
    await vi.waitFor(async () => {
      job = (await request(connection, 'project-discovery-get', { jobId })).result as Record<string, any>;
      expect(job.state).toBe('completed');
    });
    expect(job!.registration).toMatchObject({ added: 2, existing: 0 });
    expect(connection.messages.some((message) => message.type === 'projects-changed')).toBe(true);
    expect(connection.messages.some((message) => message.type === 'project-discovery-updated')).toBe(true);
    const reconnect = await ready();
    expect((await request(reconnect, 'project-discovery-start', args)).result).toMatchObject({ id: jobId });
    expect((await request(reconnect, 'project-list')).result).toHaveLength(2);
    const results = (await request(reconnect, 'project-discovery-results', { jobId, limit: 2 })).result as Record<string, any>;
    expect(results).toMatchObject({ total: 3, nextOffset: 2 });
    const filterArgs = { key: crypto.randomUUID(), jobId, scope: 'roots', query: 'one' };
    const filtered = await request(reconnect, 'project-discovery-filter', filterArgs);
    expect(filtered.type).toBe('result');
    expect(filtered.result).toMatchObject({ id: jobId, resultFilter: { scope: 'roots', query: 'one' },
      filtered: { matched: 1, total: 3, preview: [expect.objectContaining({ suggestedName: 'one' })] } });
    expect((await request(reconnect, 'project-discovery-results', { jobId })).result).toMatchObject({ total: 1, nextOffset: null });
    expect((await request(reconnect, 'project-list')).result).toHaveLength(2);
    const again = await ready();
    expect((await request(again, 'project-discovery-filter', filterArgs)).result).toEqual(filtered.result);
    await vi.waitFor(() => expect(connection.messages).toContainEqual(expect.objectContaining({
      type: 'project-discovery-updated', discovery: expect.objectContaining({ id: jobId, filtered: expect.objectContaining({ matched: 1 }) }),
    })));
    expect((await request(again, 'project-discovery-list')).result).toMatchObject({ jobs: [expect.objectContaining({ id: jobId, resultFilter: { scope: 'roots', query: 'one' } })] });
    const repeated = await request(reconnect, 'project-discovery-start', { ...args, key: crypto.randomUUID() });
    const repeatedId = (repeated.result as { id: string }).id;
    await vi.waitFor(async () => {
      const result = (await request(reconnect, 'project-discovery-get', { jobId: repeatedId })).result as Record<string, any>;
      expect(result.registration).toMatchObject({ added: 0, existing: 2 });
    });
  });
  it('discovers a declared Suite root and groups its independently versioned components', async () => {
    const collection = resolve(work, 'projects');
    const suite = resolve(collection, 'aixand-suite');
    const members = ['aixand-ir', 'aixand-python', 'aixand-server', 'aixand-vox', 'aixand-web'];
    mkdirSync(resolve(suite, '.aixand'), { recursive: true });
    writeFileSync(resolve(suite, '.aixand', 'project.json'), JSON.stringify({ schema: 'aixand/project-1', name: 'aixand-suite', members }));
    for (const name of members) {
      mkdirSync(resolve(suite, name, '.git'), { recursive: true });
      writeFileSync(resolve(suite, name, 'package.json'), '{}');
    }
    const connection = await ready();
    const started = await request(connection, 'project-discovery-start', { key: crypto.randomUUID(), root: collection, mode: 'add' });
    const jobId = (started.result as { id: string }).id;
    await vi.waitFor(async () => {
      const job = (await request(connection, 'project-discovery-get', { jobId })).result as Record<string, any>;
      expect(job).toMatchObject({ state: 'completed', scanComplete: true, registration: { added: 1 } });
    });
    const filtered = await request(connection, 'project-discovery-filter', { key: crypto.randomUUID(), jobId, scope: 'roots' });
    expect(filtered.result).toMatchObject({ filtered: { matched: 1, total: 6, preview: [expect.objectContaining({ suggestedName: 'aixand-suite', path: suite })] } });
    expect((await request(connection, 'project-list')).result).toEqual([expect.objectContaining({ name: 'aixand-suite', path: suite })]);
  });
  it('unregisters an exact project with durable retries and updates saved discovery status', async () => {
    const root = resolve(work, 'projects');
    const directory = resolve(root, 'repo');
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'package.json'), '{}');
    const connection = await ready();
    const started = await request(connection, 'project-discovery-start', { key: crypto.randomUUID(), root, mode: 'add' });
    const jobId = (started.result as { id: string }).id;
    let before: Record<string, any>;
    await vi.waitFor(async () => {
      before = (await request(connection, 'project-discovery-get', { jobId })).result as Record<string, any>;
      expect(before.state).toBe('completed');
    });
    const project = ((await request(connection, 'project-list')).result as { id: string; name: string; path: string }[])[0];
    const args = { key: crypto.randomUUID(), projectId: project.id };
    const removed = await request(connection, 'project-remove', args);
    expect(removed).toMatchObject({ type: 'result', result: { projectId: project.id, removed: true, project } });
    expect((await request(connection, 'project-list')).result).toEqual([]);
    expect(readFileSync(resolve(directory, 'package.json'), 'utf8')).toBe('{}');
    const status = (await request(connection, 'project-discovery-get', { jobId })).result as Record<string, any>;
    expect(status.revision).toBeGreaterThan(before!.revision);
    expect(status.registration).toEqual(before!.registration);
    expect((await request(connection, 'project-discovery-results', { jobId })).result).toMatchObject({
      candidates: [expect.objectContaining({ path: directory, existingProjectIds: [] })], total: 1,
    });
    await vi.waitFor(() => expect(connection.messages).toContainEqual(expect.objectContaining({
      type: 'project-discovery-updated', discovery: expect.objectContaining({ id: jobId, revision: status.revision }),
    })));
    const reconnect = await ready();
    const replacement = (await request(reconnect, 'project-create', { name: project.name, path: project.path })).result as { id: string };
    expect(replacement.id).not.toBe(project.id);
    expect((await request(reconnect, 'project-remove', args)).result).toEqual(removed.result);
    expect((await request(reconnect, 'project-list')).result).toEqual([expect.objectContaining({ id: replacement.id })]);
    expect((await request(reconnect, 'project-remove', { ...args, projectId: replacement.id })).type).toBe('error');
    expect((await request(reconnect, 'project-remove', { key: crypto.randomUUID(), projectId: project.id })).result).toMatchObject({ removed: false });
  });
  it('starts the native effect adapter without a browser or runtime daemon', async () => {
    const response = await new Promise<Record<string, any>>((done, reject) => {
      const socket = createConnection(resolve(work, 'native-workflows.sock'));
      let buffer = '';
      socket.once('connect', () => socket.write(JSON.stringify({ op: 'validate', args: { workflow: {} } }) + '\n'));
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('\n')) { done(JSON.parse(buffer)); socket.end(); }
      });
      socket.once('error', reject);
    });
    expect(response).toMatchObject({ ok: false, error: { code: 'validation' } });
  });
  it('discovers workflow runs through the authenticated gateway without launching a provider', async () => {
    const connection = await ready();
    const listed = await request(connection, 'chat-workflow-runs', { offset: 0, limit: 20 });
    expect(listed.type).toBe('result');
    expect(listed.result).toEqual({ runs: [], nextOffset: null });
    const missing = await request(connection, 'chat-workflow-open', { workflowId: 'JOB-missing' });
    expect(missing.type).toBe('error');
    expect(missing.message).toContain('Runner is unavailable');
  });
  it('discovers and publishes prompts through the authenticated gateway without a daemon', async () => {
    const connection = await ready();
    const response = await request(connection, 'prompts-catalog');
    expect(response.type).toBe('result');
    const catalog = response.result as { store: string; packs: { id: string; name: string; kind: string; digest: string | null }[] };
    expect(catalog.store).toBe(resolve(work, 'prompts'));
    const common = catalog.packs.find(row => row.name === 'common' && row.kind === 'draft')!;
    expect((await request(connection, 'prompts-release', {
      packId: common.id, version: '1', expectedDigest: common.digest,
    })).type).toBe('result');
    const next = (await request(connection, 'prompts-catalog')).result as typeof catalog;
    const agents = next.packs.find(row => row.name === 'agents' && row.kind === 'draft')!;
    expect((await request(connection, 'prompts-preview', {
      packId: agents.id, prompt: 'review', inputs: { audience: 'maintainers' },
    })).result).toMatchObject({ output: expect.arrayContaining([expect.objectContaining({ role: 'system' })]) });
    const mutationId = crypto.randomUUID();
    const args = { packId: agents.id, version: '1', expectedDigest: agents.digest };
    const published = await request(connection, 'prompts-release', args, mutationId);
    expect(published.type).toBe('result');
    expect((await request(connection, 'prompts-release', args, mutationId)).result).toEqual(published.result);
    expect((await request(connection, 'prompts-show', { packId: 'a'.repeat(64) })).type).toBe('error');
  });
  it('persists assignments, supports saved models and preserves partial creates', async () => {
    const connection = await ready();
    expect(
      (
        await request(connection, 'switch-auth', {
          provider: 'codex',
          profile: 'work',
          auth: 'company',
        })
      ).type,
    ).toBe('result');
    const rows = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          'import asyncio,json,agent_manager; print(json.dumps(asyncio.run(agent_manager.Client("codex").profiles(include_budget=False))))',
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profile: 'work', auth: 'company' }),
      ]),
    );
    expect(
      (
        await request(connection, 'create-profile', {
          provider: 'opencode',
          profile: 'free',
          model: 'fixture/free',
        })
      ).type,
    ).toBe('result');
    expect(
      (
        await request(connection, 'set-model', {
          provider: 'opencode',
          profile: 'free',
          model: null,
        })
      ).type,
    ).toBe('result');
    const partial = await request(connection, 'create-profile', {
      provider: 'codex',
      profile: 'partial',
      auth: 'missing',
    });
    expect(partial.result).toMatchObject({
      created: true,
      assignmentError: expect.any(String),
    });
    const id = crypto.randomUUID();
    const args = { provider: 'codex', profile: 'deduplicated' };
    const first = await request(connection, 'create-profile', args, id);
    const count = connection.messages.length;
    connection.socket.send(JSON.stringify({ id, op: 'create-profile', args }));
    await vi.waitFor(() =>
      expect(connection.messages.length).toBeGreaterThan(count),
    );
    expect(connection.messages.at(-1)).toEqual(first);
    connection.socket.close();
    const other = await ready();
    const catalog = await request(other, 'catalog');
    expect(catalog.result).toMatchObject({
      profiles: expect.arrayContaining([
        expect.objectContaining({ profile: 'partial' }),
        expect.objectContaining({ profile: 'deduplicated' }),
      ]),
    });
  });
  it('deletes a managed profile, preserves saved logins, and reports the change to other tabs', async () => {
    const connection = await ready();
    const observer = await ready();
    const args = { provider: 'codex', profile: 'review', confirmed: true };
    const id = crypto.randomUUID();
    const result = await request(connection, 'delete-profile', args, id);
    expect(result).toMatchObject({ type: 'result', result: { deleted: true } });
    await vi.waitFor(() => expect(observer.messages).toContainEqual({ type: 'profiles-changed' }));
    const catalog = (await request(observer, 'catalog')).result as { profiles: { profile: string }[]; auths: { auth: string }[] };
    expect(catalog.profiles.some((profile) => profile.profile === 'review')).toBe(false);
    expect(catalog.profiles.some((profile) => profile.profile === 'work')).toBe(true);
    expect(catalog.auths.some((auth) => auth.auth === 'company')).toBe(true);
    const count = connection.messages.length;
    connection.socket.send(JSON.stringify({ id, op: 'delete-profile', args }));
    await vi.waitFor(() => expect(connection.messages.length).toBeGreaterThan(count));
    expect(connection.messages.at(-1)).toEqual(result);
    const native = await request(connection, 'delete-profile', { ...args, profile: 'default' });
    expect(native).toMatchObject({ type: 'error', message: expect.stringContaining('native default') });
  });
  it('rejects browser-selected launch environments', async () => {
    const { socket } = await ready();
    const closed = new Promise<number>((done) => socket.once('close', done));
    socket.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        op: 'launch',
        args: {
          provider: 'codex',
          profile: 'work',
          cwd: work,
          env: { SECRET: 'browser' },
        },
      }),
    );
    expect(await closed).toBe(1008);
  });
  it('rejects reusing a mutation ID with different arguments', async () => {
    const connection = await ready();
    const id = crypto.randomUUID();
    await request(
      connection,
      'create-profile',
      { provider: 'codex', profile: 'first' },
      id,
    );
    const closed = new Promise<number>((done) =>
      connection.socket.once('close', done),
    );
    connection.socket.send(
      JSON.stringify({
        id,
        op: 'create-profile',
        args: { provider: 'codex', profile: 'second' },
      }),
    );
    expect(await closed).toBe(1008);
    const other = await ready();
    const catalog = await request(other, 'catalog');
    expect(JSON.stringify(catalog.result)).not.toContain('codex/second');
  });
  it('rejects requests before authentication', async () => {
    const socket = new WebSocket(url, { origin });
    sockets.push(socket);
    const closed = new Promise<number>((done) => socket.once('close', done));
    await new Promise<void>((done) =>
      socket.once('open', () => {
        socket.send(
          JSON.stringify({ id: crypto.randomUUID(), op: 'catalog', args: {} }),
        );
        done();
      }),
    );
    expect(await closed).toBe(1008);
  });
  it('reports an unavailable interpreter after authentication', async () => {
    const connection = await connect();
    await vi.waitFor(() =>
      expect(
        connection.messages.some((message) => message.type === 'fatal'),
      ).toBe(true),
    );
    expect(connection.messages).toContainEqual({
      type: 'fatal',
      message: expect.stringContaining('AGENTS_PYTHON'),
    });
  });
});
