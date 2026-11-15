import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemService } from './filesystem.service.js';

describe('host directory browsing', () => {
  let root: string, fs: FilesystemService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'suite-folders-'));
    fs = new FilesystemService(); fs.home = root; fs.cwd = root;
    await Promise.all(['alpha', 'beta', '.hidden'].map(name => mkdir(join(root, name))));
    await writeFile(join(root, 'file.txt'), 'not a folder');
    await symlink(join(root, 'alpha'), join(root, 'alias'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  it('lists directories, paginates, and returns host-generated breadcrumbs', async () => {
    const page = await fs.list({ path: '~', limit: 2 });
    expect(page.entries.map(row => row.name)).toEqual(['alias', 'alpha']);
    expect(page.nextCursor).toBe(2);
    expect(page.breadcrumbs.at(-1)?.path).toBe(root);
    expect((await fs.list({ path: root, cursor: 2 })).entries.map(row => row.name)).toEqual(['beta']);
    expect((await fs.list({ path: root, hidden: true })).entries).toHaveLength(4);
  });
  it('suggests partial paths and normalizes aliases and relative paths', async () => {
    expect((await fs.list({ path: './al', base: root, suggest: true })).entries.map(row => row.name)).toEqual(['alias', 'alpha']);
    expect(await fs.directory('~/alias')).toBe(join(root, 'alpha'));
    expect((await fs.list({ path: '../beta', base: join(root, 'alpha') })).path).toBe(join(root, 'beta'));
    await expect(fs.directory('file.txt')).rejects.toThrow('not accessible');
    await expect(fs.directory('missing')).rejects.toThrow('not accessible');
    await expect(fs.directory('bad\0path')).rejects.toThrow();
  });
});
