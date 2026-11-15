import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentPython } from '../agents/python.js';

type Reply = {
  type: string;
  id?: string;
  result?: unknown;
  code?: string;
  message?: string;
  version?: number;
  retryable?: boolean;
};
export class CarrierBridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = true,
  ) {
    super(message);
  }
}
@Injectable()
export class CarrierService implements OnApplicationShutdown {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private ready = false;
  private stopping = false;
  private readonly listeners = new Set<(message: Reply) => void>();
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  subscribe(listener: (message: Reply) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private fail(error: CarrierBridgeError) {
    this.ready = false;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners)
      listener({ type: 'fatal', code: error.code, message: error.message, retryable: error.retryable });
  }
  async start() {
    if (this.ready) return;
    if (this.starting) return this.starting;
    if (this.stopping)
      throw new CarrierBridgeError('shutdown', 'Carrier adapter is stopping');
    this.starting = new Promise<void>((resolveReady, rejectReady) => {
      const agents = agentPython();
      const python = process.env.CARRIER_PYTHON ?? agents.python;
      const child = spawn(
        python,
        [
          '-u',
          process.env.CARRIER_BRIDGE_PATH ?? resolve('carrier-bridge/main.py'),
        ],
        // Keep mailbox provisioning on the database served by the configured URL.
        // Pass the backend's explicit database/credential settings to the worker.
        {
          stdio: 'pipe', windowsHide: true,
          env: {
            ...process.env, ...agents.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
            PYTHONPATH: process.env.AIXAND_PACKAGED_RUNTIME === '1' ? '' : [
              agents.env.PYTHONPATH, process.env.PYTHONPATH,
            ].filter(Boolean).join(delimiter),
          },
        },
      );
      this.child = child;
      let buffer = '';
      let settled = false;
      let failed = false;
      let diagnostics = '';
      let missingModule: string | undefined;
      const rejectStartup = (error: CarrierBridgeError) => {
        if (failed) return;
        failed = true;
        if (!settled) {
          settled = true;
          clearTimeout(startup);
          rejectReady(error);
        }
        if (this.child === child) this.fail(error);
      };
      const startup = setTimeout(() => {
        rejectStartup(
          new CarrierBridgeError(
            'startup_timeout',
            'Carrier adapter startup timed out',
          ),
        );
        child.kill();
      }, 20_000);
      // Parse a bounded diagnostic tail; never expose raw stderr or credentials.
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        diagnostics = (diagnostics + chunk).slice(-8192);
        const match = diagnostics.match(/(?:^|\n)ModuleNotFoundError: No module named ['"]([a-zA-Z_][\w.]{0,255})['"](?:\r?\n|$)/);
        if (match) missingModule = match[1];
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 2 * 1024 * 1024) {
          rejectStartup(
            new CarrierBridgeError(
              'protocol',
              'Carrier adapter output exceeded its limit',
            ),
          );
          child.kill();
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let reply: Reply;
          try {
            reply = JSON.parse(line) as Reply;
          } catch {
            rejectStartup(
              new CarrierBridgeError(
                'protocol',
                'Carrier adapter returned invalid JSON',
              ),
            );
            child.kill();
            return;
          }
          if (reply.type === 'ready') {
            if (!settled) {
              settled = true;
              clearTimeout(startup);
              this.ready = true;
              resolveReady();
            }
          } else if (reply.type === 'fatal') {
            rejectStartup(
              new CarrierBridgeError(
                reply.code ?? 'adapter_failed',
                reply.message ?? 'Carrier adapter failed',
                reply.retryable ?? (reply.code !== 'configuration'),
              ),
            );
          } else if (reply.id) {
            const item = this.pending.get(reply.id);
            if (item) {
              clearTimeout(item.timer);
              this.pending.delete(reply.id);
              if (reply.type === 'error')
                item.reject(
                  new CarrierBridgeError(
                    reply.code ?? 'operation_failed',
                    reply.message ?? 'Carrier request failed',
                  ),
                );
              else item.resolve(reply.result);
            }
          } else {
            for (const listener of this.listeners) listener(reply);
          }
        }
      });
      child.on('error', () =>
        rejectStartup(
          new CarrierBridgeError(
            'missing_adapter',
            'Carrier adapter could not start. Set CARRIER_PYTHON to an environment containing Carrier and Aixand.',
            false,
          ),
        ),
      );
      child.stdin.on('error', () =>
        rejectStartup(
          new CarrierBridgeError(
            'adapter_closed',
            'Carrier adapter input closed; submitted mutations may need reconciliation',
          ),
        ),
      );
      // close follows stderr delivery; exit can arrive before the traceback.
      child.on('close', (code, signal) => {
        const error = missingModule && !settled
          ? new CarrierBridgeError(
              missingModule === 'fcntl' ? 'incompatible_platform' : 'missing_dependency',
              missingModule === 'fcntl'
                ? 'The installed Carrier bridge is incompatible with this platform. Update Aixand Suite and retry.'
                : `Carrier bridge is missing Python module "${missingModule}". Repair the Suite Python environment configured by CARRIER_PYTHON and retry.`,
              false,
            )
          : new CarrierBridgeError(
              'adapter_closed',
              `Carrier adapter stopped (${signal ? `signal ${signal}` : `exit code ${code}`}). Reconnect to inspect the saved outbox and agent bindings.`,
            );
        rejectStartup(error);
        if (this.child === child) this.child = undefined;
      });
    });
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  async request(op: string, args: object): Promise<unknown> {
    await this.start();
    if (!this.child || !this.ready)
      throw new CarrierBridgeError(
        'disconnected',
        'Carrier adapter is disconnected',
      );
    if (
      this.pending.size >= 32 ||
      this.child.stdin.writableLength > 1024 * 1024
    )
      throw new CarrierBridgeError('busy', 'Carrier adapter is busy');
    const id = randomUUID();
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new CarrierBridgeError(
              'effect_unknown',
              'Request timed out. Inspect the outbox or registered conversation before retrying.',
            ),
          );
        },
        ['launch', 'recover', 'stop_agent'].includes(op) ? 360_000 : 30_000,
      );
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, op, args }) + '\n');
    });
  }
  async onApplicationShutdown() {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolveDone) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        resolveDone();
      }, 20_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolveDone();
      });
      child.stdin.end();
      if (child.exitCode !== null) {
        clearTimeout(timeout);
        resolveDone();
      }
    });
  }
}
