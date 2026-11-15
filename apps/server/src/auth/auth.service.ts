import {
  Injectable,
  Logger,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  ConflictException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocket, type RawData } from 'ws';
import { AuthStore, tokenHash, type Session } from './store.js';
import {
  authDatabasePath,
  clientAddress,
  cookieName,
  localSetupRequest,
  secureTransport,
  SESSION_IDLE,
  SESSION_LIFETIME,
  validOrigin,
} from './config.js';
import { hashPassword, verifyPassword } from './password.js';
import { initialOnboarding, type OnboardingProgress } from './onboarding.js';

const equal = (a: string, b: string) =>
  timingSafeEqual(
    Buffer.from(tokenHash(a), 'hex'),
    Buffer.from(tokenHash(b), 'hex'),
  );
@Injectable()
export class AuthService implements OnApplicationShutdown {
  readonly store: AuthStore;
  private readonly logger = new Logger('WorkspaceAuth');
  private hashes = 0;
  private readonly sockets = new Map<WebSocket, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor() {
    this.store = new AuthStore(authDatabasePath(), { initialize: true });
    this.timer = setInterval(() => {
      for (const [socket, digest] of this.sockets) {
        try {
          if (!this.sessionByHash(digest))
            socket.close(1008, 'Sign in required');
        } catch {
          socket.close(1008, 'Sign in required');
        }
      }
    }, 1000);
    this.timer.unref();
  }
  assertTransport(request: IncomingMessage) {
    if (!secureTransport(request))
      throw new ForbiddenException(
        'HTTPS is required. Local connections need explicit loopback HTTP configuration.',
      );
  }
  assertMutation(request: IncomingMessage) {
    this.assertTransport(request);
    if (!validOrigin(request))
      throw new ForbiddenException('Origin is not allowed');
    if (!request.headers['content-type']?.startsWith('application/json'))
      throw new ForbiddenException('Expected application/json');
  }
  status(request: IncomingMessage) {
    const state = this.store.credential().state;
    return {
      state,
      ...(state === 'setup_pending'
        ? { setupAllowed: localSetupRequest(request) }
        : {}),
    };
  }
  private throttle(address: string) {
    const now = Date.now();
    this.store.transaction(() => {
      this.store.db
        .prepare(
          'DELETE FROM auth_attempts WHERE window_start < ? AND blocked_until < ?',
        )
        .run(now - 60 * 60 * 1000, now);
      for (const [scope, limit] of [
        ['global', 30],
        [`ip:${address}`, 5],
      ] as const) {
        this.store.db
          .prepare('INSERT OR IGNORE INTO auth_attempts VALUES (?, ?, 0, 0, 0)')
          .run(scope, now);
        const row = this.store.db
          .prepare('SELECT * FROM auth_attempts WHERE scope=?')
          .get(scope) as {
          window_start: number;
          attempts: number;
          blocked_until: number;
        };
        if (
          row.blocked_until > now ||
          (row.window_start > now - 60_000 && row.attempts >= limit)
        )
          throw new HttpException('Too many attempts. Try again shortly.', 429);
        if (row.window_start <= now - 60_000)
          this.store.db
            .prepare(
              'UPDATE auth_attempts SET window_start=?, attempts=0 WHERE scope=?',
            )
            .run(now, scope);
        if (scope === 'global')
          this.store.db
            .prepare(
              'UPDATE auth_attempts SET attempts=attempts+1 WHERE scope=?',
            )
            .run(scope);
      }
    });
  }
  private failed(address: string) {
    const scope = `ip:${address}`;
    this.store.db
      .prepare(
        'UPDATE auth_attempts SET failures=failures+1, attempts=attempts+1 WHERE scope=?',
      )
      .run(scope);
    const row = this.store.db
      .prepare('SELECT failures FROM auth_attempts WHERE scope=?')
      .get(scope) as { failures: number };
    if (row.failures >= 5)
      this.store.db
        .prepare('UPDATE auth_attempts SET blocked_until=? WHERE scope=?')
        .run(
          Date.now() +
            Math.min(900_000, 60_000 * 2 ** Math.min(row.failures - 5, 4)),
          scope,
        );
    this.logger.warn(`Authentication failed from ${address}`);
  }
  private async boundedHash<T>(operation: () => Promise<T>): Promise<T> {
    if (this.hashes >= 2)
      throw new HttpException(
        'Authentication is busy. Try again shortly.',
        429,
      );
    this.hashes++;
    try {
      return await operation();
    } finally {
      this.hashes--;
    }
  }
  async setup(request: IncomingMessage, password: string) {
    if (!localSetupRequest(request))
      throw new ForbiddenException(
        'Create the first password locally on the Suite host, before enabling a reverse proxy.',
      );
    const address = clientAddress(request);
    this.throttle(address);
    const credential = this.store.credential();
    if (credential.state !== 'setup_pending')
      throw new UnauthorizedException(
        'Password is already configured. Sign in to continue.',
      );
    const hash = await this.boundedHash(() => hashPassword(password));
    const token = this.store.transaction(() => {
      const current = this.store.credential();
      if (current.state !== 'setup_pending')
        throw new UnauthorizedException(
          'Password is already configured. Sign in to continue.',
        );
      this.store.db
        .prepare(
          "UPDATE workspace_auth SET state='configured', password_hash=?, credential_version=credential_version+1 WHERE id=1",
        )
        .run(hash);
      this.store.db.exec(
        'DELETE FROM auth_sessions; DELETE FROM auth_attempts;',
      );
      this.store.beginOnboarding();
      return this.createSession(current.credential_version + 1);
    });
    // Password creation and its initial session commit together.
    this.logger.log('Password setup completed');
    return token;
  }
  async login(request: IncomingMessage, password: string) {
    const address = clientAddress(request);
    this.throttle(address);
    const credential = this.store.credential();
    if (
      credential.state !== 'configured' ||
      !(await this.boundedHash(() =>
        verifyPassword(credential.password_hash!, password),
      ))
    ) {
      this.failed(address);
      throw new UnauthorizedException('Invalid password.');
    }
    const token = this.store.transaction(() => {
      const current = this.store.credential();
      if (
        current.credential_version !== credential.credential_version ||
        current.password_hash !== credential.password_hash
      )
        throw new UnauthorizedException('Password changed. Sign in again.');
      this.store.db
        .prepare(
          'UPDATE auth_attempts SET failures=0, blocked_until=0 WHERE scope=?',
        )
        .run(`ip:${address}`);
      return this.createSession(credential.credential_version);
    });
    this.logger.log(`Login from ${address}`);
    return token;
  }
  // Call only inside the credential transaction, after validating its version.
  private createSession(credentialVersion: number): string {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.store.db
      .prepare(
        'DELETE FROM auth_sessions WHERE expires_at<=? OR last_activity<=?',
      )
      .run(now, now - SESSION_IDLE);
    if (
      (
        this.store.db
          .prepare('SELECT count(*) AS count FROM auth_sessions')
          .get() as { count: number }
      ).count >= 32
    ) {
      this.store.db.exec(
        'DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions ORDER BY created_at LIMIT 1)',
      );
    }
    this.store.db
      .prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        tokenHash(token),
        credentialVersion,
        randomBytes(32).toString('base64url'),
        now,
        now,
        now + SESSION_LIFETIME,
      );
    return token;
  }
  private sessionByHash(digest: string): Session | null {
    const credential = this.store.credential();
    if (credential.state !== 'configured') return null;
    const session = this.store.db
      .prepare('SELECT * FROM auth_sessions WHERE token_hash=?')
      .get(digest) as Session | undefined;
    if (
      !session ||
      session.credential_version !== credential.credential_version ||
      session.expires_at <= Date.now() ||
      session.last_activity <= Date.now() - SESSION_IDLE
    )
      return null;
    return session;
  }
  session(request: IncomingMessage, touch = false): Session | null {
    this.assertTransport(request);
    const cookies = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim().split('='));
    const values = cookies.filter(([name]) => name === cookieName(request));
    if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0][1] ?? ''))
      return null;
    const session = this.sessionByHash(tokenHash(values[0][1]));
    if (session && touch)
      this.store.db
        .prepare('UPDATE auth_sessions SET last_activity=? WHERE token_hash=?')
        .run(Date.now(), session.token_hash);
    return session;
  }
  logout(request: IncomingMessage) {
    const session = this.session(request);
    if (!session) throw new UnauthorizedException('Sign in required');
    if (
      !equal(String(request.headers['x-csrf-token'] ?? ''), session.csrf_token)
    )
      throw new ForbiddenException('Invalid CSRF token');
    this.store.db
      .prepare('DELETE FROM auth_sessions WHERE token_hash=?')
      .run(session.token_hash);
    for (const [socket, digest] of this.sockets)
      if (digest === session.token_hash) socket.close(1008, 'Signed out');
    this.logger.log('Session signed out');
  }
  onboarding(request: IncomingMessage) {
    if (!this.session(request)) throw new UnauthorizedException('Sign in required');
    return this.store.onboarding();
  }
  assertOnboardingMutation(request: IncomingMessage) {
    this.assertMutation(request);
    const session = this.session(request);
    if (!session) throw new UnauthorizedException('Sign in required');
    if (!equal(String(request.headers['x-csrf-token'] ?? ''), session.csrf_token))
      throw new ForbiddenException('Invalid CSRF token');
  }
  beginOnboarding(request: IncomingMessage, manual = false) {
    this.assertOnboardingMutation(request);
    const current = this.store.onboarding();
    if (current?.status === 'pending') {
      if (!manual || current.manual) return current;
      const { revision, ...progress } = current;
      return this.store.saveOnboarding({ ...progress, manual: true }, revision)!;
    }
    if (current) return this.store.saveOnboarding({ ...initialOnboarding(), ...(manual ? { manual: true } : {}) }, current.revision)!;
    this.store.beginOnboarding();
    if (manual) return this.store.saveOnboarding({ ...initialOnboarding(), manual: true }, this.store.onboarding()!.revision)!;
    return this.store.onboarding()!;
  }
  saveOnboarding(request: IncomingMessage, progress: OnboardingProgress, expectedRevision: number, validated = false) {
    if (progress.status === 'complete' && !validated)
      throw new ForbiddenException('Complete setup through the onboarding completion action.');
    const session = this.session(request);
    if (!session) throw new UnauthorizedException('Sign in required');
    if (!equal(String(request.headers['x-csrf-token'] ?? ''), session.csrf_token))
      throw new ForbiddenException('Invalid CSRF token');
    const saved = this.store.saveOnboarding(progress, expectedRevision);
    if (!saved) throw new ConflictException('Setup changed in another tab. Refresh setup before continuing.');
    return saved;
  }
  authorizeSocket(socket: WebSocket, request: IncomingMessage): boolean {
    try {
      if (!validOrigin(request)) {
        socket.close(1008, 'Origin is not allowed');
        return false;
      }
      const session = this.session(request);
      if (!session) {
        socket.close(1008, 'Sign in required');
        return false;
      }
      this.sockets.set(socket, session.token_hash);
      socket.once('close', () => this.sockets.delete(socket));
      return true;
    } catch {
      socket.close(1008, 'Sign in required');
      return false;
    }
  }
  canSend(socket: WebSocket): boolean {
    try {
      const digest = this.sockets.get(socket);
      if (digest && this.sessionByHash(digest)) return true;
    } catch {
      /* Broken authentication data always denies access. */
    }
    socket.close(1008, 'Sign in required');
    return false;
  }
  onMessage(
    socket: WebSocket,
    handler: (raw: RawData, binary: boolean) => void,
  ) {
    socket.on('message', (raw, binary) => {
      if (socket.readyState !== WebSocket.OPEN || !this.canSend(socket)) return;
      const digest = this.sockets.get(socket)!;
      this.store.db
        .prepare('UPDATE auth_sessions SET last_activity=? WHERE token_hash=?')
        .run(Date.now(), digest);
      handler(raw, binary);
    });
  }
  onApplicationShutdown() {
    clearInterval(this.timer);
    for (const socket of this.sockets.keys())
      socket.close(1001, 'Server shutting down');
    this.store.close();
  }
}
