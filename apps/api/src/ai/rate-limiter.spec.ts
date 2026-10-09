import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestRateLimiter } from './rate-limiter.js';

/** Horloge simulée (Date.now et setTimeout) : aucune attente réelle. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Lance `count` demandes simultanées et note l'instant où chacune obtient sa place. */
function acquireAll(limiter: RequestRateLimiter, count: number) {
  const startedAt: number[] = [];
  const order: number[] = [];
  const done = Promise.all(
    Array.from({ length: count }, (_, i) =>
      limiter.acquire().then(() => {
        startedAt[i] = Date.now();
        order.push(i);
      }),
    ),
  );
  return { startedAt, order, done };
}

describe('RequestRateLimiter', () => {
  it('5 requêtes/minute : une requête toutes les 12 s, dans l’ordre des demandes', async () => {
    const limiter = new RequestRateLimiter({ requestsPerMinute: 5 });
    const run = acquireAll(limiter, 7);
    await vi.advanceTimersByTimeAsync(80_000);
    await run.done;
    expect(run.startedAt).toEqual([0, 12_000, 24_000, 36_000, 48_000, 60_000, 72_000]);
    expect(run.order).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // Jamais plus de 5 départs dans une fenêtre de 60 s.
    for (const start of run.startedAt) {
      expect(
        run.startedAt.filter((t) => t >= start && t < start + 60_000).length,
      ).toBeLessThanOrEqual(5);
    }
  });

  it('aucune requête ne part avant sa place', async () => {
    const limiter = new RequestRateLimiter({ requestsPerMinute: 5 });
    const run = acquireAll(limiter, 2);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(run.order).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.order).toEqual([0, 1]);
  });

  it('pause commune après un 429 : plus aucun départ avant sa fin, puis reprise espacée', async () => {
    const limiter = new RequestRateLimiter({ requestsPerMinute: 5 });
    const first = acquireAll(limiter, 3); // places à 0, 12 s et 24 s
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.order).toEqual([0]);
    limiter.pause(42_000); // Google : « retryDelay: 42s » (jusqu'à t = 43 s)
    const later = acquireAll(limiter, 1);
    await vi.advanceTimersByTimeAsync(41_999);
    expect(first.order).toEqual([0]); // les places à 12 s et 24 s sont reportées
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([first.done, later.done]);
    // Après la pause : départs de nouveau espacés de 12 s, aucun avant t = 43 s.
    const resumed = [...first.startedAt.slice(1), ...later.startedAt].sort((a, b) => a - b);
    expect(resumed[0]).toBeGreaterThanOrEqual(43_000);
    expect(resumed[1]! - resumed[0]!).toBeGreaterThanOrEqual(12_000);
    expect(resumed[2]! - resumed[1]!).toBeGreaterThanOrEqual(12_000);
  });

  it('une pause plus courte ne raccourcit jamais la pause en cours', async () => {
    const limiter = new RequestRateLimiter({ requestsPerMinute: null });
    limiter.pause(30_000);
    limiter.pause(5_000);
    const run = acquireAll(limiter, 1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run.order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.startedAt).toEqual([30_000]);
  });

  it('sans espacement (null) : départs immédiats, seule la pause commune s’applique', async () => {
    const limiter = new RequestRateLimiter({ requestsPerMinute: null });
    const run = acquireAll(limiter, 4);
    await vi.advanceTimersByTimeAsync(0);
    await run.done;
    expect(run.startedAt).toEqual([0, 0, 0, 0]);
  });

  it('attente instantanée (tests) : jamais de boucle infinie après une pause', async () => {
    const limiter = new RequestRateLimiter({
      requestsPerMinute: 5,
      sleep: () => Promise.resolve(),
    });
    limiter.pause(60_000);
    await expect(Promise.all([limiter.acquire(), limiter.acquire()])).resolves.toBeDefined();
  });

  it('débit invalide refusé', () => {
    expect(() => new RequestRateLimiter({ requestsPerMinute: 0 })).toThrow();
  });
});
