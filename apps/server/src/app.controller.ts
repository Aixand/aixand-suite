import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { authDatabasePath } from './auth/config.js';
import { voiceEnabled } from './capabilities.js';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('capabilities')
  @Header('Cache-Control', 'no-store')
  getCapabilities() {
    return { voice: voiceEnabled() };
  }

  @Get('health')
  @Header('X-Aixand-Protocol', '1')
  getHealth(@Res({ passthrough: true }) response?: Response) {
    response?.setHeader('X-Aixand-Workspace', createHash('sha256').update(authDatabasePath()).digest('hex'));
    return this.appService.getHealth();
  }
}
