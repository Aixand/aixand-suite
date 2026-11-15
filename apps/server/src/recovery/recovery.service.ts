import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { createLocalConnection } from '../local-ipc.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentPython } from '../agents/python.js';

export class RecoveryError extends Error {
  constructor(message: string, readonly code = 'unavailable') { super(message); }
}

@Injectable()
export class RecoveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private directory = mkdtempSync(join(tmpdir(), 'suite-recovery-'));
  readonly socketPath = join(this.directory, 'worker.sock');
  private child?: ChildProcessWithoutNullStreams;
  private startup?: Promise<void>;
  private stopping = false;
  private active = 0;
  private restart?: ReturnType<typeof setTimeout>;

  async onApplicationBootstrap() {
    await this.ready().catch((error: Error) => Logger.warn(error.message, 'RecoveryService'));
  }

  ready(): Promise<void> {
    if (this.startup) return this.startup;
    if (this.stopping) return Promise.reject(new RecoveryError('Recovery is stopping.'));
    const { python, env } = agentPython();
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    const child = spawn(python, ['-u', process.env.RECOVERY_WORKER_PATH ?? resolve('recovery-worker/main.py')], {
      env: { ...env, SUITE_RECOVERY_SOCKET: this.socketPath }, stdio: 'pipe',
    });
    this.child = child;
    this.startup = new Promise<void>((resolveReady, rejectReady) => {
      let buffer = '';
      let settled = false;
      const timer = setTimeout(() => fail(), 10_000);
      const fail = () => {
        clearTimeout(timer);
        if (this.child !== child) return;
        this.startup = undefined;
        this.child = undefined;
        if (!settled) rejectReady(new RecoveryError('Session recovery could not start. Check the server Python configuration.'));
        settled = true;
        if (child.exitCode === null && child.signalCode === null) {
          const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
          kill.unref();
          child.once('exit', () => clearTimeout(kill));
          child.kill('SIGTERM');
        }
        if (!this.stopping && !this.restart) this.restart = setTimeout(() => {
          this.restart = undefined;
          void this.ready().catch(() => {});
        }, 2000);
      };
      child.once('error', fail);
      child.once('exit', fail);
      child.stdin.on('error', fail);
      child.stderr.resume();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 4096) return fail();
        if (!buffer.includes('\n')) return;
        try {
          if (JSON.parse(buffer.split('\n')[0]).type !== 'ready') return fail();
          clearTimeout(timer);
          if (!settled) resolveReady();
          settled = true;
          buffer = '';
        } catch { fail(); }
      });
    });
    return this.startup;
  }

  async request(op: string, args: object): Promise<unknown> {
    if (this.active >= 24) throw new RecoveryError('Session recovery is busy. Try again shortly.');
    this.active++;
    try {
      await this.ready();
      return await new Promise((resolveResult, reject) => {
        const socket = createLocalConnection(this.socketPath);
        let buffer = '';
        const finish = (error?: Error, value?: unknown) => {
          socket.destroy();
          if (error) reject(error); else resolveResult(value);
        };
        socket.setTimeout(14_000, () => finish(new RecoveryError('Recovery request timed out. Check the existing terminal before retrying.')));
        socket.once('connect', () => socket.write(JSON.stringify({ op, args }) + '\n'));
        socket.once('error', () => finish(new RecoveryError('Session recovery is unavailable. Try again shortly.')));
        socket.once('end', () => { if (!buffer.includes('\n')) finish(new RecoveryError('Recovery response was interrupted.')); });
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          if (buffer.length > 2 * 1024 * 1024) return finish(new RecoveryError('Recovery response exceeded its limit.'));
          if (!buffer.includes('\n')) return;
          try {
            const message = JSON.parse(buffer.split('\n')[0]);
            finish(message.error ? new RecoveryError(message.error.message, message.error.code) : undefined, message.result);
          } catch { finish(new RecoveryError('Recovery returned an invalid response.')); }
        });
      });
    } finally { this.active--; }
  }

  async onApplicationShutdown() {
    this.stopping = true;
    if (this.restart) clearTimeout(this.restart);
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>((done) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
      child.once('exit', () => { clearTimeout(timer); done(); });
      child.kill('SIGTERM');
    });
    rmSync(this.directory, { recursive: true, force: true });
  }
}
