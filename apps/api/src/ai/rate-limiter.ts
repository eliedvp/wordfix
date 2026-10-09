/**
 * Limiteur de débit partagé par tous les appels d'un fournisseur d'IA dans le
 * processus (tous les morceaux de toutes les analyses du worker).
 *
 * - Espacement : deux requêtes partent au moins `60 s / requestsPerMinute` l'une après
 *   l'autre. Le débit reste lissé, sans rafale en début de minute : aucune fenêtre de
 *   60 s ne contient plus de `requestsPerMinute` requêtes. Les requêtes partent dans
 *   l'ordre où elles ont été demandées.
 * - Pause commune : quand le fournisseur répond 429 avec un délai (`retryDelay`), plus
 *   aucune requête ne part avant la fin de ce délai. Les appels en attente ne relancent
 *   donc pas tous en même temps la requête qui vient d'être refusée.
 *
 * Portée : un seul processus. Le fournisseur est un singleton du worker, donc le
 * limiteur est partagé par toutes les analyses de ce worker. Plusieurs workers qui
 * utilisent la même clé ne se coordonnent pas : il faut alors répartir le quota
 * entre eux (GEMINI_REQUESTS_PER_MINUTE).
 */
export interface RequestRateLimiterOptions {
  /** Requêtes autorisées par minute ; null : pas d'espacement (seule la pause commune s'applique). */
  requestsPerMinute: number | null;
  /** Horloge et attente, remplaçables en test. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RequestRateLimiter {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Premier instant où la prochaine requête pourra partir. */
  private nextSlotAt = 0;
  /** Fin de la pause commune en cours (après un 429). */
  private pausedUntil = 0;
  /** Incrémenté à chaque nouvelle pause : une place réservée avant elle est revue. */
  private pauseGeneration = 0;

  constructor(options: RequestRateLimiterOptions) {
    const rpm = options.requestsPerMinute;
    if (rpm !== null && !(rpm > 0)) throw new Error('requestsPerMinute doit être positif');
    this.intervalMs = rpm === null ? 0 : 60_000 / rpm;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Attend le moment où une requête peut partir, puis le réserve. La réservation est
   * faite avant l'attente, sans `await` entre la lecture et l'écriture de
   * `nextSlotAt` : deux appels simultanés n'obtiennent jamais la même place.
   */
  async acquire(): Promise<void> {
    for (;;) {
      const generation = this.pauseGeneration;
      const now = this.now();
      const at = Math.max(now, this.nextSlotAt, this.pausedUntil);
      this.nextSlotAt = at + this.intervalMs;
      if (at > now) await this.sleep(at - now);
      // Une pause décidée pendant l'attente et qui couvre la place réservée :
      // nouvelle réservation après la pause. La boucle ne recommence qu'après une
      // nouvelle pause, donc elle s'arrête toujours.
      if (this.pauseGeneration === generation || this.pausedUntil <= at) return;
    }
  }

  /** Suspend toutes les requêtes pendant `ms` (délai demandé par le fournisseur). */
  pause(ms: number): void {
    const until = this.now() + ms;
    if (until <= this.pausedUntil) return;
    this.pausedUntil = until;
    this.nextSlotAt = Math.max(this.nextSlotAt, until);
    this.pauseGeneration++;
  }
}
