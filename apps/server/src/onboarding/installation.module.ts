import { BadRequestException, Body, Controller, Get, Inject, Injectable, Module, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service.js';

const execute = promisify(execFile);
const input = z.object({ acceptedLicenses: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(32),
  terminalPolicy: z.enum(['keep', 'prefer']).optional() }).strict();

@Injectable()
export class InstallationService {
  private child?: ChildProcess;
  private failure = '';

  private runtime() {
    const root = process.env.AIXAND_PRODUCT_RUNTIME;
    if (process.env.AIXAND_PACKAGED_RUNTIME !== '1' || !root) return null;
    if (!isAbsolute(root)) throw new ServiceUnavailableException('Invalid installed runtime location.');
    return join(root, 'runtime.mjs');
  }

  async status(): Promise<Record<string, unknown>> {
    const runtime = this.runtime();
    if (!runtime) return { available: false, ready: true };
    try {
      const result = await execute(process.execPath, [runtime, 'setup', 'products'], {
        env: process.env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      return { ...JSON.parse(result.stdout), starting: Boolean(this.child), launchError: this.failure };
    } catch {
      throw new ServiceUnavailableException('Could not inspect the included product installers.');
    }
  }

  async install(value: unknown) {
    const parsed = input.safeParse(value);
    if (!parsed.success) throw new BadRequestException('Invalid product installation request.');
    const runtime = this.runtime();
    if (!runtime) throw new BadRequestException('This Suite does not include product installers.');
    const status = await this.status();
    if (this.child) return { started: true };
    const licenses = status.licenses as { sha256: string }[] | undefined;
    if (!licenses || licenses.some(row => !parsed.data.acceptedLicenses.includes(row.sha256)))
      throw new BadRequestException('Review and accept the included product terms.');
    this.failure = '';
    const child = spawn(process.execPath, [runtime, 'setup', 'install', JSON.stringify(parsed.data)], {
      env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    let diagnostic = '';
    child.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
    child.once('error', () => { if (this.child === child) { this.failure = 'Could not start product installation. Retry setup.'; this.child = undefined; } });
    child.once('close', code => {
      if (this.child === child) {
        if (code !== 0) this.failure = diagnostic || 'Installation was interrupted. Retry to resume.';
        this.child = undefined;
      }
    });
    return { started: true };
  }

  async commands(): Promise<Record<string, unknown>> {
    const runtime = this.runtime();
    if (!runtime) return { commands: [], userPathSupported: false };
    try {
      const result = await execute(process.execPath, [runtime, 'setup', 'commands'], {
        env: process.env, windowsHide: true, timeout: 65_000, maxBuffer: 1024 * 1024,
      });
      return JSON.parse(result.stdout);
    } catch {
      throw new ServiceUnavailableException('Could not check terminal commands. Retry the check.');
    }
  }
}

@Controller('auth/installation')
class InstallationController {
  constructor(@Inject(AuthService) private auth: AuthService, @Inject(InstallationService) private installation: InstallationService) {}
  @Get('status')
  status(@Req() request: Request) {
    if (!this.auth.session(request)) throw new UnauthorizedException('Sign in required');
    return this.installation.status();
  }
  @Post('install')
  install(@Req() request: Request, @Body() body: unknown) {
    this.auth.assertOnboardingMutation(request);
    return this.installation.install(body);
  }
  @Get('commands')
  commands(@Req() request: Request) {
    if (!this.auth.session(request)) throw new UnauthorizedException('Sign in required');
    return this.installation.commands();
  }
}

@Module({ controllers: [InstallationController], providers: [InstallationService] })
export class InstallationModule {}
