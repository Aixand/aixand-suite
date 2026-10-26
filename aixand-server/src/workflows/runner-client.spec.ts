import { createServer, type Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerError, runnerRequest } from './runner-client.js';

describe('Runner socket transport', () => {
  let server: Server;
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'workflow-runner-test-'));
  });
  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  async function listen(reply: string | null, received: object[]) {
    server = createServer((socket) => {
      socket.once('data', (buffer) => {
        received.push(JSON.parse(buffer.toString()));
        if (reply === null) {
          socket.end();
          return;
        }
        const bytes = Buffer.from(reply);
        // Split inside a UTF-8 character as well as across JSON fragments.
        const split = bytes.indexOf(Buffer.from('✓')) + 1;
        socket.write(bytes.subarray(0, split));
        socket.end(bytes.subarray(split));
      });
    });
    const path = join(home, 'runner.sock');
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return path;
  }
  it('passes a newline JSON request and reassembles a fragmented response', async () => {
    const requests: object[] = [];
    const path = await listen('{"ok":true,"data":{"message":"✓"}}\n', requests);
    await expect(runnerRequest({ op: 'health' }, path)).resolves.toEqual({
      message: '✓',
    });
    expect(requests).toEqual([{ op: 'health' }]);
  });
  it('retains Runner preflight diagnostics and fails on an incomplete response', async () => {
    const path = await listen(
      '{"ok":false,"error":{"code":"validation","message":"Invalid workflow","details":{"location":"/body"}}}\n',
      [],
    );
    await expect(runnerRequest({ op: 'submit' }, path)).rejects.toMatchObject({
      code: 'validation',
      details: { location: '/body' },
    });
  });
  it('does not report a dropped submission response as success', async () => {
    const path = await listen(null, []);
    await expect(runnerRequest({ op: 'submit' }, path)).rejects.toBeInstanceOf(
      RunnerError,
    );
  });
});
