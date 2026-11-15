import { voiceEnabled } from './capabilities.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { VoxService } from './vox/vox.service.js';
import type { AgentsService } from './agents/agents.service.js';

afterEach(() => vi.unstubAllEnvs());

it('defaults development to voice enabled and packaged runtimes to disabled', () => {
  vi.stubEnv('AIXAND_VOICE_ENABLED', undefined);
  vi.stubEnv('AIXAND_PACKAGED_RUNTIME', undefined);
  expect(voiceEnabled()).toBe(true);
  vi.stubEnv('AIXAND_PACKAGED_RUNTIME', '1');
  expect(voiceEnabled()).toBe(false);
});

it.each(['0', '1'])('reports explicit voice inclusion %s independently of Python readiness', (flag) => {
  vi.stubEnv('AIXAND_VOICE_ENABLED', flag);
  vi.stubEnv('VOX_PYTHON', '/missing/python');
  expect(new AppController(new AppService()).getCapabilities()).toEqual({ voice: flag === '1' });
});

it('rejects excluded voice before attempting to launch a worker', async () => {
  vi.stubEnv('AIXAND_VOICE_ENABLED', '0');
  vi.stubEnv('VOX_PYTHON', '/missing/python');
  const service = new VoxService({ subscribe: () => () => {} } as unknown as AgentsService);
  await expect(service.ready()).rejects.toThrow('Voice is not included in this installation.');
  await service.onApplicationShutdown();
});
