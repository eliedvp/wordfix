import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.schema.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // Ne pas annoncer la technologie du serveur.
  app.disable('x-powered-by');

  // Toutes les routes sont servies sous /api, comme les réécritures Next.js (D4).
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const host = config.get('API_HOST', { infer: true });
  const port = config.get('API_PORT', { infer: true });

  await app.listen(port, host);
  app.get(Logger).log(`API WordFix démarrée sur http://${host}:${port}/api`, 'Bootstrap');
}

void bootstrap();
