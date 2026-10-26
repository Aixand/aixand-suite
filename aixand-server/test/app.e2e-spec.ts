import { authFixture } from './auth-fixture.js';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';

describe('AppController (e2e)', () => {
  let fixture: Awaited<ReturnType<typeof authFixture>>;
  let app: INestApplication<App>;

  beforeEach(async () => {
    fixture = await authFixture();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  it('/api/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect({ status: 'ok', service: 'aixand-server' });
  });

  afterEach(async () => {
    await app.close();
    fixture.cleanup();
    vi.unstubAllEnvs();
  });
});
