// Exercise the actual gateway and Rust bridge with a deterministic local binding.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { initializeAuthDatabase, AuthStore, tokenHash } from '../dist/auth/store.js';
import { hashPassword } from '../dist/auth/password.js';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('..', import.meta.url));
const ir = resolve(root, '../aixand-ir');
const reservation = createServer();
await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const origin = `http://127.0.0.1:${port}`;
const work = await mkdtemp(resolve(tmpdir(), 'aixand-workflow-auth-'));
const database = resolve(work, 'auth.db');
const token = randomBytes(32).toString('base64url');
initializeAuthDatabase(database);
const auth = new AuthStore(database);
auth.db.prepare("UPDATE workspace_auth SET state='configured', password_hash=?, credential_version=1 WHERE id=1").run(await hashPassword('workflow fixture passphrase 739!'));
const now = Date.now();
auth.db.prepare('INSERT INTO auth_sessions VALUES (?, 1, ?, ?, ?, ?)').run(tokenHash(token), 'workflow-csrf-fixture', now, now, now+3600000);
auth.close();
const child = spawn(process.execPath, ['dist/main.js'], {
  cwd: root,
  env: {
    ...process.env,
    HOST: '127.0.0.1', PORT: String(port), CORS_ORIGINS: origin,
    AIXAND_AUTH_DATABASE: database, AIXAND_AUTH_DEV_HTTP: '1', AIXAND_TRUST_PROXY: '',
    WORKFLOW_BRIDGE_PATH: resolve(root, 'workflow-bridge/target/debug/aixand-workflow-bridge'),
    WORKFLOW_CWD: ir, WORKFLOW_SDK_CONFIG: '', WORKFLOW_CATALOG_PATHS: '',
    WORKFLOW_PYTHON_BIN: '',
  },
  stdio: 'ignore',
});
let socket;
const pending = new Map();
function request(op, args) {
  const id = randomBytes(8).toString('hex');
  return new Promise((done, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${op}`));
    }, 15000);
    pending.set(id, {
      done: (value) => { clearTimeout(timeout); done(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    socket.send(JSON.stringify({ id, op, args }));
  });
}
try {
  const deadline = Date.now() + 20000;
  while (true) {
    if (child.exitCode !== null) throw new Error('Test server exited during startup');
    const health = await fetch(`${origin}/api/health`).catch(() => null);
    if (health?.ok) {
      assert.equal((await health.json()).service, 'aixand-server');
      break;
    }
    if (Date.now() >= deadline) throw new Error('Test server did not become ready');
    await delay(100);
  }
  socket = new WebSocket(`ws://127.0.0.1:${port}/api/workflows/ws`, { origin, headers: { Cookie: `aixand-dev-session=${token}` } });
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('Bridge startup timeout')), 15000);
    socket.on('error', (error) => { clearTimeout(timeout); reject(error); });
    socket.on('close', () => {
      clearTimeout(timeout);
      const error = new Error('Workflow connection closed');
      reject(error);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'ready') { clearTimeout(timeout); done(); }
      if (message.type === 'fatal') { clearTimeout(timeout); reject(new Error(message.message)); }
      if (message.id && message.type !== 'run-event') {
        pending.get(message.id)?.done(message);
        pending.delete(message.id);
      }
    });
  });
  const catalog = await request('catalogs', {});
  assert.ok(catalog.result.catalogs.some((entry) => entry.package.id === 'aixand'));
  const old = JSON.parse((await readFile(resolve(ir, 'examples/real-agent/workflow.json'), 'utf8')).replaceAll('aixand', 'intessio'));
  old.inputs.task.default = 'Keep literal intessio.agents.spawn unchanged';
  const validated = await request('validate', { source: JSON.stringify(old) });
  assert.equal(validated.result.valid, true);
  assert.equal(validated.result.document.body.steps[0].operation.id, 'aixand.agents.spawn');
  assert.equal(validated.result.document.inputs.task.default, old.inputs.task.default);
  const source = await readFile(resolve(ir, 'examples/verifier.json'), 'utf8');
  const inputs = JSON.parse(await readFile(resolve(ir, 'examples/verifier-inputs.json'), 'utf8'));
  const result = await request('run', { source, inputs });
  assert.equal(result.type, 'run-result');
  assert.equal(result.outputs.result.passed, true);
  console.log('PASS: authenticated gateway, Aixand catalog, legacy draft migration, literal preservation, and real Rust workflow execution.');
} finally {
  socket?.close();
  if (child.exitCode === null) {
    const exited = new Promise((done) => child.once('exit', done));
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
  }
  await rm(work, { recursive: true, force: true });
}
