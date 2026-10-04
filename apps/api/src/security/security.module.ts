import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.schema.js';
import { REDIS_CLIENT } from '../redis/redis.module.js';
import { OriginGuard } from './origin.guard.js';
import { QUOTA_LIMITS, type QuotaLimits, QuotaService } from './quota.service.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: (config: ConfigService<Env, true>, redis: Redis) => ({
        throttlers: [
          {
            name: 'default',
            ttl: 60_000,
            limit: config.get('RATE_LIMIT_PER_MINUTE', { infer: true }),
          },
        ],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
  ],
  providers: [
    QuotaService,
    {
      provide: QUOTA_LIMITS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): QuotaLimits => ({
        analysesPerUserPerHour: config.get('QUOTA_ANALYSES_PER_HOUR', { infer: true }),
        analysesPerIpPerDay: config.get('QUOTA_ANALYSES_PER_IP_PER_DAY', { infer: true }),
        uploadsPerIpPerHour: config.get('QUOTA_UPLOADS_PER_IP_PER_HOUR', { infer: true }),
      }),
    },
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
  exports: [QuotaService],
})
export class SecurityModule {}
