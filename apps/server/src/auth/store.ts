import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialOnboarding, onboardingProgressSchema, type OnboardingProgress, type OnboardingState } from './onboarding.js';
import { windowsPrivatePath } from './windows-private.js';

export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export type Credential = {
  id: number;
  state: 'setup_pending' | 'configured';
  password_hash: string | null;
  credential_version: number;
};
export type Session = {
  token_hash: string;
  credential_version: number;
  csrf_token: string;
  created_at: number;
  last_activity: number;
  expires_at: number;
};
function privateFile(file: string) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Authentication database must be a regular private file');
  if (process.platform === 'win32') windowsPrivatePath('secure-file', file);
  else chmodSync(file, 0o600);
}
function privateDirectory(directory: string) {
  const stat = lstatSync(directory);
  if (process.platform === 'win32') {
    windowsPrivatePath('check', directory);
    return;
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(
      'Use a dedicated private authentication directory with permissions 0700. Existing parent directory permissions are never changed automatically.',
    );
  }
}
function validPasswordHash(hash: string | null): boolean {
  const match = hash?.match(
    /^\$argon2id\$v=19\$((?:[mpt]=\d+,){2}[mpt]=\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/,
  );
  if (!match) return false;
  const entries = match[1].split(',').map((entry) => entry.split('='));
  if (new Set(entries.map(([key]) => key)).size !== 3) return false;
  const parameters = Object.fromEntries(entries);
  const memory = Number(parameters.m),
    passes = Number(parameters.t),
    parallelism = Number(parameters.p);
  return (
    memory >= 19456 &&
    memory <= 262144 &&
    passes >= 1 &&
    passes <= 10 &&
    (passes >= 2 || memory >= 47104) &&
    parallelism >= 1 &&
    parallelism <= 8 &&
    Buffer.from(match[2], 'base64').length >= 16 &&
    Buffer.from(match[3], 'base64').length >= 32
  );
}
const credentialTable = (name: string) => `CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  state TEXT NOT NULL CHECK(state IN ('setup_pending','configured')),
  password_hash TEXT,
  credential_version INTEGER NOT NULL,
  CHECK((state='configured' AND password_hash IS NOT NULL AND credential_version >= 1)
    OR (state='setup_pending' AND password_hash IS NULL AND credential_version = 0))
)`;

export const authInitializationMarker = (file: string) => `${file}.initialized`;
function markInitialized(file: string) {
  const marker = authInitializationMarker(file);
  if (existsSync(marker)) {
    privateFile(marker);
    return;
  }
  const descriptor = openSync(marker, 'wx', 0o600);
  try {
    writeFileSync(
      descriptor,
      'Aixand authentication initialized. Preserve this file.\n',
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (process.platform === 'win32') {
    privateFile(marker);
    return;
  }
  const parent = openSync(dirname(file), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
export function initializeAuthDatabase(file: string) {
  if (existsSync(file))
    throw new Error(
      'Authentication database already exists; use auth:recover for a forgotten password',
    );
  if (process.platform === 'win32') windowsPrivatePath('create', dirname(file));
  else mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  privateDirectory(dirname(file));
  if (existsSync(authInitializationMarker(file)))
    throw new Error(
      'Authentication database is missing after initialization; restore it on the host. Setup cannot be reopened.',
    );
  // Write this first: an interrupted initialization must require host-side repair.
  markInitialized(file);
  closeSync(openSync(file, 'wx', 0o600));
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      ${credentialTable('workspace_auth')};
      CREATE TABLE auth_sessions (
        token_hash TEXT PRIMARY KEY, credential_version INTEGER NOT NULL,
        csrf_token TEXT NOT NULL, created_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE auth_attempts (
        scope TEXT PRIMARY KEY, window_start INTEGER NOT NULL,
        attempts INTEGER NOT NULL, failures INTEGER NOT NULL, blocked_until INTEGER NOT NULL
      );
      INSERT INTO workspace_auth VALUES (1, 'setup_pending', NULL, 0);
      PRAGMA user_version = 2;
      COMMIT;
    `);
  } finally {
    db.close();
  }
}
export class AuthStore {
  readonly db: DatabaseSync;
  private readonly identity: { dev: number; ino: number };
  constructor(
    readonly file: string,
    { initialize = false } = {},
  ) {
    if (!existsSync(file) && initialize) initializeAuthDatabase(file);
    if (!existsSync(file))
      throw new Error(
        'Authentication database is missing; restore it on the host.',
      );
    privateDirectory(dirname(file));
    privateFile(file);
    // Remember existing installations even when their database needs repair.
    markInitialized(file);
    this.identity = lstatSync(file);
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA busy_timeout=2000');
      const version = (
        this.db.prepare('PRAGMA user_version').get() as {
          user_version: number;
        }
      ).user_version;
      if (version !== 1 && version !== 2)
        throw new Error('Unsupported authentication schema');
      this.credential(version === 1);
      this.db.prepare('SELECT token_hash FROM auth_sessions LIMIT 1').get();
      this.db.prepare('SELECT scope FROM auth_attempts LIMIT 1').get();
      if (version === 1) {
        this.transaction(() => {
          this.db.exec(`
            ${credentialTable('workspace_auth_v2')};
            INSERT INTO workspace_auth_v2
              SELECT id, state, password_hash, credential_version FROM workspace_auth;
            DROP TABLE workspace_auth;
            ALTER TABLE workspace_auth_v2 RENAME TO workspace_auth;
            PRAGMA user_version = 2;
          `);
        });
      }
      // This optional workflow record does not alter credentials or sessions.
      // Existing configured installations remain outside first-run onboarding.
      this.db.exec(`CREATE TABLE IF NOT EXISTS workspace_onboarding (
        id INTEGER PRIMARY KEY CHECK(id=1), progress TEXT NOT NULL, revision INTEGER NOT NULL
      )`);
    } catch (cause) {
      this.db.close();
      throw cause;
    }
  }
  credential(legacy = false): Credential {
    privateDirectory(dirname(this.file));
    if (!existsSync(this.file))
      throw new Error('Authentication database is missing; access is locked.');
    const stat = lstatSync(this.file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.dev !== this.identity.dev ||
      stat.ino !== this.identity.ino
    )
      throw new Error(
        'Authentication database was replaced; restart after host-side repair.',
      );
    const row = this.db
      .prepare('SELECT * FROM workspace_auth WHERE id=1')
      .get() as
      | (Credential & {
          setup_secret_hash?: string | null;
          setup_expires_at?: number | null;
        })
      | undefined;
    if (
      !row ||
      !Number.isSafeInteger(row.credential_version) ||
      row.credential_version < 0 ||
      (row.state === 'configured'
        ? !validPasswordHash(row.password_hash) || row.credential_version < 1
        : row.state !== 'setup_pending' ||
          row.password_hash !== null ||
          row.credential_version !== 0) ||
      (legacy &&
        (row.state === 'configured'
          ? row.setup_secret_hash !== null || row.setup_expires_at !== null
          : !/^[a-f0-9]{64}$/.test(row.setup_secret_hash ?? '') ||
            !Number.isSafeInteger(row.setup_expires_at) ||
            row.setup_expires_at! <= 0))
    ) {
      throw new Error(
        'Authentication record is invalid; repair it on the host.',
      );
    }
    return row;
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      this.db.exec('COMMIT');
      return value;
    } catch (cause) {
      this.db.exec('ROLLBACK');
      throw cause;
    }
  }
  configurePassword(hash: string) {
    if (!validPasswordHash(hash)) throw new Error('Initial password must be a supported Argon2id hash');
    this.transaction(() => {
      if (this.credential().state !== 'setup_pending')
        throw new Error('Password is already configured; use recover to change it');
      this.db.prepare("UPDATE workspace_auth SET state='configured', password_hash=?, credential_version=1 WHERE id=1 AND state='setup_pending'").run(hash);
      this.db.exec('DELETE FROM auth_sessions; DELETE FROM auth_attempts;');
      this.beginOnboarding();
    });
  }
  replacePassword(hash: string) {
    if (!validPasswordHash(hash))
      throw new Error('Replacement password must be a supported Argon2id hash');
    this.transaction(() => {
      const credential = this.credential();
      if (credential.state !== 'configured')
        throw new Error('Finish initial setup before recovering a password');
      this.db
        .prepare(
          "UPDATE workspace_auth SET password_hash=?, credential_version=credential_version+1 WHERE id=1 AND state='configured'",
        )
        .run(hash);
      this.db.exec('DELETE FROM auth_sessions; DELETE FROM auth_attempts;');
    });
  }
  beginOnboarding() {
    this.db.prepare('INSERT INTO workspace_onboarding VALUES (1, ?, 1) ON CONFLICT(id) DO NOTHING')
      .run(JSON.stringify(initialOnboarding()));
  }
  onboarding(): OnboardingState | null {
    const row = this.db.prepare('SELECT progress, revision FROM workspace_onboarding WHERE id=1').get() as
      { progress: string; revision: number } | undefined;
    return row ? { ...onboardingProgressSchema.parse(JSON.parse(row.progress)), revision: row.revision } : null;
  }
  saveOnboarding(progress: OnboardingProgress, expectedRevision: number): OnboardingState | null {
    return this.transaction(() => {
      const current = this.onboarding();
      if (!current || current.revision !== expectedRevision) return null;
      this.db.prepare('UPDATE workspace_onboarding SET progress=?, revision=revision+1 WHERE id=1')
        .run(JSON.stringify(onboardingProgressSchema.parse(progress)));
      return this.onboarding();
    });
  }
  close() {
    this.db.close();
  }
}
