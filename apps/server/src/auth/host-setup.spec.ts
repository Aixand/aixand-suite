import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from './store.js';
import { hashPassword, verifyPassword } from './password.js';

describe('Host-side initial password setup', () => {
  it('configures an unopened workspace without creating a session and cannot reset an existing password', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aixand-host-setup-'));
    chmodSync(directory, 0o700);
    const store = new AuthStore(join(directory, 'auth.db'), { initialize: true });
    try {
      const hash = await hashPassword('First server workspace password 493!');
      expect(() => store.configurePassword('not-a-password-hash')).toThrow('Argon2id');
      store.configurePassword(hash);
      expect(store.credential().state).toBe('configured');
      expect(await verifyPassword(store.credential().password_hash!, 'First server workspace password 493!')).toBe(true);
      expect(store.db.prepare('SELECT count(*) AS total FROM auth_sessions').get()).toMatchObject({ total: 0 });
      expect(store.onboarding()?.status).toBe('pending');
      expect(() => store.configurePassword(hash)).toThrow('already configured');
      expect(store.credential().credential_version).toBe(1);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
