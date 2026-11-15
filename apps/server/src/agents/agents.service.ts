import { Inject, Optional, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentsRequest } from './protocol.js';
import { agentPython } from './python.js';
import { RecoveryService } from '../recovery/recovery.service.js';

export type BridgeMessage = {
  type: 'resources-changed' | 'backend-discovery-updated' | 'command-updated' | 'command-activity' | 'command-source-request' | 'connect-activity-updated' | 'connect-project-updated' | 'connect-transfer-updated' | 'result' | 'error' | 'ready' | 'fatal' | 'chat-event' | 'chat-voice-event' | 'vox-task-event' | 'projects-changed' | 'profiles-changed' | 'agent-operation-updated' | 'agent-management-updated' | 'project-discovery-updated' | 'chat-created' | 'chat-updated' | 'chat-deleted' | 'workspace-reset' | 'launch-updated' | 'workflow-updated' | 'prompts-changed' | 'mcps-changed' | 'skills-changed' | 'spawn-settings-changed' | 'approval-settings-changed' | 'codex-server-settings-changed';
  args?: Record<string, unknown>;
  operation?: unknown;
  discovery?: unknown;
  task?: unknown;
  voiceOwner?: string;
  key?: string;
  id?: string;
  result?: unknown;
  message?: string;
  code?: string;
  runId?: string;
  chatId?: string;
  revision?: number;
  event?: unknown;
};

@Injectable()
export class AgentsService implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Optional() @Inject(RecoveryService) private readonly recovery?: RecoveryService) {}
  private stopping = false;
  private commandSource?: (operation: string, args: Record<string, unknown>) => Promise<unknown>;
  setCommandSource(handler: (operation: string, args: Record<string, unknown>) => Promise<unknown>) {
    this.commandSource = handler;
  }
  private async answerCommandSource(child: ChildProcessWithoutNullStreams, message: BridgeMessage) {
    let response: { result?: unknown; error?: string };
    try {
      if (!this.commandSource || typeof message.operation !== 'string') throw new Error('Inbox observation adapter is unavailable.');
      response = { result: await this.commandSource(message.operation, message.args ?? {}) };
    } catch (error) {
      response = { error: error instanceof Error ? error.message : 'Inbox observation failed.' };
    }
    if (this.bridge === child && !child.stdin.destroyed && child.stdin.writableLength < 256 * 1024)
      child.stdin.write(JSON.stringify({ id: randomUUID(), op: 'command-source-response', args: { id: message.id, ...response } }) + '\n');
  }
  private restart?: ReturnType<typeof setTimeout>;
  private readonly workflowsConfigured = Boolean(process.env.CARRIER_DATABASE || process.env.SUITE_WORKFLOW_SOCKET);
  async onApplicationBootstrap() {
    await this.start().catch((error: Error) => Logger.warn(error.message, 'AgentsService'));
  }
  private readonly listeners = new Set<(message: BridgeMessage) => void>();
  subscribe(listener: (message: BridgeMessage) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private bridge?: ChildProcessWithoutNullStreams;
  private startup?: Promise<void>;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: BridgeMessage) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private start(): Promise<void> {
    if (this.startup) return this.startup;
    this.startup = new Promise<void>((resolveReady, rejectReady) => {
      const { python, env } = agentPython();
      if (this.recovery) {
        env.SUITE_RECOVERY_SOCKET = this.recovery.socketPath;
        void this.recovery.ready().catch(() => {});
      }
      if (this.workflowsConfigured) env.SUITE_WORKFLOW_SOCKET ??= resolve(
          env.AGENTS_STATE_DIR ?? resolve(env.XDG_STATE_HOME ?? resolve(env.HOME ?? '', '.local/state'), 'aixand/chats'),
          'native-workflows.sock',
        );
      const child = spawn(
        python,
        [
          '-u',
          process.env.AGENTS_BRIDGE_PATH ?? resolve('agent-bridge/main.py'),
        ],
        { env, stdio: 'pipe' },
      );
      this.bridge = child;
      let buffer = '';
      let diagnostics = '';
      let missingModule: string | undefined;
      let ready = false;
      const fail = (message: string) => {
        if (this.bridge !== child) return;
        clearTimeout(startupTimer);
        this.bridge = undefined;
        this.startup = undefined;
        const restart = () => {
          if (!this.stopping && !this.restart)
            this.restart = setTimeout(() => {
              this.restart = undefined;
              if (!this.stopping) void this.start().catch((error: Error) => Logger.warn(error.message, 'AgentsService'));
            }, 2000);
        };
        if (child.exitCode !== null || child.signalCode !== null) restart();
        else child.once('exit', restart);
        if (!ready) rejectReady(new Error(message));
        else Logger.warn(message, 'AgentsService');
        for (const [id, request] of this.pending) {
          clearTimeout(request.timer);
          request.resolve({ type: 'error', id, code: 'bridge_lost', message });
        }
        this.pending.clear();
        for (const listener of this.listeners)
          listener({ type: 'chat-event', event: { kind: 'connection', status: 'offline' } });
        child.stdin.end();
        if (child.exitCode !== null || child.signalCode !== null) return;
        const kill = setTimeout(() => child.kill('SIGKILL'), 30_000);
        kill.unref();
        child.once('exit', () => clearTimeout(kill));
      };
      const startupTimer = setTimeout(
        () =>
          fail(
            'Agent bridge startup timed out. Check AGENTS_PYTHON and SDK configuration.',
          ),
        15_000,
      );
      child.once('error', () =>
        fail(
          'Agent bridge could not start. Check AGENTS_PYTHON and the local SDK installation.',
        ),
      );
      // close follows the final stderr data; exit can precede Python's traceback.
      child.once('close', (code, signal) => {
        if (missingModule) {
          const packages: Record<string, string> = {
            resource_sources: 'aixand-resource-sources', agent_manager: 'agent-manager',
            mcp_manager: 'aixand-mcp-manager', prompt_manager: 'aixand-prompt-manager',
            skill_manager: 'aixand-skill-manager', server_manager: 'aixand-server-manager',
            undercurrent: 'undercurrent-sdk', carrier: 'carrier-mcp',
            orchestration_mcp: 'orchestration-mcp',
          };
          const dependency = packages[missingModule.split('.')[0]];
          fail(`Agent bridge is missing Python module "${missingModule}". Install ${dependency ? `"${dependency}"` : 'its SDK package'} into the configured AGENTS_PYTHON environment and reconnect. Pending mutations were not retried.`);
        } else if (!ready) {
          fail(`Agent bridge exited before startup completed (${signal ? `signal ${signal}` : `exit code ${code}`}). Check AGENTS_PYTHON and the local SDK installation.`);
        } else {
          fail(`Agent bridge disconnected (${signal ? `signal ${signal}` : `exit code ${code}`}). Refresh to recover; pending mutations were not retried.`);
        }
      });
      child.stdin.on('error', () =>
        fail(
          'Agent bridge input closed. Refresh agents and check Terminals before retrying a launch.',
        ),
      );
      // Keep a bounded tail for parsing. Never forward raw stderr, paths, or values.
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        diagnostics = (diagnostics + chunk).slice(-8192);
        const match = diagnostics.match(/(?:^|\n)ModuleNotFoundError: No module named ['"]([a-zA-Z_][\w.]{0,255})['"](?:\r?\n|$)/);
        if (match) missingModule = match[1];
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 4 * 1024 * 1024) {
          fail('Agent bridge response exceeded its limit.');
          return;
        }
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let message: BridgeMessage;
          try {
            message = JSON.parse(line) as BridgeMessage;
          } catch {
            fail('Invalid agent bridge response.');
            return;
          }
          if (message.type === 'command-source-request') {
            void this.answerCommandSource(child, message);
          } else if (['resources-changed', 'backend-discovery-updated', 'command-updated', 'command-activity', 'connect-activity-updated', 'connect-project-updated', 'connect-transfer-updated', 'chat-event', 'chat-voice-event', 'vox-task-event', 'projects-changed', 'profiles-changed', 'agent-operation-updated', 'agent-management-updated', 'project-discovery-updated', 'chat-created', 'chat-updated', 'chat-deleted', 'workspace-reset', 'launch-updated', 'workflow-updated', 'prompts-changed', 'mcps-changed', 'skills-changed', 'spawn-settings-changed', 'approval-settings-changed', 'codex-server-settings-changed'].includes(message.type)) {
            for (const listener of this.listeners) listener(message);
          } else if (message.type === 'ready') {
            ready = true;
            clearTimeout(startupTimer);
            resolveReady();
          } else if (message.type === 'fatal') {
            fail(message.message ?? 'Agent bridge failed.');
            return;
          } else if (message.id) {
            const request = this.pending.get(message.id);
            if (request) {
              clearTimeout(request.timer);
              this.pending.delete(message.id);
              request.resolve(message);
            }
          }
        }
      });
    });
    return this.startup;
  }

  async ready() {
    await this.start();
  }

  async request(command: AgentsRequest, voiceOwner?: string): Promise<BridgeMessage> {
    return this.dispatch(command, voiceOwner);
  }

  async runVoxTool(args: object): Promise<BridgeMessage> {
    return this.dispatch({ id: randomUUID(), op: 'vox-tool', args });
  }

  private async dispatch(command: { id: string; op: string; args: object }, voiceOwner?: string): Promise<BridgeMessage> {
    try {
      await this.start();
    } catch (error) {
      return {
        type: 'error',
        id: command.id,
        code: 'unavailable',
        message: error instanceof Error ? error.message :
          'Agent bridge is unavailable. Check the Python SDK environment and reconnect.',
      };
    }
    if (
      !this.bridge ||
      this.pending.size >= 32 ||
      this.bridge.stdin.writableLength > 256 * 1024
    )
      return {
        type: 'error',
        id: command.id,
        code: 'busy',
        message: 'Agent bridge is busy. Refresh before retrying.',
      };
    const id = randomUUID();
    const child = this.bridge;
    return new Promise((resolveResult) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          resolveResult({
            type: 'error',
            id: command.id,
            code: 'timeout',
            message:
              'Agent request timed out. Refresh agents and check Terminals before retrying a launch; the operation may still finish.',
          });
        },
        command.op === 'budgets' ? 180_000 : 90_000,
      );
      this.pending.set(id, {
        resolve: (message) => resolveResult({ ...message, id: command.id }),
        timer,
      });
      child.stdin.write(JSON.stringify({ ...command, id,
        args: { ...command.args, ...(voiceOwner ? { _voiceOwner: voiceOwner } : {}) },
      }) + '\n');
    });
  }

  releaseVoice(voiceOwner: string) {
    const child = this.bridge;
    if (child && !child.stdin.destroyed && child.stdin.writable)
      child.stdin.write(JSON.stringify({ id: randomUUID(), op: 'chat-voice-disconnect', args: { _voiceOwner: voiceOwner } }) + '\n');
  }

  async onApplicationShutdown() {
    this.stopping = true;
    clearTimeout(this.restart);
    const child = this.bridge;
    this.bridge = undefined;
    this.startup = undefined;
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.resolve({
        type: 'error',
        id,
        code: 'shutdown',
        message:
          'Backend stopped. Reconnect and check Terminals before retrying.',
      });
    }
    this.pending.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    await new Promise<void>((done) => {
      const kill = setTimeout(() => {
        child.kill('SIGKILL');
        done();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(kill);
        done();
      });
    });
  }
}
