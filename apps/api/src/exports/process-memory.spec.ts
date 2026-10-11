import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { peakMemoryKb } from './process-memory.js';

describe('peakMemoryKb', () => {
  it.runIf(existsSync('/proc/self/status'))(
    'pic du processus courant, au moins sa mémoire actuelle',
    () => {
      const peak = peakMemoryKb('self');
      expect(peak).not.toBeNull();
      expect(peak).toBeGreaterThanOrEqual(Math.floor(process.memoryUsage().rss / 1024) * 0.9);
    },
  );

  it('processus inexistant : null (aucune exception)', () => {
    expect(peakMemoryKb(2 ** 30)).toBeNull();
  });
});
