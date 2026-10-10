import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.schema.js';
import { AiUsageService } from './usage.service.js';

/** Redis réduit à la lecture du compteur du jour. */
function serviceWith(budget: number, usedToday: number | null): AiUsageService {
  const redis = { get: () => Promise.resolve(usedToday === null ? null : String(usedToday)) };
  const config = { get: () => budget } as unknown as ConfigService<Env, true>;
  return new AiUsageService(redis as unknown as Redis, config);
}

describe('Budget IA quotidien', () => {
  it('budget 0 : aucun appel IA autorisé, même sans aucune consommation (jamais illimité)', async () => {
    await expect(serviceWith(0, null).isExhausted()).resolves.toBe(true);
    await expect(serviceWith(0, 0).isExhausted()).resolves.toBe(true);
  });

  it('budget positif : autorisé tant que la consommation reste sous le plafond', async () => {
    await expect(serviceWith(1000, null).isExhausted()).resolves.toBe(false);
    await expect(serviceWith(1000, 999).isExhausted()).resolves.toBe(false);
    await expect(serviceWith(1000, 1000).isExhausted()).resolves.toBe(true);
  });
});
