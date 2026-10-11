import { readFileSync } from 'node:fs';

/**
 * Pic de mémoire résidente d'un processus depuis son lancement (`VmHWM`, Linux,
 * /proc), en Ko, ou null si indisponible (autre système, processus terminé).
 *
 * Le pic, et non la mémoire du moment (`VmRSS`) : une hausse brève entre deux
 * mesures reste visible à la mesure suivante. Il ne compte que la mémoire du
 * processus lui-même, à la différence de `process.resourceUsage().maxRSS`, qui
 * inclut celle du parent au moment du lancement (mesuré : 600 Mo hérités).
 */
export function peakMemoryKb(pid: number | 'self'): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = /VmHWM:\s+(\d+)\s+kB/.exec(status)?.[1];
    return kb ? Number(kb) : null;
  } catch {
    return null;
  }
}
