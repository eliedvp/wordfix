import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Stockage Redis du limiteur de requêtes (fenêtre fixe). Partagé entre plusieurs
 * instances de l'API, contrairement au stockage en mémoire par défaut.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redisKey = `wordfix:throttle:${throttlerName}:${key}`;
    const result = await this.redis.multi().incr(redisKey).pttl(redisKey).exec();
    const hits = Number(result?.[0]?.[1] ?? 1);
    let pttl = Number(result?.[1]?.[1] ?? -1);
    if (pttl < 0) {
      await this.redis.pexpire(redisKey, ttl);
      pttl = ttl;
    }
    const seconds = Math.ceil(pttl / 1000);
    const isBlocked = hits > limit;
    return {
      totalHits: hits,
      timeToExpire: seconds,
      isBlocked,
      timeToBlockExpire: isBlocked ? seconds : 0,
    };
  }
}
