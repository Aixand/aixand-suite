import { z } from 'zod';

const groupName = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[A-Za-z0-9_-]+$/);
const paneId = z.string().uuid().optional();
const sessionId = z.string().min(1).max(200);
const dimensions = {
  columns: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
};
const envelope = { id: z.string().uuid() };
export const commandSchema = z.discriminatedUnion('op', [
  z
    .object({
      ...envelope,
      op: z.literal('watch-open'),
      args: z
        .object({ sessionIds: z.array(sessionId).min(1).max(16) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('clean'),
      args: z.object({ confirmed: z.literal(true) }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('set-my-terminal'),
      args: z.object({ sessionId, myTerminal: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('stop'),
      args: z.object({ sessionId, force: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('restart'),
      args: z.object({ sessionId, force: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('remove'),
      args: z.object({ sessionId, confirmed: z.literal(true) }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('groups'),
      args: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('group-create'),
      args: z
        .object({
          name: groupName,
          cwd: z.string().min(1).max(4096).optional(),
          shell: z.string().min(1).max(4096).optional(),
          persistent: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('group-delete'),
      args: z.object({ group: groupName }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('group-reconcile'),
      args: z.object({ group: groupName }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('group-assign'),
      args: z
        .object({
          sessionId,
          from: groupName.nullable(),
          to: groupName.nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('group-restore'),
      args: z
        .object({
          group: groupName,
          sessionId,
          ...dimensions,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('inspect'),
      args: z.object({ sessionId }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('events'),
      args: z.object({ sessionId }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('watch'),
      args: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('watch-events'),
      args: z
        .object({
          sessionId,
          after: z
            .string()
            .regex(/^\d{1,20}$/)
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('unwatch'),
      args: z.object({ kind: z.enum(['sessions', 'events', 'open']) }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('list'),
      args: z
        .object({ cursor: z.string().max(4096).nullable().optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('create'),
      args: z
        .object({
          name: z
            .string()
            .trim()
            .min(1)
            .max(80)
            .regex(/^[\w .-]+$/),
          group: groupName.optional(),
          ...dimensions,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('attach'),
      args: z
        .object({
          sessionId,
          paneId,
          offset: z
            .string()
            .regex(/^\d{1,20}$/)
            .optional(),
          screen: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('detach'),
      args: z.object({ paneId }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('input'),
      args: z
        .object({
          sessionId,
          data: z
            .string()
            .min(4)
            .max(44_000)
            .regex(
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            ),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('resize'),
      args: z.object({ sessionId, ...dimensions }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal('ack'),
      args: z
        .object({
          stream: z.string().min(1).max(200),
          sequence: z.string().regex(/^\d{1,20}$/),
        })
        .strict(),
    })
    .strict(),
]);
