import { z } from 'zod';
import { mcpSelectionSchema } from '../agents/protocol.js';

const mailbox = z.string().min(1).max(100).default('user');
const page = {
  mailbox,
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(10_000_000).default(0),
};
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const key = z.string().min(1).max(160);
const query = z
  .object({
    ...page,
    view: z
      .enum(['Inbox', 'Unread', 'Pending', 'Archived', 'Sent', 'All'])
      .default('Inbox'),
    search: z.string().max(300).default(''),
  })
  .strict();
const schemas = {
  status: z.object({}).strict(),
  mailboxes: z.object({}).strict(),
  observations: z.object({ mailbox, after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    instance: z.string().min(1).max(200).nullable().optional(), tail: z.boolean().default(false) }).strict(),
  snapshot: query,
  messages: query,
  message_search: z.object({ ...page, search: z.string().max(300).default('') }).strict(),
  message_get: z.object({ mailbox, id, instance: z.string().min(1).max(200) }).strict(),
  directory: z
    .object({
      mailbox,
      after: z.string().max(200).default(''),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  conversation: z.object({ ...page, id }).strict(),
  send: z
    .object({
      mailbox,
      key,
      to: z.string().min(1).max(200),
      content: z.string().min(1).max(100_000),
      reply_to: id.optional(),
    })
    .strict(),
  set_message_state: z
    .object({
      mailbox,
      id,
      read: z.boolean().optional(),
      archived: z.boolean().optional(),
    })
    .strict()
    .refine((args) => args.read !== undefined || args.archived !== undefined),
  acknowledge: z.object({ mailbox, id }).strict(),
  outbox: z.object(page).strict(),
  agent_profiles: z.object({}).strict(),
  runs: z.object({}).strict(),
  delete_run: z.object({ key }).strict(),
  launch: z
    .object({
      key,
      provider: z.string().min(1).max(80).default('codex'),
      profile: z.string().min(1).max(100),
      model: z.string().trim().min(1).max(256).optional(),
      prompt: z.string().min(1).max(100_000),
      instructions: z.string().max(20_000).default(''),
      project: z.string().max(200).default(''),
      projectId: z.string().uuid().optional(),
      mcp: mcpSelectionSchema.optional(),
      mode: z.enum(['chat', 'work']).default('work'),
    })
    .strict(),
  recover: z.object({ key }).strict(),
  stop_agent: z.object({ key }).strict(),
};
export const envelopeSchema = z
  .object({
    id: z.string().min(1).max(100),
    op: z.enum(
      Object.keys(schemas) as [
        keyof typeof schemas,
        ...Array<keyof typeof schemas>,
      ],
    ),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export function parseRequest(value: unknown) {
  const request = envelopeSchema.parse(value);
  return { ...request, args: schemas[request.op].parse(request.args) };
}
