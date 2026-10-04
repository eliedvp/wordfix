import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.schema.js';
import { AnalysisQueue } from './analysis.queue.js';
import { ANALYSIS_QUEUE, MAINTENANCE_QUEUE, QUEUE_PREFIX } from './queue.constants.js';

/**
 * Files BullMQ (Redis). L'API y dépose les jobs ; le worker les consomme.
 * Redis doit être configuré en `maxmemory-policy noeviction` (docker-compose.yml).
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        prefix: QUEUE_PREFIX,
        // maxRetriesPerRequest: null est exigé par BullMQ pour les connexions bloquantes.
        connection: new Redis(config.get('REDIS_URL', { infer: true }), {
          maxRetriesPerRequest: null,
        }),
      }),
    }),
    BullModule.registerQueue({ name: ANALYSIS_QUEUE }, { name: MAINTENANCE_QUEUE }),
  ],
  providers: [AnalysisQueue],
  exports: [BullModule, AnalysisQueue],
})
export class QueueModule {}
