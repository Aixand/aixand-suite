import { vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { voxInstalled } from './capabilities.js';

vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe('Vox installation capability', () => {
  it('hides a missing runtime even when voice is enabled', () => {
    vi.stubEnv('AIXAND_VOICE_ENABLED', '1');
    vi.stubEnv('VOX_PYTHON', '/missing/vox/python');
    vi.mocked(existsSync).mockReturnValue(false);
    expect(voxInstalled()).toBe(false);
  });
  it('recognizes an installed configured runtime', () => {
    vi.stubEnv('AIXAND_VOICE_ENABLED', '1');
    vi.stubEnv('VOX_PYTHON', '/installed/vox/python');
    vi.mocked(existsSync).mockImplementation(path => path === '/installed/vox/python');
    expect(voxInstalled()).toBe(true);
  });
  it('respects packages with voice disabled', () => {
    vi.stubEnv('AIXAND_VOICE_ENABLED', '0');
    vi.mocked(existsSync).mockReturnValue(true);
    expect(voxInstalled()).toBe(false);
  });
  it('recognizes a configured Python command on PATH', () => {
    vi.stubEnv('AIXAND_VOICE_ENABLED', '1');
    vi.stubEnv('VOX_PYTHON', 'vox-python');
    vi.stubEnv('PATH', '/vox/bin');
    vi.mocked(existsSync).mockImplementation(path => path === resolve('/vox/bin/vox-python'));
    expect(voxInstalled()).toBe(true);
  });
});
