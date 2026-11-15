import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { allowedOrigins, trustedProxy } from './auth/config.js';
import { AuthService } from './auth/auth.service.js';
import type { Request, Response, NextFunction } from 'express';

export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api');
  const server = app.getHttpAdapter().getInstance();
  server.set('trust proxy', (address: string) => trustedProxy(address));
  const auth = app.get(AuthService);
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.path.startsWith('/api/auth/'))
      response.setHeader('Cache-Control', 'no-store');
    if (
      !request.path.startsWith('/api/') ||
      request.path === '/api/health' ||
      request.path.startsWith('/api/auth/')
    )
      return next();
    try {
      const session = auth.session(request, true);
      if (!session)
        return response.status(401).json({ message: 'Sign in required' });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        auth.assertMutation(request);
        if (request.headers['x-csrf-token'] !== session.csrf_token)
          return response.status(403).json({ message: 'Invalid CSRF token' });
      }
      return next();
    } catch {
      return response
        .status(403)
        .json({ message: 'Authentication required over HTTPS' });
    }
  });
  app.enableCors({
    origin: allowedOrigins(),
    credentials: true,
  });
  app.useWebSocketAdapter(new WsAdapter(app));
}
