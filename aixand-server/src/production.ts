import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { authDatabasePath } from './auth/config.js';

export const PRODUCTION_PORT = 8753;

export function loadProductionEnvironment(directory = process.cwd()) {
  const inherited = { ...process.env };
  for (const name of ['.env', '.env.production']) {
    const file = resolve(directory, name);
    if (existsSync(file)) Object.assign(process.env, parseEnv(readFileSync(file, 'utf8')));
  }
  // Explicit process environment wins over either file.
  Object.assign(process.env, inherited);
}

export function productionConfiguration() {
  const mode = process.env.AIXAND_PRODUCTION_MODE ?? 'web';
  if (!['web', 'headless'].includes(mode))
    throw new Error('AIXAND_PRODUCTION_MODE must be web or headless');
  const port = Number(process.env.AIXAND_PRODUCTION_PORT ?? PRODUCTION_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('AIXAND_PRODUCTION_PORT must be an integer between 1 and 65535');
  const host = process.env.AIXAND_PRODUCTION_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host))
    throw new Error('The production service binds loopback. Use SSH or an HTTPS reverse proxy for remote access.');
  const transport = process.env.AIXAND_PRODUCTION_TRANSPORT ?? 'loopback';
  if (!['loopback', 'https-proxy'].includes(transport))
    throw new Error('AIXAND_PRODUCTION_TRANSPORT must be loopback or https-proxy');
  const origins = (process.env.AIXAND_PRODUCTION_ORIGINS ??
    `http://127.0.0.1:${port},http://localhost:${port}`)
    .split(',').map(value => value.trim()).filter(Boolean);
  if (!origins.length) throw new Error('At least one production frontend origin is required');
  for (const origin of origins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error('Invalid production frontend origin'); }
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))
      throw new Error('Production origins must be exact HTTP(S) origins without paths');
    if (transport === 'https-proxy' && url.protocol !== 'https:')
      throw new Error('HTTPS proxy mode requires HTTPS frontend origins');
    if (transport === 'loopback' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new Error('Loopback mode requires loopback frontend origins');
  }
  const proxy = process.env.AIXAND_PRODUCTION_TRUST_PROXY ?? '';
  if (transport === 'https-proxy' && !proxy.trim())
    throw new Error('HTTPS proxy mode requires AIXAND_PRODUCTION_TRUST_PROXY');
  const frontend = mode === 'headless' ? null : resolve(process.env.AIXAND_PRODUCTION_WEB_DIST ??
    resolve(import.meta.dirname, '../../aixand-web/dist'));
  for (const name of frontend ? ['index.html', 'recovery.html'] : []) {
    if (!existsSync(resolve(frontend!, name)) || !statSync(resolve(frontend!, name)).isFile())
      throw new Error(`Built frontend is missing ${name}. Run: node scripts/production.mjs build (from aixand-suite).`);
  }
  // Production never inherits the development listener, origins, or HTTP exception.
  process.env.CORS_ORIGINS = origins.join(',');
  process.env.AIXAND_TRUST_PROXY = transport === 'https-proxy' ? proxy : '';
  process.env.AIXAND_AUTH_LOOPBACK_HTTP = transport === 'loopback' ? '1' : '0';
  process.env.AIXAND_AUTH_DEV_HTTP = '0';
  process.env.AIXAND_AUTH_COOKIE_NAMESPACE = 'prod-' + createHash('sha256')
    .update(authDatabasePath()).digest('hex').slice(0, 12);
  return { port, host, frontend, origins, transport, mode };
}

export function serveProductionFrontend(app: INestApplication, directory: string | null) {
  if (directory === null) return;
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!['GET', 'HEAD'].includes(request.method) ||
      request.path === '/api' || request.path.startsWith('/api/')) return next();
    let path: string;
    try { path = decodeURIComponent(request.path); } catch { return response.sendStatus(400); }
    if (path.split(/[\\/]/).some(part => part === '..' || part.startsWith('.')) || path.includes('\0'))
      return response.sendStatus(404);
    const file = path === '/' ? 'index.html' : path.slice(1);
    const immutable = /^assets\/[\w./-]+-[\w-]{8,}\.[\w.]+$/.test(file);
    response.sendFile(file, {
      root: directory,
      dotfiles: 'deny',
      headers: { 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' },
    }, error => {
      if (!error) return;
      if (response.headersSent) return next(error);
      const status = (error as Error & { status?: number }).status;
      if (status === 404 || status === 403) return next();
      next(error);
    });
  });
}
