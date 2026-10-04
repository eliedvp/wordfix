import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppError } from '../common/errors/app-error.js';
import { REDIS_CLIENT } from '../redis/redis.module.js';

export interface QuotaLimits {
  analysesPerUserPerHour: number;
  analysesPerIpPerDay: number;
  uploadsPerIpPerHour: number;
}

export const QUOTA_LIMITS = Symbol('QUOTA_LIMITS');

const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * Quotas d'usage (décision D8) : ils protègent le budget IA et le serveur contre
 * les abus. Fenêtres fixes stockées dans Redis.
 */
@Injectable()
export class QuotaService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(QUOTA_LIMITS) private readonly limits: QuotaLimits,
  ) {}

  /** Compte un import (même refusé : la vérification d'un fichier coûte aussi). */
  async consumeUpload(ip: string): Promise<void> {
    const count = await this.increment(`upload:ip:${ip}`, HOUR);
    if (count > this.limits.uploadsPerIpPerHour) throw new AppError('RATE_LIMITED');
  }

  /** Vérifie, sans les consommer, les quotas d'analyse. */
  async assertCanAnalyze(userId: string, ip: string): Promise<void> {
    const [perUser, perIp] = await this.redis.mget(
      this.key(`analysis:user:${userId}`, HOUR),
      this.key(`analysis:ip:${ip}`, DAY),
    );
    if (Number(perUser ?? 0) >= this.limits.analysesPerUserPerHour)
      throw new AppError('RATE_LIMITED');
    if (Number(perIp ?? 0) >= this.limits.analysesPerIpPerDay) throw new AppError('RATE_LIMITED');
  }

  /** Enregistre une analyse effectivement lancée. */
  async recordAnalysis(userId: string, ip: string): Promise<void> {
    await Promise.all([
      this.increment(`analysis:user:${userId}`, HOUR),
      this.increment(`analysis:ip:${ip}`, DAY),
    ]);
  }

  private key(name: string, windowSeconds: number): string {
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    return `wordfix:quota:${name}:${window}`;
  }

  private async increment(name: string, windowSeconds: number): Promise<number> {
    const key = this.key(name, windowSeconds);
    const result = await this.redis.multi().incr(key).expire(key, windowSeconds).exec();
    return Number(result?.[0]?.[1] ?? 0);
  }
}
