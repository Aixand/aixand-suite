import { Inject, type OnApplicationShutdown } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayConnection } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service.js';
import { VoxService } from './vox.service.js';

const envelope = { id: z.string().uuid() };
const sessionId = z.string().uuid();
const request = <T extends z.ZodRawShape>(op: string, args: T) =>
  z.object({ ...envelope, op: z.literal(op), args: z.object(args).strict() }).strict();
export const voxRequestSchema = z.union([
  request('start', { key: sessionId, profile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).max(128).nullable() }),
  request('text', { sessionId, text: z.string().trim().min(1).max(16000) }),
  request('offer', { sessionId, type: z.literal('offer'), sdp: z.string().startsWith('v=0').max(48000) }),
  request('audio-stop', { sessionId }), request('interrupt', { sessionId }), request('end', { sessionId }),
  request('wake-offer', { key: sessionId, type: z.literal('offer'), sdp: z.string().startsWith('v=0').max(48000), debug: z.boolean().optional() }),
  request('wake-stop', { key: sessionId }),
  request('wake-debug', { key: sessionId, enabled: z.boolean() }),
]);

@WebSocketGateway({ path: '/api/vox/ws', maxPayload: 64 * 1024, perMessageDeflate: false })
export class VoxGateway implements OnGatewayConnection, OnApplicationShutdown {
  private readonly clients = new Set<WebSocket>();
  constructor(@Inject(VoxService) private readonly service: VoxService, @Inject(AuthService) private readonly auth: AuthService) {}
  handleConnection(socket: WebSocket, request: IncomingMessage) {
    if (!this.auth.authorizeSocket(socket, request)) return;
    if (this.clients.size >= 4) { socket.close(1013, 'Vox connection limit reached'); return; }
    this.clients.add(socket);
    const owner = randomUUID();
    let ready = false, alive = true;
    const pending = new Set<string>();
    const completed = new Map<string, { signature: string; message: unknown }>();
    const send = (message: unknown) => {
      if (socket.readyState !== WebSocket.OPEN || !this.auth.canSend(socket)) return;
      if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1013, 'Vox client is too slow'); return; }
      socket.send(JSON.stringify(message));
    };
    const unsubscribe = this.service.subscribe((message) => {
      if (message.type === 'fatal') { send(message); socket.close(1011, 'Vox unavailable'); }
      else if (ready && message.owner === owner) {
        const { owner: _privateOwner, ...event } = message;
        send(event);
      }
    });
    const heartbeat = setInterval(() => { if (!alive) socket.terminate(); else { alive = false; socket.ping(); } }, 15000);
    socket.on('pong', () => { alive = true; });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => { clearInterval(heartbeat); unsubscribe(); this.clients.delete(socket); this.service.release(owner); });
    this.auth.onMessage(socket, (raw, binary) => {
      if (binary || !ready) { socket.close(1008, 'Expected a ready JSON connection'); return; }
      let value: unknown;
      try { value = JSON.parse(raw.toString()); } catch { socket.close(1008, 'Invalid JSON'); return; }
      const parsed = voxRequestSchema.safeParse(value);
      if (!parsed.success) { socket.close(1008, 'Invalid Vox request'); return; }
      const command = parsed.data, signature = JSON.stringify(command);
      const old = completed.get(command.id);
      if (old) {
        if (old.signature !== signature) { socket.close(1008, 'Request ID reused'); return; }
        send(old.message); return;
      }
      if (pending.has(command.id) || pending.size >= 8 || completed.size >= 4096) {
        send({ type: 'error', id: command.id, message: 'Vox request is already pending or the connection is busy.' }); return;
      }
      pending.add(command.id);
      void this.service.request(owner, command).then((message) => {
        pending.delete(command.id); completed.set(command.id, { signature, message }); send(message);
      }).catch(() => {
        pending.delete(command.id); send({ type: 'error', id: command.id, message: 'Vox request failed. Inspect its state before retrying.' });
      });
    });
    void this.service.ready().then(() => { ready = true; send({ type: 'ready' }); }).catch((error: unknown) => {
      send({ type: 'fatal', message: error instanceof Error ? error.message : 'Vox unavailable.' });
      socket.close(1011, 'Vox unavailable');
    });
  }
  onApplicationShutdown() { for (const socket of this.clients) socket.close(1001, 'Server shutting down'); }
}
