import { Inject, OnApplicationShutdown } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { AuthService } from '../auth/auth.service.js';
import { CarrierBridgeError, CarrierService } from './carrier.service.js';
import { parseRequest } from './protocol.js';
import { AgentsService } from '../agents/agents.service.js';
import { agentsRequestSchema } from '../agents/protocol.js';
import { randomUUID } from 'node:crypto';

@WebSocketGateway({
  path: '/api/carrier/ws',
  maxPayload: 1024 * 1024,
  perMessageDeflate: false,
})
export class CarrierGateway
  implements OnGatewayConnection, OnApplicationShutdown
{
  private readonly clients = new Set<WebSocket>();
  constructor(
    @Inject(CarrierService) private readonly carrier: CarrierService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AgentsService) private readonly agents: AgentsService,
  ) {
    this.agents.setCommandSource(async (operation, args) => {
      if (operation !== 'carrier-observations') throw new Error('Unsupported Command observation source.');
      const parsed = parseRequest({ id: randomUUID(), op: 'observations', args });
      return this.carrier.request(parsed.op, parsed.args);
    });
  }
  handleConnection(socket: WebSocket, request: IncomingMessage) {
    if (!this.auth.authorizeSocket(socket, request)) return;
    if (this.clients.size >= 8) {
      socket.close(1013, 'Carrier connection limit reached');
      return;
    }
    this.clients.add(socket);
    let authenticated = false;
    let alive = true;
    const active = new Set<string>();
    const send = (message: unknown) => {
      if (socket.readyState !== WebSocket.OPEN || !this.auth.canSend(socket))
        return;
      if (socket.bufferedAmount > 2 * 1024 * 1024) {
        socket.close(1013, 'Carrier client is too slow');
        return;
      }
      socket.send(JSON.stringify(message));
    };
    const unsubscribe = this.carrier.subscribe((message) => {
      if (authenticated) send(message);
    });
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
      unsubscribe();
      this.clients.delete(socket);
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
      if (!authenticated) {
        socket.close(1008, 'Connection is not ready');
        return;
      }
      let command: ReturnType<typeof parseRequest>;
      try {
        command = parseRequest(value);
      } catch {
        send({
          type: 'error',
          id:
            typeof value === 'object' &&
            value &&
            'id' in value &&
            typeof value.id === 'string'
              ? value.id
              : undefined,
          code: 'invalid_request',
          message: 'Invalid Carrier request',
        });
        return;
      }
      if (active.has(command.id) || active.size >= 16) {
        send({
          type: 'error',
          id: command.id,
          code: 'busy',
          message: 'Too many active Carrier requests or duplicate request ID',
        });
        return;
      }
      active.add(command.id);
      const execute = async () => {
        if (command.op === 'delegated_tasks' || command.op === 'delegated_task') {
          const response = await this.agents.request(agentsRequestSchema.parse({ id: randomUUID(),
            op: command.op === 'delegated_tasks' ? 'suite-delegated-tasks' : 'suite-delegated-task', args: command.args }));
          if (response.type !== 'result')
            throw new CarrierBridgeError(response.code ?? 'delegated_work_unavailable', response.message ?? 'Delegated work is unavailable.');
          return response.result;
        }
        if (command.op === 'launch' && 'projectId' in command.args && typeof command.args.projectId === 'string') {
          const projectId = command.args.projectId;
          const response = await this.agents.request({ id: randomUUID(), op: 'project-list', args: {} });
          if (response.type !== 'result' || !Array.isArray(response.result))
            throw new CarrierBridgeError('project_unavailable', 'Cannot resolve the registered project');
          const project = (response.result as { id: string; name: string; path: string }[]).find((row) => row.id === projectId);
          if (!project) throw new CarrierBridgeError('project_missing', 'Registered project not found');
          return this.carrier.request(command.op, { ...command.args, project: project.name, cwd: project.path });
        }
        return this.carrier.request(command.op, command.args);
      };
      void execute()
        .then((result) => send({ type: 'result', id: command.id, result }))
        .catch((error: Error) =>
          send({
            type: 'error',
            id: command.id,
            code:
              error instanceof CarrierBridgeError
                ? error.code
                : 'operation_failed',
            message: error.message,
          }),
        )
        .finally(() => active.delete(command.id));
    });
    void this.carrier
      .start()
      .then(() => {
        authenticated = true;
        send({ type: 'ready' });
      })
      .catch((error: Error) => {
        send({ type: 'fatal', message: error.message,
          code: error instanceof CarrierBridgeError ? error.code : 'adapter_failed',
          retryable: error instanceof CarrierBridgeError ? error.retryable : true });
        socket.close(1011, 'Carrier adapter unavailable');
      });
  }
  onApplicationShutdown() {
    for (const socket of this.clients) socket.close(1001, 'Server is stopping');
  }
}
