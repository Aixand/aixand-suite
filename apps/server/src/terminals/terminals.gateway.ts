import { platformEnvironment } from '../platform-environment.js';
import { Inject, OnApplicationShutdown } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { commandSchema } from './protocol.js';
import { TerminalOutbound } from './outbound.js';

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
    let lastBridgeFrame = Date.now();
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    const outbound = new TerminalOutbound(socket, () =>
      this.auth.canSend(socket),
    );
    const send = (message: unknown) => outbound.send(message);
    const fail = (message: string) => {
      send({ type: 'fatal', message });
      socket.close(1011, 'Terminal connection ended');
    };
    const heartbeat = setInterval(() => {
      if (ready && Date.now() - lastBridgeFrame > 20_000) {
        fail(
          'The terminal bridge stopped responding. Reconnecting will restore your display.',
        );
        return;
      }
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
      outbound.close();
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
          code: 'backend_recovering',
          submission: 'not_sent',
          retryable: true,
          message: 'Undercurrent is not connected yet.',
        });
        return;
      }
      if (pending.has(id)) {
        socket.close(1008, 'Duplicate request ID');
        return;
      }
      if (op !== 'ack') {
        if (
          pending.size >= (['input', 'resize', 'detach'].includes(op) ? 32 : 28)
        ) {
          send({
            type: 'error',
            id,
            code: 'overloaded',
            submission: 'not_sent',
            retryable: true,
            message: 'Too many pending requests.',
          });
          return;
        }
        pending.set(
          id,
          setTimeout(
            () => {
              pending.delete(id);
              const mutation =
                [
                  'input',
                  'resize',
                  'create',
                  'stop',
                  'restart',
                  'remove',
                  'clean',
                  'set-my-terminal',
                ].includes(op) || op.startsWith('group-');
              send({
                type: 'error',
                id,
                operation: op,
                code: 'timeout',
                submission: 'unknown',
                retryable: true,
                message: mutation
                  ? 'The action timed out. Delivery may be uncertain; it was not retried.'
                  : 'The terminal request timed out.',
              });
            },
            ['clean', 'group-restore', 'group-reconcile'].includes(op)
              ? 63_000
              : 14_000,
          ),
        );
      }
      if (op !== 'ack' && bridge.stdin.writableLength > 64 * 1024) {
        clearTimeout(pending.get(id));
        pending.delete(id);
        send({
          type: 'error',
          id,
          code: 'overloaded',
          submission: 'not_sent',
          retryable: true,
          message: 'The terminal bridge is busy. The request was not sent.',
        });
        return;
      }
      if (bridge.stdin.writableLength > 256 * 1024) {
        fail('Terminal bridge input exceeded its budget.');
        return;
      }
      bridge.stdin.write(JSON.stringify(command.data) + '\n');
    });
    const start = () => {
      const env: NodeJS.ProcessEnv = {
        ...platformEnvironment(),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      };
      for (const key of [
        'UNDERCURRENT_HOME',
        'TERMINAL_SHELL',
        'TERMINAL_CWD',
        'AIXAND_SUITE_INSTANCE_ID',
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
          'Terminal bridge could not start. Run npm run bridge:build in apps/server.',
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
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line.length > 8 * 1024 * 1024) {
            fail('Bridge output exceeds its limit');
            return;
          }
          try {
            const message = JSON.parse(line) as { type: string; id?: string };
            lastBridgeFrame = Date.now();
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
        if (buffer.length > 8 * 1024 * 1024)
          fail('Bridge output exceeds its limit');
      });
    };
    start();
  }

  onApplicationShutdown() {
    for (const client of this.clients)
      client.close(1001, 'Server is shutting down');
  }
}
