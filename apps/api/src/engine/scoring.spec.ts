import { describe, expect, it } from 'vitest';
import { computeScore } from './scoring.js';

describe('computeScore', () => {
  it('donne 100 à un document sans problème', () => {
    expect(computeScore([], 10_000).score).toBe(100);
  });

  it('ne pénalise pas les points « à vérifier »', () => {
    const issues = Array.from({ length: 20 }, () => ({
      category: 'structure' as const,
      nature: 'verify' as const,
      severity: 'major' as const,
    }));
    expect(computeScore(issues, 10_000).score).toBe(100);
  });

  it('pénalise selon la densité et plafonne chaque catégorie', () => {
    const errors = Array.from({ length: 10 }, () => ({
      category: 'spelling' as const,
      nature: 'error' as const,
      severity: 'major' as const,
    }));
    const short = computeScore(errors, 2_000);
    const long = computeScore(errors, 20_000);
    expect(short.score).toBeLessThan(long.score);
    expect(short.penalties.spelling).toBeLessThanOrEqual(25);
  });
});
