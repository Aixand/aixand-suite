import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { agentPython } from '../agents/python.js';

const nativeFile = fileURLToPath(new URL('./auth_directory.node', import.meta.url));
const native: { check(path: string): void } | undefined = process.platform === 'win32' && existsSync(nativeFile)
  ? createRequire(import.meta.url)(nativeFile) : undefined;

/** Read live NTFS permissions in-process; Python handles infrequent creation. */
export function windowsPrivatePath(action: 'create' | 'check' | 'secure-file', path: string) {
  try {
    if (action === 'check' && native) { native.check(path); return; }
    const { python, env } = agentPython();
    execFileSync(python, ['-I', '-B', '-m', 'aixand_platform.auth_directory', action, path], {
      env, windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    throw new Error('Use a private authentication directory owned by the current Windows account. Its permissions could not be verified.', { cause });
  }
}
