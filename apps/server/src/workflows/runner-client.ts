import { createLocalConnection } from '../local-ipc.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class RunnerError extends Error {
  constructor(
    message: string,
    readonly code = 'runner_connection',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

// The host selects the local service. Browser documents never select a socket.
export function runnerSocketPath() {
  const home =
    process.env.WORKFLOW_RUNNER_HOME ??
    process.env.RUNNER_HOME ??
    (process.platform === 'win32' && !process.env.XDG_STATE_HOME
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Aixand', 'Runner')
      : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'runner'));
  return join(home, 'runner.sock');
}

export function runnerRequest<T>(
  request: object,
  path = runnerSocketPath(),
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createLocalConnection(path);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result as T);
    };
    socket.setTimeout(20_000, () =>
      finish(
        new RunnerError(
          'Runner request timed out. A submission may have been accepted; reconnect to recover it using the same key.',
          'runner_timeout',
        ),
      ),
    );
    socket.on('error', () =>
      finish(
        new RunnerError(
          'Cannot reach the local Runner service. Start Runner with SDK support and check WORKFLOW_RUNNER_HOME.',
        ),
      ),
    );
    socket.on('end', () =>
      finish(new RunnerError('Runner closed before returning a response.')),
    );
    socket.on('connect', () => socket.end(JSON.stringify(request) + '\n'));
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        finish(new RunnerError('Runner response exceeds 16 MiB.'));
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      try {
        const reply = JSON.parse(
          Buffer.concat(chunks).toString('utf8').split('\n')[0],
        ) as {
          ok: boolean;
          data?: T;
          error?: { code: string; message: string; details?: unknown };
        };
        if (reply.ok === true && 'data' in reply) finish(undefined, reply.data);
        else if (reply.ok === false && reply.error)
          finish(
            new RunnerError(
              reply.error.message,
              reply.error.code,
              reply.error.details,
            ),
          );
        else finish(new RunnerError('Invalid Runner response.'));
      } catch {
        finish(new RunnerError('Invalid Runner response.'));
      }
    });
  });
}
