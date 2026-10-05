import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.schema.js';
import { REDIS_CLIENT } from '../redis/redis.module.js';
import type { TokenUsage } from './ai-provider.js';

const KEY_PREFIX = 'wordfix:ai:tokens:';

/**
 * Suivi de la consommation IA quotidienne (tous utilisateurs) et plafond de
 * dépense : au-delà, les nouvelles analyses sont refusées jusqu'au lendemain.
 */
@Injectable()
export class AiUsageService {
  private readonly budget: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.budget = config.get('AI_DAILY_TOKEN_BUDGET', { infer: true });
  }

  private key(date = new Date()): string {
    return `${KEY_PREFIX}${date.toISOString().slice(0, 10)}`;
  }

  async record(usage: TokenUsage): Promise<void> {
    const key = this.key();
    await this.redis
      .multi()
      .incrby(key, usage.inputTokens + usage.outputTokens)
      .expire(key, 3 * 24 * 60 * 60)
      .exec();
  }

  async usedToday(): Promise<number> {
    return Number((await this.redis.get(this.key())) ?? 0);
  }

  /** Vrai si le plafond quotidien est atteint (0 = pas de plafond). */
  async isExhausted(): Promise<boolean> {
    if (this.budget === 0) return false;
    return (await this.usedToday()) >= this.budget;
  }
}
