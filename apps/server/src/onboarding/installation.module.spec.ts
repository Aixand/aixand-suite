import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstallationService } from './installation.module.js';

describe('product installation command selection', () => {
  let directory: string;
  let originalRuntime: string | undefined;
  let originalPackaged: string | undefined;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'installation commands 世界 '));
    originalRuntime = process.env.AIXAND_PRODUCT_RUNTIME;
    originalPackaged = process.env.AIXAND_PACKAGED_RUNTIME;
    process.env.AIXAND_PRODUCT_RUNTIME = directory;
    process.env.AIXAND_PACKAGED_RUNTIME = '1';
    await writeFile(join(directory, 'runtime.mjs'), `
      import { writeFileSync } from 'node:fs';
      const [, , command, action, raw] = process.argv;
      if (command !== 'setup') process.exit(2);
      if (action === 'products') console.log(JSON.stringify({ licenses: [] }));
      else if (action === 'commands') console.log(JSON.stringify({ userPathSupported: true,
        commands: [{ name: 'uc', suiteVersion: '0.1.0-beta', default: { version: '2.0.0', path: 'old/uc.exe' } }] }));
      else if (action === 'install') writeFileSync(${JSON.stringify(join(directory, 'request.json'))}, raw);
      else process.exit(2);
    `);
  });
  afterEach(async () => {
    if (originalRuntime === undefined) delete process.env.AIXAND_PRODUCT_RUNTIME;
    else process.env.AIXAND_PRODUCT_RUNTIME = originalRuntime;
    if (originalPackaged === undefined) delete process.env.AIXAND_PACKAGED_RUNTIME;
    else process.env.AIXAND_PACKAGED_RUNTIME = originalPackaged;
    await rm(directory, { recursive: true, force: true });
  });

  it('reads actual competing command versions from the packaged runtime', async () => {
    const service = new InstallationService();
    expect(await service.commands()).toMatchObject({ userPathSupported: true,
      commands: [{ name: 'uc', suiteVersion: '0.1.0-beta', default: { version: '2.0.0' } }] });
  });

  for (const terminalPolicy of ['keep', 'prefer']) it(`forwards the explicit ${terminalPolicy} policy to the installer`, async () => {
    const service = new InstallationService();
    expect(await service.install({ acceptedLicenses: [], terminalPolicy })).toEqual({ started: true });
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')); }
      catch { return null; }
    }).toEqual({ acceptedLicenses: [], terminalPolicy });
    await expect.poll(async () => (await service.status()).starting).toBe(false);
  });

  it('rejects unknown policies and arbitrary installer sources', async () => {
    const service = new InstallationService();
    await expect(service.install({ acceptedLicenses: [], terminalPolicy: 'latest' })).rejects.toThrow('Invalid product installation request');
    await expect(service.install({ acceptedLicenses: [], artifact: '/arbitrary-source' })).rejects.toThrow('Invalid product installation request');
    await expect(readFile(join(directory, 'request.json'))).rejects.toThrow();
  });
});
