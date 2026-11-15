import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AuthStore,
  authInitializationMarker,
  initializeAuthDatabase,
  tokenHash,
} from './store.js';
import { hashPassword } from './password.js';

describe('Authentication initialization and upgrade', () => {
  let directory: string;
  let file: string;
  const password = hashPassword('upgrade fixture passphrase 6249!');
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aixand-auth-store-'));
    file = join(directory, 'auth.db');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('prepares a private first-run database automatically and retains its state across restarts', () => {
    const store = new AuthStore(file, { initialize: true });
    expect(store.credential()).toMatchObject({
      state: 'setup_pending',
      password_hash: null,
      credential_version: 0,
    });
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(authInitializationMarker(file)).mode & 0o777).toBe(0o600);
    store.close();
    const reopened = new AuthStore(file, { initialize: true });
    expect(reopened.credential().state).toBe('setup_pending');
    reopened.close();
  });
  it('keeps onboarding optional for existing installations and saves new setup with revision checks', () => {
    const store = new AuthStore(file, { initialize: true });
    expect(store.onboarding()).toBeNull();
    store.beginOnboarding();
    const initial = store.onboarding()!;
    expect(initial).toMatchObject({ status: 'pending', step: 'providers', revision: 1 });
    const { revision, ...progress } = initial;
    const saved = store.saveOnboarding({ ...progress, step: 'install', selected: ['opencode'], selectionInitialized: true }, revision);
    expect(saved?.revision).toBe(2);
    expect(store.saveOnboarding(progress, revision)).toBeNull();
    store.close();
    const reopened = new AuthStore(file);
    expect(reopened.onboarding()).toEqual(saved);
    reopened.beginOnboarding();
    expect(reopened.onboarding()).toEqual(saved);
    reopened.close();
  });
  it('persists optional setup separately from the first ready profile', () => {
    const store = new AuthStore(file, { initialize: true });
    store.beginOnboarding();
    const { revision, ...progress } = store.onboarding()!;
    const saved = store.saveOnboarding({ ...progress, step: 'profile', selected: ['codex'], current: 'codex', selectionInitialized: true,
      drafts: { codex: { auth: 'personal', loginName: 'personal', profileName: 'work', operationId: null, nativeProfile: null, done: true, deferred: false,
        extra: { mode: 'account', resumeMode: 'account', auth: 'company', loginName: 'company', profileName: 'work-2', nativeProfile: null,
          operationId: '56d2450b-28cd-4780-b35d-808fcfce12d9' },
      } },
    }, revision)!;
    store.close();
    const reopened = new AuthStore(file);
    expect(reopened.onboarding()).toEqual(saved);
    const { revision: latest, ...value } = saved;
    const finished = reopened.saveOnboarding({ ...value, step: 'done', status: 'complete' }, latest)!;
    expect(finished.drafts.codex).toMatchObject({ auth: 'personal', profileName: 'work', done: true, extra: { auth: 'company', mode: 'account' } });
    reopened.close();
  });
  it('never initializes a missing database from the recovery helper', () => {
    expect(() => new AuthStore(file)).toThrow('missing');
    expect(existsSync(file)).toBe(false);
  });
  it('locks access after database deletion even across a full restart', () => {
    new AuthStore(file, { initialize: true }).close();
    rmSync(file);
    expect(() => new AuthStore(file, { initialize: true })).toThrow(
      'cannot be reopened',
    );
    expect(existsSync(file)).toBe(false);
  });
  it('does not overwrite an empty or corrupt existing database', () => {
    writeFileSync(file, 'damaged database', { mode: 0o600 });
    expect(() => new AuthStore(file, { initialize: true })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('damaged database');
    rmSync(file);
    expect(() => new AuthStore(file, { initialize: true })).toThrow('cannot be reopened');
  });
  it('does not reopen setup after an interrupted initialization', () => {
    writeFileSync(authInitializationMarker(file), 'initialized', {
      mode: 0o600,
    });
    expect(() => initializeAuthDatabase(file)).toThrow(
      'missing after initialization',
    );
    expect(existsSync(file)).toBe(false);
  });
  it('preserves shared-directory permissions without writing authentication files', () => {
    chmodSync(directory, 0o755);
    expect(() => new AuthStore(file, { initialize: true })).toThrow(
      'private authentication directory',
    );
    expect(statSync(directory).mode & 0o777).toBe(0o755);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(authInitializationMarker(file))).toBe(false);
  });

  async function legacy(configured: boolean) {
    const db = new DatabaseSync(file);
    db.exec(`
      PRAGMA user_version=1;
      CREATE TABLE workspace_auth (
        id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL,
        password_hash TEXT, credential_version INTEGER NOT NULL,
        setup_secret_hash TEXT, setup_expires_at INTEGER
      );
      CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, credential_version INTEGER NOT NULL,
        csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE auth_attempts (scope TEXT PRIMARY KEY, window_start INTEGER NOT NULL,
        attempts INTEGER NOT NULL, failures INTEGER NOT NULL, blocked_until INTEGER NOT NULL);
    `);
    db.prepare('INSERT INTO workspace_auth VALUES (1, ?, ?, ?, ?, ?)').run(
      configured ? 'configured' : 'setup_pending',
      configured ? await password : null,
      configured ? 3 : 0,
      configured ? null : tokenHash('old setup secret'),
      configured ? null : 1,
    );
    if (configured)
      db.prepare(
        'INSERT INTO auth_sessions VALUES (?, 3, ?, 1, 1, 9999999999999)',
      ).run(tokenHash('existing browser session'), 'existing-csrf');
    db.close();
  }
  it.each([false, true])(
    'upgrades schema one while preserving configured=%s credentials and sessions',
    async (configured) => {
      await legacy(configured);
      const store = new AuthStore(file, { initialize: true });
      expect(store.credential()).toEqual({
        id: 1,
        state: configured ? 'configured' : 'setup_pending',
        password_hash: configured ? await password : null,
        credential_version: configured ? 3 : 0,
      });
      expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(
        2,
      );
      expect(
        store.db.prepare('SELECT count(*) AS count FROM auth_sessions').get()
          ?.count,
      ).toBe(configured ? 1 : 0);
      expect(existsSync(authInitializationMarker(file))).toBe(true);
      store.close();
      const reopened = new AuthStore(file);
      expect(reopened.credential().password_hash).toBe(
        configured ? await password : null,
      );
      reopened.close();
    },
  );
  it('refuses to upgrade an invalid legacy credential record', async () => {
    await legacy(true);
    const db = new DatabaseSync(file);
    db.exec("UPDATE workspace_auth SET password_hash='broken hash'");
    db.close();
    expect(() => new AuthStore(file, { initialize: true })).toThrow('invalid');
    const unchanged = new DatabaseSync(file);
    expect(unchanged.prepare('PRAGMA user_version').get()?.user_version).toBe(
      1,
    );
    unchanged.close();
  });
  it('prevents clearing a configured password or toggling it back to pending', async () => {
    const store = new AuthStore(file, { initialize: true });
    store.db
      .prepare(
        "UPDATE workspace_auth SET state='configured', password_hash=?, credential_version=1",
      )
      .run(await password);
    expect(() =>
      store.db.exec('UPDATE workspace_auth SET password_hash=NULL'),
    ).toThrow();
    expect(() =>
      store.db.exec(
        "UPDATE workspace_auth SET state='setup_pending', password_hash=NULL",
      ),
    ).toThrow();
    store.close();
  });
});
