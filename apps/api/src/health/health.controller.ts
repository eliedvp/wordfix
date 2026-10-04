import { createRequire } from 'node:module';
import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { DependencyState, HealthResponse } from '@wordfix/shared';
import type { Response } from 'express';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service.js';
import { REDIS_CLIENT } from '../redis/redis.module.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS).unref(),
    ),
  ]);
}

/** État de l'API et de ses dépendances (PostgreSQL, Redis). 503 si l'une est indisponible. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const healthy = database === 'up' && redis === 'up';
    if (!healthy) res.status(HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: healthy ? 'ok' : 'degraded',
      service: 'wordfix-api',
      version,
      uptimeSeconds: Math.round(process.uptime()),
      dependencies: { database, redis },
    };
  }

  private async checkDatabase(): Promise<DependencyState> {
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`);
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<DependencyState> {
    try {
      return (await withTimeout(this.redis.ping())) === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
