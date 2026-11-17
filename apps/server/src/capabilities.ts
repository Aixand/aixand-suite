import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';

/** Package inclusion, independent of worker or model readiness. */
export function voiceEnabled() {
  return process.env.AIXAND_VOICE_ENABLED === '1' ||
    (process.env.AIXAND_VOICE_ENABLED === undefined && process.env.AIXAND_PACKAGED_RUNTIME !== '1');
}

/** Detect the Vox runtime without starting its worker or loading speech models. */
export function voxInstalled() {
  if (!voiceEnabled()) return false;
  const python = process.env.VOX_PYTHON ?? resolve('../../services/vox/.venv/bin/python');
  if (isAbsolute(python) || python.includes('/') || python.includes('\\')) return existsSync(python);
  const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  return (process.env.PATH ?? '').split(delimiter).filter(Boolean)
    .some(directory => extensions.some(extension => existsSync(resolve(directory, python + extension))));
}
