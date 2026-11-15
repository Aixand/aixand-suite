import { Controller, Get, Inject, Module, Query, Req, Res, BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service.js';
import { FilesystemService } from './filesystem.service.js';

const query = z.object({ path: z.string().max(4096), base: z.string().max(4096).optional(), prefix: z.string().max(256).optional(),
  cursor: z.coerce.number().int().min(0).max(50000).optional(), limit: z.coerce.number().int().min(1).max(200).optional(),
  hidden: z.enum(['true', 'false']).optional(), suggest: z.enum(['true', 'false']).optional() }).strict();
@Controller('filesystem')
class FilesystemController {
  constructor(@Inject(AuthService) private auth: AuthService, @Inject(FilesystemService) private fs: FilesystemService) {}
  private authorize(request: Request, response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    if (!this.auth.session(request)) throw new UnauthorizedException('Sign in required');
  }
  @Get('locations')
  locations(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.authorize(request, response); return this.fs.locations();
  }
  @Get('directories')
  directories(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Query() value: unknown) {
    this.authorize(request, response);
    const parsed = query.safeParse(value);
    if (!parsed.success) throw new BadRequestException('Invalid directory request.');
    return this.fs.list({ ...parsed.data, hidden: parsed.data.hidden === 'true', suggest: parsed.data.suggest === 'true' });
  }
}
@Module({ controllers: [FilesystemController], providers: [FilesystemService], exports: [FilesystemService] })
export class FilesystemModule {}
