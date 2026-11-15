import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { agentPython } from './python.js';

describe('Agent Python source configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses installed external packages and retains Suite-owned source paths', () => {
    vi.stubEnv('AIXAND_PACKAGED_RUNTIME', '0');
    const { env } = agentPython();
    const paths = env.PYTHONPATH!.split(delimiter);
    expect(paths).toContain(resolve('../../mcps/orchestration/src'));
    expect(paths).toContain(resolve('../../services/connect'));
    expect(paths.some(path => path.includes('manager-suites') || path.includes('aixand-libraries'))).toBe(false);
    expect(paths.some(path => /\/(server-manager|resource-sources)\/src$/.test(path))).toBe(false);
  });

  it('keeps packaged workers isolated from development sources', () => {
    vi.stubEnv('AIXAND_PACKAGED_RUNTIME', '1');
    vi.stubEnv('CONVERSATIONS_MANAGER_SOURCE', '/unused/development/source');
    vi.stubEnv('CONVERSATION_MANAGER_HOME', '/configured/conversations');
    vi.stubEnv('AIXAND_MANAGER_ROOT', '/configured/managers');
    vi.stubEnv('AGENT_MANAGER_HOMES_ROOT', '/configured/accounts');
    const { env } = agentPython();
    expect(env.PYTHONPATH).toBe('');
    expect(env.PYTHONNOUSERSITE).toBe('1');
    expect(env.CONVERSATION_MANAGER_HOME).toBe('/configured/conversations');
    expect(env.AIXAND_MANAGER_ROOT).toBe('/configured/managers');
    expect(env.AGENT_MANAGER_HOMES_ROOT).toBe('/configured/accounts');
  });

  it('honors the configured Conversation Manager checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-conversation-source-'));
    try {
      const module = join(root, 'conversation_manager');
      mkdirSync(module);
      writeFileSync(join(module, '__init__.py'), 'source_marker = "configured-checkout"\n');
      vi.stubEnv('AIXAND_PACKAGED_RUNTIME', '0');
      vi.stubEnv('CONVERSATIONS_MANAGER_SOURCE', root);
      const { python, env } = agentPython();
      expect(execFileSync(python, ['-B', '-S', '-c', 'import conversation_manager; print(conversation_manager.source_marker)'],
        { env, encoding: 'utf8', timeout: 10_000 }).trim()).toBe('configured-checkout');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
