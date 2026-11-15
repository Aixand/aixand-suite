import { BadRequestException, Body, Controller, Get, Inject, Module, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AgentsModule } from '../agents/agents.module.js';
import { FilesystemModule } from '../filesystem/filesystem.module.js';
import { OnboardingService } from './onboarding.service.js';
const startSchema = z.object({ manual: z.boolean().optional() }).strict();
const completeSchema = z.object({ expectedRevision: z.number().int().positive(), skipProjects: z.boolean() }).strict();
const reconcileSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Invalid onboarding request.');
  return result.data;
}
@Controller('auth/onboarding')
class OnboardingController {
  constructor(@Inject(OnboardingService) private service: OnboardingService) {}
  @Get('status')
  status(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store'); return this.service.status(request);
  }
  @Post('start')
  start(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: unknown) {
    response.setHeader('Cache-Control', 'no-store'); return this.service.start(request, parse(startSchema, body).manual);
  }
  @Post('complete')
  complete(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: unknown) {
    response.setHeader('Cache-Control', 'no-store'); const value = parse(completeSchema, body);
    return this.service.complete(request, value.expectedRevision, value.skipProjects);
  }
  @Post('reconcile')
  reconcile(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: unknown) {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.reconcile(request, parse(reconcileSchema, body).expectedRevision);
  }
}
@Module({ imports: [AgentsModule, FilesystemModule], controllers: [OnboardingController], providers: [OnboardingService] })
export class OnboardingModule {}
