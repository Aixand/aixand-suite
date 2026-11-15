import { BadRequestException, Injectable } from '@nestjs/common';
import { access, opendir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

export type DirectoryEntry = { name: string; path: string };
@Injectable()
export class FilesystemService {
  home = homedir();
  cwd = resolve(process.env.AGENTS_CWD ?? process.env.TERMINAL_CWD ?? this.home);
  private expand(value: string, base = this.cwd) {
    if (value.includes('\0') || value.length > 4096) throw new BadRequestException('Invalid directory path.');
    const path = value === '~' ? this.home : /^~[/\\]/.test(value) ? join(this.home, value.slice(2)) : value;
    return isAbsolute(path) ? path : resolve(base, path);
  }
  async directory(value: string, base?: string) {
    try {
      const path = await realpath(this.expand(value, base));
      if (!(await stat(path)).isDirectory()) throw new Error();
      await access(path, constants.R_OK | constants.X_OK);
      return path;
    } catch { throw new BadRequestException('Folder does not exist or is not accessible to Suite.'); }
  }
  async locations() {
    const locations: (DirectoryEntry & { id: string })[] = [];
    for (const [id, name, value] of [['home', 'Home', this.home], ['workspace', 'Workspace', this.cwd]]) {
      try { locations.push({ id, name, path: await this.directory(value) }); } catch { /* Report available shortcuts only. */ }
    }
    return { locations, initial: locations.find(row => row.id === 'workspace')?.path ?? locations[0]?.path ?? parse(this.cwd).root };
  }
  async list(input: { path: string; base?: string; prefix?: string; cursor?: number; limit?: number; hidden?: boolean; suggest?: boolean }) {
    const expanded = this.expand(input.path, input.base);
    let path: string;
    let prefix = input.prefix ?? '';
    if (input.suggest) {
      try { path = await this.directory(expanded); }
      catch { path = await this.directory(dirname(expanded)); prefix = basename(expanded); }
    } else path = await this.directory(expanded);
    const entries: DirectoryEntry[] = [];
    const directory = await opendir(path);
    let scanned = 0;
    for await (const entry of directory) {
      if (++scanned > 50000) throw new BadRequestException('This directory is too large to browse. Open a more specific path.');
      if (!input.hidden && !prefix.startsWith('.') && entry.name.startsWith('.')) continue;
      if (!entry.name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      try {
        if (!(await stat(child)).isDirectory()) continue;
        entries.push({ name: entry.name, path: child });
      } catch { /* A disappearing or broken link is not a directory entry. */ }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const offset = input.cursor ?? 0, limit = input.limit ?? 100;
    const breadcrumbs: DirectoryEntry[] = [];
    let ancestor = path;
    for (;;) {
      breadcrumbs.unshift({ name: basename(ancestor) || ancestor, path: ancestor });
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    return { path, name: basename(path) || path, parent: dirname(path) === path ? null : dirname(path), breadcrumbs,
      entries: entries.slice(offset, offset + limit), total: entries.length,
      nextCursor: offset + limit < entries.length ? offset + limit : null };
  }
}
