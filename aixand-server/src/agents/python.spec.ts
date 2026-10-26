import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentPython } from './python.js';

describe('Agent Python source configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('loads Resource Sources from the checkout without installed site packages', () => {
    vi.stubEnv('RESOURCE_SOURCES_SOURCE', undefined);
    const { python, env } = agentPython();
    const path = execFileSync(python, ['-B', '-S', '-c', 'import resource_sources; print(resource_sources.__file__)'],
      { env, encoding: 'utf8', timeout: 10_000 }).trim();
    expect(path).toBe(resolve('../../manager-suites/resource-sources/src/resource_sources/__init__.py'));
  });

  it('honors the configured Resource Sources checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-resource-source-'));
    try {
      const module = join(root, 'resource_sources');
      mkdirSync(module);
      writeFileSync(join(module, '__init__.py'), 'source_marker = "configured-checkout"\n');
      vi.stubEnv('RESOURCE_SOURCES_SOURCE', root);
      const { python, env } = agentPython();
      expect(execFileSync(python, ['-B', '-S', '-c', 'import resource_sources; print(resource_sources.source_marker)'],
        { env, encoding: 'utf8', timeout: 10_000 }).trim()).toBe('configured-checkout');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
