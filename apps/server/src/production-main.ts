import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import { loadProductionEnvironment, productionConfiguration, serveProductionFrontend } from './production.js';

async function bootstrap() {
  loadProductionEnvironment();
  const configuration = productionConfiguration();
  const app = await NestFactory.create(AppModule);
  try {
    configureApp(app);
    serveProductionFrontend(app, configuration.frontend);
    app.enableShutdownHooks();
    await app.listen(configuration.port, configuration.host);
    console.log(`Aixand production: http://${configuration.host === '::1' ? '[::1]' : configuration.host}:${configuration.port}`);
  } catch (error) {
    await app.close();
    throw error;
  }
}
await bootstrap();
