import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { existsSync } from 'node:fs';
import { configureApp } from './configure-app.js';

async function bootstrap() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(port, process.env.HOST ?? '127.0.0.1');
}
await bootstrap();
