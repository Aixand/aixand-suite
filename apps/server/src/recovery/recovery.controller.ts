import { BadRequestException, Controller, Get, Header, HttpCode, Param, Post, Query, Body, Inject, ServiceUnavailableException, ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { RecoveryError, RecoveryService } from './recovery.service.js';

const identity = z.string().uuid();
const operation = z.object({ key: identity }).strict();
const filters = z.object({
  q: z.string().max(500).default(''), profile: z.string().max(200).default(''),
  project: z.string().max(500).default(''), cursor: z.string().regex(/^\d{0,7}$/).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(25), history: z.enum(['true', 'false']).optional(),
}).strict();

@Controller()
export class RecoveryController {
  constructor(@Inject(RecoveryService) private readonly recovery: RecoveryService) {}

  private async call(op: string, args: object) {
    try { return await this.recovery.request(op, args); }
    catch (error) {
      if (error instanceof RecoveryError && error.code === 'invalid') {
        if (error.message === 'Conversation was not found.') throw new NotFoundException(error.message);
        throw new ConflictException(error.message);
      }
      throw new ServiceUnavailableException(error instanceof RecoveryError ? error.message : 'Session recovery is unavailable.');
    }
  }

  @Get('recovery/sessions')
  @Header('Cache-Control', 'no-store')
  sessions(@Query() query: unknown) {
    const parsed = filters.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid recovery search.');
    const { q, history, ...rest } = parsed.data;
    return this.call('list', { ...rest, query: q, history: history === 'true' });
  }

  @Get('chats/:chatId/terminal')
  @Header('Cache-Control', 'no-store')
  status(@Param('chatId') chatId: string) {
    if (!identity.safeParse(chatId).success) throw new BadRequestException('Invalid conversation ID.');
    return this.call('status', { chatId });
  }

  @Post('chats/:chatId/terminal')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  open(@Param('chatId') chatId: string, @Body() body: unknown) {
    return this.mutate('open', chatId, body);
  }

  @Post('chats/:chatId/terminal/release')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  release(@Param('chatId') chatId: string, @Body() body: unknown) {
    return this.mutate('release', chatId, body);
  }

  private mutate(op: string, chatId: string, body: unknown) {
    const parsed = operation.safeParse(body);
    if (!identity.safeParse(chatId).success || !parsed.success) throw new BadRequestException('Invalid terminal recovery request.');
    return this.call(op, { chatId, key: parsed.data.key });
  }
}
