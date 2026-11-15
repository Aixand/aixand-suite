import { Inject, type OnApplicationShutdown } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayConnection } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { AgentsService } from './agents.service.js';
import { agentsRequestSchema } from './protocol.js';
import { AuthService } from '../auth/auth.service.js';

@WebSocketGateway({
  path: '/api/agents/ws',
  maxPayload: 1024 * 1024,
  perMessageDeflate: false,
})
export class AgentsGateway
  implements OnGatewayConnection, OnApplicationShutdown
{
  private readonly clients = new Set<WebSocket>();
  constructor(
    @Inject(AgentsService) private readonly service: AgentsService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  handleConnection(socket: WebSocket, request: IncomingMessage) {
    if (!this.auth.authorizeSocket(socket, request)) return;
    if (this.clients.size >= 8) {
      socket.close(1013, 'Agent connection limit reached');
      return;
    }
    this.clients.add(socket);
    const voiceOwner = randomUUID();
    let authenticated = false;
    let alive = true;
    const pending = new Map<string, string>();
    // Retain responses per connection so duplicate mutation IDs cannot replay effects.
    const completed = new Map<
      string,
      { signature: string; message: unknown }
    >();
    const send = (message: unknown) => {
      if (socket.readyState !== WebSocket.OPEN || !this.auth.canSend(socket))
        return;
      if (socket.bufferedAmount > 2 * 1024 * 1024) {
        socket.close(1013, 'Agent client is too slow');
        return;
      }
      socket.send(JSON.stringify(message));
    };
    const unsubscribe = this.service.subscribe((message) => {
      if (message.type === 'chat-voice-event') {
        if (authenticated && message.voiceOwner === voiceOwner) {
          const { voiceOwner: _owner, ...publicMessage } = message;
          send(publicMessage);
        }
        return;
      }
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
      this.clients.delete(socket);
      unsubscribe();
      this.service.releaseVoice(voiceOwner);
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
      const parsed = agentsRequestSchema.safeParse(value);
      if (!parsed.success) {
        socket.close(1008, 'Invalid agent request');
        return;
      }
      const command = parsed.data;
      const signature = createHash('sha256')
        .update(JSON.stringify(command))
        .digest('hex');
      const previous = completed.get(command.id);
      if (previous) {
        if (previous.signature !== signature) {
          socket.close(1008, 'Request ID reused with different arguments');
          return;
        }
        send(previous.message);
        return;
      }
      if (pending.has(command.id)) {
        if (pending.get(command.id) !== signature) {
          socket.close(1008, 'Request ID reused with different arguments');
          return;
        }
        send({
          type: 'error',
          id: command.id,
          code: 'pending',
          message: 'This request is still pending; it was not replayed.',
        });
        return;
      }
      if (pending.size >= 16 || completed.size >= 4096) {
        send({
          type: 'error',
          id: command.id,
          code: 'busy',
          message:
            'Agent connection request limit reached. Reconnect and refresh.',
        });
        return;
      }
      pending.set(command.id, signature);
      void this.service
        .request(command, command.op.startsWith('chat-voice-') ? voiceOwner : undefined)
        .then((message) => {
          pending.delete(command.id);
          if (
            [
              'connect-configure',
              'connect-pair',
              'connect-forget',
              'connect-send',
              'connect-cancel',
              'create-profile',
              'agent-profile-update',
              'agent-profile-check',
              'delete-profile',
              'agent-operation-start',
              'agent-operation-cancel',
              'agent-operation-resolve',
              'rename-login',
              'remove-login',
              'rename-profile',
              'duplicate-profile',
              'switch-auth',
              'set-model',
              'sdk-credential-save', 'sdk-credential-assign', 'sdk-auth-configure',
              'launch',
              'stop',
              'chat-create',
              'chat-send',
              'chat-steer',
              'chat-queue',
              'chat-queue-edit',
              'chat-queue-remove',
              'chat-queue-resume',
              'chat-interrupt',
              'chat-answer',
              'chat-background-stop',
              'chat-detach',
              'chat-delete',
              'chat-delete-stop',
              'connect-activity-stop',
              'workflow-run-action',
              'workspace-reset',
              'chat-workflow-start', 'chat-workflow-prepare',
              'chat-workflow-cancel',
              'chat-workflow-resume',
              'chat-workflow-amend', 'chat-workflow-continue', 'chat-workflow-hold', 'chat-workflow-release',
              'chat-workflow-enable-edits',
              'chat-terminal-open',
              'chat-terminal-release',
              'chat-voice-start',
              'chat-voice-stop',
              'mcp-chat-reconnect',
              'suite-tools-refresh',
              'suite-mcp-context',
              'project-create',
              'project-remove',
              'project-discovery-start',
              'project-discovery-cancel',
              'project-discovery-filter',
              'project-import',
              'skills-source-register', 'skills-source-unregister', 'skills-create', 'skills-save', 'skills-release', 'skills-profile-set', 'profile-resources-set',
              'prompts-source-register', 'prompts-source-unregister', 'prompts-application-register', 'prompts-application-set', 'prompts-application-unregister',
              'mcp-configure',
              ...['prompts', 'skills', 'mcp'].flatMap(kind => ['source-job-start', 'source-cancel', 'source-settings', 'source-check-due'].map(action => `${kind}-managed-${action}`)),
              'mcp-managed-bootstrap',
              'mcp-managed-ensure',
              'mcp-managed-adopt',
              'mcp-managed-save',
              'mcp-managed-apply',
              'mcp-managed-rollback',
              'mcp-managed-tracking',
              'mcp-managed-prepare',
              'mcp-managed-refresh',

              'prompts-save',
              'prompts-release',
              'prompts-bind',
              'prompts-unbind',
              ...['prompts', 'skills'].flatMap(kind => ['ensure', 'adopt', 'save', 'apply', 'rollback', 'tracking', 'release', 'upload-start', 'upload-chunk', 'upload-finish', 'upload-cancel'].map(action => `${kind}-managed-${action}`)),
            ].includes(command.op)
          )
            completed.set(command.id, { signature, message });
          send(message);
        })
        .catch(() => {
          pending.delete(command.id);
          send({
            type: 'error',
            id: command.id,
            code: 'unavailable',
            message:
            'Agent operation interrupted. Refresh agents and check Terminals before retrying a launch.',
          });
        });
    });
    void this.service
      .ready()
      .then(() => {
        authenticated = true;
        send({ type: 'ready', capabilities: { backgroundActivity: true } });
      })
      .catch((error: unknown) => {
        send({
          type: 'fatal',
          message:
            error instanceof Error
              ? error.message
              : 'Agent bridge unavailable.',
        });
        socket.close(1011, 'Agent bridge unavailable');
      });
  }
  onApplicationShutdown() {
    for (const client of this.clients)
      client.close(1001, 'Server shutting down');
  }
}
