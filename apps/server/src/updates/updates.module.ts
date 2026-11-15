import { BadRequestException, Body, Controller, Get, Header, Inject, Injectable, Module, OnModuleDestroy, OnModuleInit, Post } from '@nestjs/common';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const execute = promisify(execFile);
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('check') }).strict(),
  z.object({ action: z.enum(['plan', 'download']), components: z.array(z.enum(['server', 'web', 'vox', 'connect', 'desktop', 'orchestration-mcp', 'runner', 'ir', 'runner-client', 'python-sdk'])).min(1).max(10).refine(ids => new Set(ids).size === ids.length).optional() }).strict(),
  z.object({ action: z.literal('settings'), daily: z.boolean().optional(), automaticDownload: z.boolean().optional() }).strict().refine(v => v.daily !== undefined || v.automaticDownload !== undefined),
  z.object({ action: z.literal('install'), confirmed: z.literal(true), revision: z.string().regex(/^[a-f0-9]{64}$/),
    restartConsent: z.literal(true), acceptedLicenses: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(640) }).strict(),
]);

@Injectable()
export class UpdatesService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private async runtime() {
    const root = process.env.AIXAND_PRODUCT_RUNTIME;
    if (process.env.AIXAND_PACKAGED_RUNTIME !== '1' || !root || !isAbsolute(root)) return null;
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    return { file: join(root, 'runtime.mjs'), role: manifest.installation?.role, version: manifest.version || '0.1.0-beta' };
  }
  private async call(action: string, input = {}, application = false) {
    const runtime = await this.runtime();
    if (!runtime) return { available: false, message: 'Installer updates are unavailable in source development mode.' };
    if (runtime.role !== 'server') return { available: false, installed: { role: runtime.role, version: runtime.version },
      message: 'Manage Desktop updates from the Aixand connection window on that computer.' };
    const result = await execute(process.execPath, [runtime.file, application ? 'updates' : 'component-updates', action, JSON.stringify(input)],
      { env: process.env, timeout: 35_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const value = JSON.parse(result.stdout);
    if (!application && action === 'plan') return { revision: value.revision, ready: value.ready, requested: value.requested,
      candidates: Object.fromEntries(Object.entries(value.candidates || {}).map(([id, item]: [string, any]) => [id, { version: item.version, requires: item.requires }])),
      licenses: value.licenses, restartRequired: value.restartRequired, unsupported: value.unsupported,
      blockers: (value.blockers || []).map((item: any) => ({ name: typeof item.name === 'string' ? item.name : 'Active workspace work' })) };
    return value;
  }
  async status(application = false) { return this.call('status', {}, application); }
  async plan(application = false) { return this.call('plan', {}, application); }
  async action(value: unknown, application = false) {
    const parsed = request.safeParse(value);
    if (!parsed.success) throw new BadRequestException('Invalid update request.');
    const { action, ...input } = parsed.data;
    if (action === 'download' || action === 'check' && !application) {
      if (this.busy) throw new BadRequestException('An update operation is already running.');
      const runtime = await this.runtime();
      if (!runtime && action === 'check') return this.call('status');
      if (runtime?.role !== 'server') throw new BadRequestException('Manage this installation from its Desktop connection window.');
      this.busy = true;
      const child = spawn(process.execPath, [runtime.file, application ? 'updates' : 'component-updates', action, JSON.stringify(input)], { env: process.env, windowsHide: true, stdio: 'ignore' });
      child.once('error', () => { this.busy = false; });
      child.once('close', () => { this.busy = false; });
      return { started: true };
    }
    try { return await this.call(action, input, application); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : 'The update operation failed.'); }
  }
  private async due() {
    if (this.busy) return;
    const runtime = await this.runtime();
    if (runtime?.role !== 'server' || this.busy) return;
    this.busy = true;
    const child = spawn(process.execPath, [runtime.file, 'component-updates', 'due', '{}'], { env: process.env, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => { this.busy = false; });
    child.once('close', () => { this.busy = false; });
  }
  onModuleInit() {
    const check = () => { void this.due().catch(() => {}); };
    // Installed services perform overdue checks without a separate scheduler.
    check(); this.timer = setInterval(check, 60 * 60_000); this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}

// Authentication, exact Origin and CSRF checks are enforced by configureApp.
@Controller('updates')
class UpdatesController {
  constructor(@Inject(UpdatesService) private updates: UpdatesService) {}
  @Get() @Header('Cache-Control', 'no-store') status() { return this.updates.status(); }
  @Get('plan') @Header('Cache-Control', 'no-store') plan() { return this.updates.plan(); }
  @Get('application') @Header('Cache-Control', 'no-store') applicationStatus() { return this.updates.status(true); }
  @Get('application/plan') @Header('Cache-Control', 'no-store') applicationPlan() { return this.updates.plan(true); }
  @Post('application') applicationAction(@Body() value: unknown) { return this.updates.action(value, true); }
  @Post() action(@Body() value: unknown) { return this.updates.action(value); }
}
@Module({ controllers: [UpdatesController], providers: [UpdatesService] })
export class UpdatesModule {}
