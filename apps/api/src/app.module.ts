import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { ROOT_ENV_FILE } from './config/env-file.js';
import { type Env, validateEnv } from './config/env.schema.js';
import { buildLoggerParams } from './config/logger.config.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SessionModule } from './session/session.module.js';
import { StorageModule } from './storage/storage.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { AnalysesModule } from './analyses/analyses.module.js';
import { IssuesModule } from './issues/issues.module.js';
import { QueueModule } from './queue/queue.module.js';
import { AiUsageModule } from './ai/ai.module.js';

/** Modules d'infrastructure partagés par l'API HTTP et le worker. */
export const infrastructureImports = [
  ConfigModule.forRoot({
    isGlobal: true,
    cache: true,
    envFilePath: ROOT_ENV_FILE,
    validate: validateEnv,
  }),
  LoggerModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService<Env, true>) =>
      buildLoggerParams({
        NODE_ENV: config.get('NODE_ENV', { infer: true }),
        LOG_LEVEL: config.get('LOG_LEVEL', { infer: true }),
      }),
  }),
  PrismaModule,
  RedisModule,
  StorageModule,
];

@Module({
  imports: [
    ...infrastructureImports,
    QueueModule,
    AiUsageModule,
    SessionModule,
    HealthModule,
    DocumentsModule,
    AnalysesModule,
    IssuesModule,
  ],
})
export class AppModule {}
