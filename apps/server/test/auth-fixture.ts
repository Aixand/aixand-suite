import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  AuthStore,
  initializeAuthDatabase,
  tokenHash,
} from '../src/auth/store.js';
import { hashPassword } from '../src/auth/password.js';
import { SESSION_LIFETIME } from '../src/auth/config.js';

export const fixturePassword = 'isolated Suite password 9274!';
export const fixtureOrigin = 'http://localhost:5186';
const fixtureHash = hashPassword(fixturePassword);
export async function authFixture(pending = false) {
  const directory = mkdtempSync(join(tmpdir(), 'aixand-auth-test-'));
  const file = join(directory, 'auth.db');
  initializeAuthDatabase(file);
  if (!pending) {
    const store = new AuthStore(file);
    store.db
      .prepare(
        "UPDATE workspace_auth SET state='configured', password_hash=?, credential_version=1 WHERE id=1",
      )
      .run(await fixtureHash);
    store.close();
  }
  vi.stubEnv('AIXAND_AUTH_DATABASE', file);
  vi.stubEnv('AIXAND_AUTH_DEV_HTTP', '1');
  vi.stubEnv('AIXAND_TRUST_PROXY', '');
  vi.stubEnv('CORS_ORIGINS', fixtureOrigin);
  return {
    directory,
    file,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
export function fixtureCookie(app: INestApplication) {
  // Seed a session in disposable data; production authentication has no test bypass.
  void app;
  const store = new AuthStore(process.env.AIXAND_AUTH_DATABASE!);
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  store.db
    .prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      tokenHash(token),
      store.credential().credential_version,
      randomBytes(32).toString('base64url'),
      now,
      now,
      now + SESSION_LIFETIME,
    );
  store.close();
  return `aixand-dev-session=${token}`;
}
