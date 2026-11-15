import { voiceEnabled } from '../capabilities.js';
import { platformEnvironment } from '../platform-environment.js';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { AgentsService } from '../agents/agents.service.js';

export type VoxMessage = { type: string; id?: string; owner?: string; sessionId?: string; event?: unknown; result?: unknown; message?: string; args?: object; task?: unknown };

@Injectable()
export class VoxService implements OnApplicationShutdown {
  private child?: ChildProcessWithoutNullStreams;
  private startup?: Promise<void>;
  private readonly listeners = new Set<(message: VoxMessage) => void>();
  private readonly pending = new Map<string, { resolve: (value: VoxMessage) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly unsubscribe: () => void;
  constructor(@Inject(AgentsService) private readonly agents: AgentsService) {
    this.unsubscribe = agents.subscribe((message) => {
      if (message.type === 'vox-task-event' && this.child)
        this.write({ type: 'task-event', task: message.task });
      if (message.type === 'project-discovery-updated' && this.child)
        this.write({ type: 'discovery-event', discovery: message.discovery });
    });
  }
  subscribe(listener: (message: VoxMessage) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private write(message: unknown) {
    if (this.child?.stdin.writable && !this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  ready() {
    if (!voiceEnabled()) return Promise.reject(new Error('Voice is not included in this installation.'));
    if (this.startup) return this.startup;
    const prepared = resolve('../../services/vox/.venv/bin/python');
    const python = process.env.VOX_PYTHON ?? prepared;
    if (!existsSync(python) && !process.env.VOX_PYTHON)
      return Promise.reject(new Error('Vox needs its Python environment. Run uv sync --python 3.12 in services/vox.'));
    this.startup = new Promise<void>((resolveReady, rejectReady) => {
      const env: NodeJS.ProcessEnv = { ...platformEnvironment(), HOME: process.env.HOME, PATH: process.env.PATH };
      if (process.env.AIXAND_PACKAGED_RUNTIME === '1') {
        env.PYTHONNOUSERSITE = '1';
        env.PYTHONDONTWRITEBYTECODE = '1';
      }
      for (const key of ['AGENT_MANAGER_HOME', 'AGENT_MANAGER_CONFIG', 'AGENT_MANAGER_LABELS', 'AGENT_MANAGER_METADATA', 'UNDERCURRENT_HOME', 'UNDERCURRENT_PYTHON_BRIDGE',
        'SERVER_MANAGER_HOME', 'MCP_MANAGER_HOME', 'PROMPT_MANAGER_HOME', 'SKILL_MANAGER_HOME',
        'AGENTS_CWD', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
        'VOX_STATE_DIR', 'VOX_MODEL', 'VOX_WHISPER_MODEL', 'VOX_WHISPER_DEVICE', 'VOX_WHISPER_COMPUTE',
        'VOX_TTS_VOICE', 'VOX_ICE_SERVERS', 'VOX_WAKE_MODEL_DIR', 'VOX_SPEECH_PAUSE_SECONDS', 'HF_HOME', 'HF_HUB_OFFLINE'])
        if (process.env[key]) env[key] = process.env[key];
      env.PYTHONPATH = process.env.AIXAND_PACKAGED_RUNTIME === '1' ? '' : [resolve('../../services/vox/src'),
        process.env.AGENTS_MANAGER_SOURCE,
        process.env.AGENTS_RUNTIME_SOURCE].filter(Boolean).join(delimiter);
      if ((python.includes('/') || python.includes('\\'))) env.PATH = `${dirname(resolve(python))}${delimiter}${env.PATH ?? ''}`;
      const child = spawn(python, ['-u', '-m', 'aixand_vox.worker'], { env, stdio: 'pipe' });
      this.child = child;
      child.stderr.resume();
      let buffer = '', ready = false;
      const fail = (message: string) => {
        if (this.child !== child) return;
        clearTimeout(timer);
        this.child = undefined; this.startup = undefined;
        if (!ready) rejectReady(new Error(message));
        for (const [id, request] of this.pending) {
          clearTimeout(request.timer); request.resolve({ type: 'error', id, message });
        }
        this.pending.clear();
        for (const listener of this.listeners) listener({ type: 'fatal', message });
        child.stdin.end(); child.kill('SIGTERM');
      };
      const timer = setTimeout(() => fail('Vox startup timed out. Check its Python environment.'), 15000);
      child.on('error', () => fail('Vox could not start. Check VOX_PYTHON and the SDK environment.'));
      child.on('exit', () => fail('Vox disconnected. Restart its conversation; background investigations remain in Chat.'));
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { fail('Vox response exceeded its limit.'); return; }
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          let message: VoxMessage;
          try { message = JSON.parse(line) as VoxMessage; } catch { fail('Invalid Vox response.'); return; }
          if (message.type === 'ready') { ready = true; clearTimeout(timer); resolveReady(); }
          else if (message.type === 'tool-call' && message.id && message.args) {
            const id = message.id;
            void this.agents.runVoxTool(message.args).then((result) => {
              if (this.child === child) this.write({ type: 'tool-result', id,
                ...(result.type === 'error' ? { error: result.message } : { result: result.result }) });
            }).catch(() => { if (this.child === child) this.write({ type: 'tool-result', id, error: 'Suite tool delivery was interrupted. Inspect task status before retrying.' }); });
          } else if (message.type === 'event' || message.type === 'wake-event') {
            for (const listener of this.listeners) listener(message);
          } else if (message.type === 'fatal') fail(message.message ?? 'Vox worker unavailable.');
          else if (message.id) {
            const request = this.pending.get(message.id);
            if (request) { clearTimeout(request.timer); this.pending.delete(message.id); request.resolve(message); }
          }
        }
      });
    });
    return this.startup;
  }
  async request(owner: string, command: { id: string; op: string; args: object }) {
    await this.ready();
    if (!this.child || this.pending.size >= 16 || this.child.stdin.writableLength > 256 * 1024)
      return { type: 'error', id: command.id, message: 'Vox is busy.' };
    const id = randomUUID();
    return new Promise<VoxMessage>((resolveResult) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolveResult({ type: 'error', id: command.id, message: 'Vox request timed out. Its outcome is unconfirmed; end the conversation before starting another.' });
      }, command.op === 'offer' || command.op === 'wake-offer' ? 240000 : 120000);
      this.pending.set(id, { timer, resolve: (message) => resolveResult({ ...message, id: command.id }) });
      this.write({ ...command, id, owner });
    });
  }
  release(owner: string) {
    this.write({ id: randomUUID(), owner, op: 'disconnect', args: {} });
  }
  async onApplicationShutdown() {
    this.unsubscribe();
    const child = this.child;
    this.child = undefined; this.startup = undefined;
    for (const [id, request] of this.pending) { clearTimeout(request.timer); request.resolve({ type: 'error', id, message: 'Vox backend stopped.' }); }
    this.pending.clear();
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 10000);
      child.once('exit', () => { clearTimeout(timer); done(); });
    });
  }
}
