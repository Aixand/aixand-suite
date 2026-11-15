import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectController } from './connect.module.js';

const directories: string[] = [];
const saved = process.env.AIXAND_CONNECT_COMPANION;
afterEach(async () => {
  if (saved === undefined) delete process.env.AIXAND_CONNECT_COMPANION;
  else process.env.AIXAND_CONNECT_COMPANION = saved;
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
describe('Connect component download', () => {
  it('streams the selected component bytes without executing or rebuilding them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'suite-connect-download-')); directories.push(directory);
    const file = join(directory, 'companion.pyz'), bytes = Buffer.from('PK synthetic companion fixture');
    await writeFile(file, bytes); process.env.AIXAND_CONNECT_COMPANION = file;
    const response = await new ConnectController().companion();
    const chunks: Buffer[] = [];
    for await (const chunk of response.getStream()) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(response.getHeaders()).toMatchObject({ type: 'application/zip', length: bytes.length });
  });
  it('refuses missing, relative or redirected component files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'suite-connect-unavailable-')); directories.push(directory);
    const controller = new ConnectController();
    process.env.AIXAND_CONNECT_COMPANION = 'relative/companion.pyz';
    await expect(controller.companion()).rejects.toThrow('absolute');
    process.env.AIXAND_CONNECT_COMPANION = join(directory, 'absent');
    await expect(controller.companion()).rejects.toThrow('unavailable');
    const target = join(directory, 'fixture.pyz'); await writeFile(target, 'fixture');
    try { await symlink(target, join(directory, 'redirect.pyz')); } catch { return; }
    process.env.AIXAND_CONNECT_COMPANION = join(directory, 'redirect.pyz');
    await expect(controller.companion()).rejects.toThrow('unavailable');
  });
});
