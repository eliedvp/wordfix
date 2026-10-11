import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { ExportWorkerModule } from './export-worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ExportWorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log('Service d’export WordFix démarré : en attente des exports', 'Bootstrap');
}

void bootstrap();
