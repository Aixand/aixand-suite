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
  child.stderr.write("'aixand_filesystem'\r\n");
  child.emit('close', 1, null);
  await expect(started).rejects.toMatchObject({ code: 'missing_dependency', retryable: false });
  expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).toContain('aixand_filesystem');
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


it('uses the shared SDK environment and retains explicit Carrier overrides', async () => {
  const previous = { CARRIER_PYTHON: process.env.CARRIER_PYTHON, AGENTS_MANAGER_SOURCE: process.env.AGENTS_MANAGER_SOURCE,
    CARRIER_SOURCE: process.env.CARRIER_SOURCE };
  try {
    process.env.CARRIER_PYTHON = '/configured/carrier-python';
    process.env.AGENTS_MANAGER_SOURCE = '/configured/agent-manager';
    process.env.CARRIER_SOURCE = '/configured/carrier';
    const child = worker(), service = new CarrierService();
    const started = service.start();
    const [program, , options] = vi.mocked(spawn).mock.calls.at(-1)!;
    expect(program).toBe('/configured/carrier-python');
    expect(options?.env?.PYTHONPATH).toContain('/configured/carrier');
    expect(options?.env?.PYTHONPATH).toContain('/configured/agent-manager');
    child.stdout.write('{"type":"ready"}\n');
    await started;
    child.emit('close', 0, null);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
