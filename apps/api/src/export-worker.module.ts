import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { infrastructureImports } from './app.module.js';
import type { Env } from './config/env.schema.js';
import {
  EXPORT_LIMITS,
  ExportChildRunner,
  type ExportLimits,
} from './exports/export-child-runner.js';
import { ExportRecoveryService } from './exports/export-recovery.service.js';
import { ExportRunner } from './exports/export-runner.js';
import { ExportProcessor } from './processors/export.processor.js';
import { QueueModule } from './queue/queue.module.js';

/**
 * Service d'export : processus séparé du worker d'analyse, qui ne consomme que la file
 * `export`. Chaque export s'exécute dans un processus enfant éphémère (isolation
 * mémoire) ; en production, ce service a sa propre limite mémoire (conteneur).
 */
@Module({
  imports: [...infrastructureImports, QueueModule],
  providers: [
    {
      provide: EXPORT_LIMITS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): ExportLimits => ({
        memoryLimitMb: config.get('EXPORT_MEMORY_LIMIT_MB', { infer: true }),
        timeoutMs: config.get('EXPORT_TIMEOUT_MS', { infer: true }),
      }),
    },
    ExportChildRunner,
    ExportRunner,
    ExportProcessor,
    ExportRecoveryService,
  ],
})
export class ExportWorkerModule {}
