import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { CarrierService } from './carrier.service.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

function worker() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(), exitCode: null, signalCode: null,
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

afterEach(() => vi.clearAllMocks());

it('waits for stderr after exit and reports a nonretryable missing dependency without raw diagnostics', async () => {
  const child = worker(), service = new CarrierService();
  const events: unknown[] = [];
  service.subscribe(value => events.push(value));
  const started = service.start();
  child.emit('exit', 1, null);
  child.stderr.write('private-path-and-token\nModuleNotFoundError: No module named ');
  child.stderr.write("'aixand_platform'\r\n");
  child.emit('close', 1, null);
  await expect(started).rejects.toMatchObject({ code: 'missing_dependency', retryable: false });
  expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).toContain('aixand_platform');
  expect(JSON.stringify(events)).not.toContain('private-path-and-token');
});

it('classifies a Unix-only import as an incompatible installation', async () => {
  const child = worker(), service = new CarrierService();
  const started = service.start();
  child.stderr.write("ModuleNotFoundError: No module named 'fcntl'\n");
  child.emit('close', 1, null);
  await expect(started).rejects.toMatchObject({ code: 'incompatible_platform', retryable: false });
});

it('retains a structured startup failure when the child subsequently closes', async () => {
  const child = worker(), service = new CarrierService();
  const events: unknown[] = [];
  service.subscribe(value => events.push(value));
  const started = service.start();
  child.stdout.write(JSON.stringify({ type: 'fatal', code: 'configuration', message: 'Check the configured dataset.' }) + '\n');
  child.emit('close', 1, null);
  await expect(started).rejects.toMatchObject({ code: 'configuration', retryable: false });
  expect(events).toHaveLength(1);
});

it('rejects pending work after a running bridge closes and permits a fresh connection', async () => {
  const child = worker(), service = new CarrierService();
  const started = service.start();
  child.stdout.write('{"type":"ready"}\n');
  await started;
  const request = service.request('snapshot', {});
  await Promise.resolve();
  child.emit('close', 1, null);
  await expect(request).rejects.toMatchObject({ code: 'adapter_closed', retryable: true });
  const next = worker();
  const reconnected = service.start();
  next.stdout.write('{"type":"ready"}\n');
  await reconnected;
  next.emit('close', 0, null);
});
