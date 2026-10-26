import { platformEnvironment } from '../platform-environment.js';
import { Inject, OnApplicationShutdown } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { commandSchema } from './protocol.js';

import { AuthService } from '../auth/auth.service.js';

@WebSocketGateway({
  path: '/api/terminals/ws',
  maxPayload: 64 * 1024,
  perMessageDeflate: false,
})
export class TerminalsGateway
  implements OnGatewayConnection, OnApplicationShutdown
{
  private readonly clients = new Set<WebSocket>();

  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  handleConnection(socket: WebSocket, request: IncomingMessage) {
    if (!this.auth.authorizeSocket(socket, request)) return;
    if (this.clients.size >= 8) {
      socket.close(1013, 'Terminal connection limit reached');
      return;
    }
    this.clients.add(socket);
    let bridge: ChildProcessWithoutNullStreams | undefined;
    let ready = false;
    let buffer = '';
    let alive = true;
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    const send = (message: unknown) => {
      if (socket.readyState !== WebSocket.OPEN || !this.auth.canSend(socket))
        return;
      if (socket.bufferedAmount > 512 * 1024) {
        socket.close(1013, 'Terminal output is too slow; reconnect to resume');
        return;
      }
      socket.send(JSON.stringify(message));
    };
    const fail = (message: string) => {
      send({ type: 'fatal', message });
      socket.close(1011, 'Terminal connection ended');
    };
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 15_000);
    socket.on('pong', () => {
      alive = true;
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearInterval(heartbeat);
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      this.clients.delete(socket);
      if (bridge) {
        const child = bridge;
        child.stdin.end();
        const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
        child.once('exit', () => clearTimeout(kill));
        if (child.exitCode !== null) clearTimeout(kill);
      }
    });
    this.auth.onMessage(socket, (raw, binary) => {
      if (binary) {
        socket.close(1008, 'Expected JSON message');
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        socket.close(1008, 'Invalid JSON');
        return;
      }
      const command = commandSchema.safeParse(value);
      if (!command.success) {
        socket.close(1008, 'Invalid terminal request');
        return;
      }
      const { id, op } = command.data;
      if (!ready || !bridge) {
        send({
          type: 'error',
          id,
          message: 'Undercurrent is not connected yet.',
        });
        return;
      }
      if (pending.has(id)) {
        socket.close(1008, 'Duplicate request ID');
        return;
      }
      if (op !== 'ack') {
        if (pending.size >= 32) {
          send({ type: 'error', id, message: 'Too many pending requests.' });
          return;
        }
        pending.set(
          id,
          setTimeout(() => {
            pending.delete(id);
            fail(
              'Terminal request timed out. Its effect may be uncertain; it was not retried.',
            );
          }, 15_000),
        );
      }
      if (bridge.stdin.writableLength > 128 * 1024) {
        fail('Terminal input queue is full. Input was not retried.');
        return;
      }
      bridge.stdin.write(JSON.stringify(command.data) + '\n');
    });
    const start = () => {
      const env: NodeJS.ProcessEnv = { ...platformEnvironment(),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      };
      for (const key of [
        'UNDERCURRENT_HOME',
        'TERMINAL_SHELL',
        'TERMINAL_CWD',
      ]) {
        if (process.env[key]) env[key] = process.env[key];
      }
      bridge = spawn(
        process.env.TERMINAL_BRIDGE_PATH ??
          resolve('bridge/target/debug/aixand-terminal-bridge'),
        [],
        { env, stdio: 'pipe' },
      );
      const startup = setTimeout(
        () =>
          fail(
            'Undercurrent connection timed out. Check that the daemon is running.',
          ),
        15_000,
      );
      bridge.once('error', () => {
        clearTimeout(startup);
        fail(
          'Terminal bridge could not start. Run npm run bridge:build in aixand-server.',
        );
      });
      bridge.once('exit', () => {
        clearTimeout(startup);
        if (socket.readyState === WebSocket.OPEN)
          fail('Undercurrent bridge disconnected. Reconnect to resume.');
      });
      bridge.stdin.on('error', () => fail('Terminal bridge input closed.'));
      // Never log terminal content or inherit the browser credential.
      bridge.stderr.resume();
      bridge.stdout.setEncoding('utf8');
      bridge.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 2 * 1024 * 1024) {
          fail('Bridge output exceeds its limit');
          return;
        }
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const message = JSON.parse(line) as { type: string; id?: string };
            if (message.type === 'ready') {
              ready = true;
              clearTimeout(startup);
            }
            if (message.id) {
              clearTimeout(pending.get(message.id));
              pending.delete(message.id);
            }
            send(message);
          } catch {
            fail('Invalid terminal bridge response');
            return;
          }
        }
      });
    };
    start();
  }

  onApplicationShutdown() {
    for (const client of this.clients)
      client.close(1001, 'Server is shutting down');
  }
}
