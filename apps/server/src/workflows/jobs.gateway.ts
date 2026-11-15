import { Inject, OnApplicationShutdown } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service.js';
import { RunnerError, runnerRequest } from './runner-client.js';
import { agentContextSchema } from '../agents/protocol.js';

const id = z.string().min(1).max(100);
const job = z.object({ id }).strict();
const page = job.extend({
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
});
const submissionSchema = z.object({ key: z.string().trim().min(1).max(256),
  workflow: z.record(z.string(), z.unknown()), inputs: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}).refine(
    (value) => value.agent_context === undefined || agentContextSchema.safeParse(value.agent_context).success,
  ) }).strict();
const command = z.discriminatedUnion('op', [
  z
    .object({
      id,
      op: z.literal('health'),
      args: z.object({}).strict().default({}),
    })
    .strict(),
  z
    .object({
      id,
      op: z.literal('submit'),
      args: z
        .object({
          submission: submissionSchema,
        })
        .strict(),
    })
    .strict(),
  z.object({ id, op: z.literal('events'), args: page }).strict(),
  ...(['result', 'cancel', 'resume', 'plan', 'hold', 'release', 'continuations', 'cancel_continuation', 'inspect'] as const).map((op) =>
    z.object({ id, op: z.literal(op), args: job }).strict(),
  ),
  z.object({ id, op: z.literal('amend'), args: job.extend({ key: z.string().min(1).max(256),
    expected_revision: z.number().int().min(1), workflow: z.record(z.string(), z.unknown()),
    authoring: z.record(z.string(), z.unknown()).optional() }).strict() }).strict(),
  z.object({ id, op: z.literal('continue'), args: job.extend({ key: z.string().min(1).max(256),
    target: submissionSchema, input_map: z.record(z.string(), z.string().max(2000)).default({}) }).strict() }).strict(),
  z.object({ id, op: z.literal('lookup'), args: z.object({ key: z.string().min(1).max(256) }).strict() }).strict(),
  z.object({ id, op: z.literal('list'), args: z.object({ after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(500).default(100) }).strict() }).strict(),
  z.object({ id, op: z.literal('runs'), args: z.object({ offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(500).default(100) }).strict() }).strict(),
  z.object({ id, op: z.literal('enable_edits'), args: job.extend({ key: z.string().min(1).max(256),
    authoring: z.record(z.string(), z.unknown()).optional(), groups: z.record(z.string(), z.array(z.string())).optional(),
    identities: z.record(z.string(), z.string()).optional() }).strict() }).strict(),
]);

@WebSocketGateway({
  path: '/api/workflow-jobs/ws',
  maxPayload: 4 * 1024 * 1024,
  perMessageDeflate: false,
})
export class WorkflowJobsGateway
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
    let alive = true;
    const pending = new Set<string>();
    const send = (message: unknown) => {
      if (socket.readyState !== WebSocket.OPEN || !this.auth.canSend(socket))
        return;
      if (socket.bufferedAmount > 2 * 1024 * 1024) {
        socket.close(1013, 'Workflow client is too slow');
        return;
      }
      socket.send(JSON.stringify(message));
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
      this.clients.delete(socket);
      // Durable jobs keep running when their browser disconnects.
    });
    this.auth.onMessage(socket, (raw, binary) => {
      let value: unknown;
      try {
        if (binary) throw new Error();
        value = JSON.parse(raw.toString());
      } catch {
        socket.close(1008, 'Expected JSON');
        return;
      }
      const parsed = command.safeParse(value);
      if (!parsed.success) {
        socket.close(1008, 'Invalid Runner request');
        return;
      }
      const { id: requestId, op, args } = parsed.data;
      if (pending.size >= 32 || pending.has(requestId)) {
        socket.close(1008, 'Too many requests or duplicate request ID');
        return;
      }
      pending.add(requestId);
      if ((op === 'submit' && 'submission' in args) || (op === 'continue' && 'target' in args)) {
        const submission = 'submission' in args ? args.submission : (args as { target: z.infer<typeof submissionSchema> }).target;
        const inherited = agentContextSchema.parse(submission.metadata.agent_context ?? {});
        const workflow = submission.workflow;
        const definition = typeof workflow.workflow === 'object' && workflow.workflow !== null
          ? workflow.workflow as Record<string, unknown> : workflow;
        const labels: Record<string, string> = { app: 'aixand-suite', feature: 'workflow', ...inherited.labels };
        if (typeof definition.name === 'string' && Buffer.byteLength(definition.name) <= 256 && !/\p{Cc}/u.test(definition.name)) {
          labels['workflow.name'] ??= definition.name;
        }
        submission.metadata.agent_context = {
          labels,
          metadata: { 'suite.submission_key': submission.key, ...inherited.metadata },
        };
      }
      void runnerRequest({ op, ...args })
        .then(
          (result) => send({ type: 'result', id: requestId, result }),
          (error: unknown) =>
            send({
              type: 'error',
              id: requestId,
              message:
                error instanceof Error
                  ? error.message
                  : 'Runner request failed',
              code:
                error instanceof RunnerError ? error.code : 'runner_connection',
              details: error instanceof RunnerError ? error.details : undefined,
            }),
        )
        .finally(() => pending.delete(requestId));
    });
    send({ type: 'ready' });
  }
  onApplicationShutdown() {
    for (const socket of this.clients)
      socket.close(1001, 'Server is shutting down');
  }
}
