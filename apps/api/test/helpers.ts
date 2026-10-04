import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { WorkerModule } from '../src/worker.module.js';

/** Démarre l'API complète (mêmes modules et même configuration que la production). */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

/** Démarre le worker (consommateur BullMQ + moteur d'analyse) dans le processus de test. */
export async function createTestWorker(): Promise<INestApplicationContext> {
  const worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  worker.useLogger(false);
  await worker.init();
  return worker;
}

/** Vide les tables entre deux tests (l'ordre respecte les clés étrangères). */
export async function resetDatabase(app: INestApplicationContext): Promise<void> {
  const prisma = app.get(PrismaService);
  await prisma.$executeRawUnsafe(
    'TRUNCATE "Issue", "AnalysisChunk", "Analysis", "DocumentContent", "Document", "User" CASCADE',
  );
}

/** Attend qu'une condition asynchrone soit vraie (sondage toutes les 100 ms). */
export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Délai dépassé : ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
