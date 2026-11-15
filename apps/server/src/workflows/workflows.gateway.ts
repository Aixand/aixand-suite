import { platformEnvironment } from '../platform-environment.js';
import { Inject, OnApplicationShutdown } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { delimiter, dirname, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service.js';

const requestSchema = z
  .object({
    id: z.string().min(1).max(100),
    op: z.enum([
      'catalogs',
      'validate',
      'references',
      'example',
      'run',
      'cancel',
    ]),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

@WebSocketGateway({
  path: '/api/workflows/ws',
  maxPayload: 1024 * 1024,
  perMessageDeflate: false,
})
export class WorkflowsGateway
  implements OnGatewayConnection, OnApplicationShutdown
{
  private readonly clients = new Set<WebSocket>();
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  handleConnection(socket: WebSocket, request: IncomingMessage) {
    if (!this.auth.authorizeSocket(socket, request)) return;
    if (this.clients.size >= 8) {
      socket.close(1013, 'Workflow connection limit reached');
      return;
    }
    this.clients.add(socket);
    let bridge: ChildProcessWithoutNullStreams | undefined;
    let ready = false;
    let buffer = '';
    let alive = true;
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    const active = new Set<string>();
    const send = (message: unknown) => {
      if (socket.readyState !== WebSocket.OPEN || !this.auth.canSend(socket))
        return;
      if (socket.bufferedAmount > 2 * 1024 * 1024) {
        socket.close(1013, 'Workflow client is too slow');
        return;
      }
      socket.send(JSON.stringify(message));
    };
    const fail = (message: string) => {
      send({ type: 'fatal', message });
      socket.close(1011, 'Workflow connection ended');
    };
    let startup: ReturnType<typeof setTimeout> | undefined;
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
      clearTimeout(startup);
      clearInterval(heartbeat);
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      this.clients.delete(socket);
      if (bridge) {
        // EOF cancels the existing runner and awaits StopOwned scope cleanup.
        // Forced shutdown is a last resort and cannot promise rollback.
        const child = bridge;
        child.stdin.end();
        const kill = setTimeout(() => child.kill('SIGKILL'), 30_000);
        kill.unref();
        child.once('exit', () => clearTimeout(kill));
        if (child.exitCode !== null) clearTimeout(kill);
      }
    });
    this.auth.onMessage(socket, (raw, binary) => {
      if (binary) {
        socket.close(1008, 'Expected JSON');
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        socket.close(1008, 'Invalid JSON');
        return;
      }
      const parsed = requestSchema.safeParse(value);
      if (!parsed.success) {
        socket.close(1008, 'Invalid workflow request');
        return;
      }
      const command = parsed.data;
      if (!ready || !bridge) {
        send({
          type: 'error',
          id: command.id,
          message: 'Workflow connection is not ready',
        });
        return;
      }
      if (pending.has(command.id) || active.has(command.id)) {
        socket.close(1008, 'Duplicate request ID');
        return;
      }
      if (pending.size >= 64 || bridge.stdin.writableLength > 2 * 1024 * 1024) {
        fail('Workflow request queue is full');
        return;
      }
      if (command.op === 'run') {
        if (active.size) {
          send({
            type: 'error',
            id: command.id,
            message: 'A workflow is already running',
          });
          return;
        }
        active.add(command.id);
      } else {
        pending.set(
          command.id,
          setTimeout(() => fail('Workflow request timed out'), 15_000),
        );
      }
      bridge.stdin.write(JSON.stringify(command) + '\n');
    });
    const start = () => {
      const env: NodeJS.ProcessEnv = { ...platformEnvironment(),
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      };
      for (const key of [
        'UNDERCURRENT_HOME',
        'AGENT_MANAGER_HOME',
        'AGENT_MANAGER_CONFIG',
        'AGENT_MANAGER_LABELS',
        'AGENT_MANAGER_METADATA',
        'WORKFLOW_CATALOG_PATHS',
      ]) {
        if (process.env[key]) env[key] = process.env[key];
      }
      if (process.env.WORKFLOW_SDK_CONFIG)
        env.WORKFLOW_SDK_CONFIG = resolve(process.env.WORKFLOW_SDK_CONFIG);
      if (process.env.WORKFLOW_PYTHON_BIN)
        env.PATH = `${resolve(process.env.WORKFLOW_PYTHON_BIN)}${delimiter}${env.PATH ?? ''}`;
      if (process.env.AIXAND_PACKAGED_RUNTIME === '1' && process.env.AGENTS_PYTHON) {
        env.PYTHONHOME = process.env.WORKFLOW_PYTHON_HOME || dirname(dirname(process.env.AGENTS_PYTHON));
        env.PYTHONNOUSERSITE = '1';
        env.PYTHONDONTWRITEBYTECODE = '1';
        for (const key of ['SERVER_MANAGER_HOME', 'MCP_MANAGER_HOME', 'PROMPT_MANAGER_HOME', 'SKILL_MANAGER_HOME',
          'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'CARRIER_URL', 'CARRIER_DATABASE'])
          if (process.env[key]) env[key] = process.env[key];
      }
      bridge = spawn(
        process.env.WORKFLOW_BRIDGE_PATH ??
          resolve('workflow-bridge/target/debug/aixand-workflow-bridge'),
        [],
        {
          cwd: process.env.WORKFLOW_CWD ?? resolve('../../workflow/ir'),
          env,
          stdio: 'pipe',
        },
      );
      startup = setTimeout(
        () => fail('Workflow bridge startup timed out'),
        15_000,
      );
      bridge.once('error', () =>
        fail(
          'Workflow bridge could not start. Build it with npm run workflow:build in apps/server.',
        ),
      );
      bridge.once('exit', () => {
        if (socket.readyState === WebSocket.OPEN)
          fail(
            'Workflow bridge disconnected. Execution may be incomplete; it was not retried.',
          );
      });
      bridge.stdin.on('error', () => fail('Workflow bridge input closed'));
      bridge.stderr.resume(); // Never log workflow input or private SDK configuration.
      bridge.stdout.setEncoding('utf8');
      bridge.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 4 * 1024 * 1024) {
          fail('Workflow bridge output exceeds its limit');
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
            if (message.id && message.type !== 'run-event') {
              clearTimeout(pending.get(message.id));
              pending.delete(message.id);
              active.delete(message.id);
            }
            send(message);
          } catch {
            fail('Invalid workflow bridge response');
            return;
          }
        }
      });
    };
    start();
  }
  onApplicationShutdown() {
    for (const socket of this.clients)
      socket.close(1001, 'Server is shutting down');
  }
}
