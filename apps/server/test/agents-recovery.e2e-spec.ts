import { authFixture, fixtureCookie } from './auth-fixture.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';

describe('Manager Suites public recovery and reconnect', () => {
  let app: INestApplication;
  let work: string;
  let url: string;
  let cookie: string;
  let fixtureAuth: Awaited<ReturnType<typeof authFixture>>;
  const sockets: WebSocket[] = [];
  beforeEach(async (context) => {
    fixtureAuth = await authFixture();
    work = mkdtempSync(resolve(tmpdir(), 'ms-gw-'));
    const fixture = JSON.parse(execFileSync('python3', ['agent-bridge/tests/fixture.py', work], { encoding: 'utf8' }));
    const config = readFileSync(fixture.config, 'utf8');
    const python = execFileSync('python3', ['-B', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
    writeFileSync(fixture.config, config.replace('home_env = "TEST_AGENT_HOME"', 'home_env = "CODEX_HOME"')
      .replace('[providers.codex]', '[providers.codex]\nacp_command='+JSON.stringify([python, '-B', '-m', 'server_manager.fixture_agent'])));
    mkdirSync(resolve(work, 'scratch'));
    for (const [key, value] of Object.entries({ CORS_ORIGINS: 'http://localhost:5186',
      AGENTS_PYTHON: python, AGENTS_BRIDGE_PATH: resolve('agent-bridge/tests/gateway_recovery_fixture.py'),
      AGENT_MANAGER_HOME: fixture.home, AGENT_MANAGER_CONFIG: fixture.config, AGENTS_CWD: work,
      AGENTS_STATE_DIR: resolve(work, 'state'), AGENTS_SCRATCH_DIR: resolve(work, 'scratch'),
      AGENTS_WORKSPACE_TOOLS: '0', SUITE_WORKFLOW_SOCKET: '', CARRIER_DATABASE: '',
      UNDERCURRENT_HOME: resolve(work, 'runtime'), SKILL_MANAGER_HOME: resolve(work, 'skills'),
      PROMPT_MANAGER_HOME: resolve(work, 'prompts'), SKILLS_SOURCE_PATHS: '', PROMPTS_PACK_PATHS: '',
    })) vi.stubEnv(key, value);
    // The worker now boots with the backend, before any browser request.
    if (context.task.name.includes('retains the legacy reconnect envelope')) {
      writeFileSync(resolve(work, 'legacy-chat.json'), JSON.stringify({ id: crypto.randomUUID(), profile: 'work', provider: 'codex', auth: 'personal',
        threadId: crypto.randomUUID(), runId: 'saved-run', cwd: work, mode: 'chat', title: 'Saved conversation', status: 'ready',
        workspaceTools: false, items: [], requests: [], createdAt: 1, updatedAt: 1,
        mcp: { digest: 'sha256:'+'1'.repeat(64) } }));
    }
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication(); configureApp(app); await app.listen(0, '127.0.0.1');
    cookie = fixtureCookie(app);
    url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/agents/ws`;
  });
  afterEach(async () => {
    for (const socket of sockets) socket.terminate(); sockets.length = 0;
    await app.close(); fixtureAuth.cleanup(); vi.unstubAllEnvs(); rmSync(work, { recursive: true, force: true });
  });
  async function connect() {
    const socket = new WebSocket(url, { origin: 'http://localhost:5186', headers: { Cookie: cookie } });
    sockets.push(socket);
    const messages: Record<string, any>[] = [];
    socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
    await vi.waitFor(() => expect(messages.some(row => row.type === 'ready')).toBe(true), { timeout: 10000 });
    return { socket, messages };
  }
  async function request(connection: Awaited<ReturnType<typeof connect>>, op: string, args: object) {
    const id = crypto.randomUUID(); connection.socket.send(JSON.stringify({ id, op, args }));
    await vi.waitFor(() => expect(connection.messages.some(row => row.id === id)).toBe(true), { timeout: 15000 });
    const result = connection.messages.find(row => row.id === id)!;
    if (result.type === 'error' && result.code !== 'uncertain') throw new Error(JSON.stringify(result));
    return result;
  }
  it.each([false, true])('recovers a lost creation acknowledgment through the gateway (dead worker: %s)', async dead => {
    if (dead) writeFileSync(resolve(work, 'dead-worker'), 'stop after confirmed create');
    const connection = await connect(); const key = crypto.randomUUID();
    const args = { key, profile: 'work', mode: 'chat', backend: 'codex-acp', mcp: { inherit: false } };
    expect(await request(connection, 'chat-create', args)).toMatchObject({ code: 'uncertain' });
    const retained = JSON.parse(readFileSync(resolve(work, 'create-receipt.json'), 'utf8'));
    expect((await request(connection, 'chat-backend-operation', { chatId: key, operationId: 'suite-create:'+key })).result).toEqual(retained);
    const details = (await request(connection, 'chat-backend-details', { chatId: key })).result;
    expect(details.sessionRef).toEqual(retained.result.session_ref);
    expect(details.connectionRef).toEqual(retained.recovery.connection_ref);
    expect((await request(connection, 'chat-create', args)).result.id).toBe(key);
    connection.socket.close();
    const second = await connect();
    expect((await request(second, 'chat-backend-operation', { chatId: key, operationId: 'suite-create:'+key })).result).toEqual(retained);
    expect(JSON.parse(readFileSync(resolve(work, 'worker-starts.json'), 'utf8'))).toBe(1);
  }, 30000);
  it('retains the legacy reconnect envelope and payload while the guarded native API stays unsupported', async () => {
    const { id, threadId: thread, mcp: selection } = JSON.parse(readFileSync(resolve(work, 'legacy-chat.json'), 'utf8'));
    const connection = await connect();
    expect(await request(connection, 'mcp-chat-reconnect', { chatId: id })).toMatchObject({ type: 'result', result: { servers: [], selection, suiteTools: null } });
    const calls = readFileSync(resolve(work, 'native-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toEqual([{ method: 'config/mcpServer/reload' }, { thread }]);
    const guarded = await request(connection, 'mcp-chat-reconnect', { chatId: id, scope: 'session', operationId: 'guarded-reconnect', expectedSelectionDigest: selection.digest });
    expect(guarded.result.status).toBe('unsupported');
    expect(guarded.result.capabilities.preserve_selection).toBe(false);
    expect(readFileSync(resolve(work, 'native-calls.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
