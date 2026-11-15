import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';

// Descriptors live in the runtime's protected, per-user state directory. Never
// accept a host/address from an endpoint file or a browser request.
export function createLocalConnection(path: string) {
  if (process.platform !== 'win32') return createConnection(path);
  const bytes = readFileSync(path);
  if (bytes.length > 4096) throw new Error('Invalid local endpoint');
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.schema !== 'aixand.local/1' || !Number.isInteger(value.port) ||
      value.port < 1024 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token))
    throw new Error('Invalid local endpoint');
  const channel = createConnection({ host: '127.0.0.1', port: value.port });
  channel.once('connect', () => channel.write(JSON.stringify({ token: value.token }) + '\n'));
  return channel;
}
