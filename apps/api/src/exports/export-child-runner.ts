import { type ChildProcess, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TextEdit, TextEditSkipReason } from '../docx/writer/text-edits.js';
import type { ChildRequest, ChildResponse } from './export-child.js';
import { peakMemoryKb } from './process-memory.js';

/** Limites d'un export (configuration EXPORT_MEMORY_LIMIT_MB et EXPORT_TIMEOUT_MS). */
export interface ExportLimits {
  memoryLimitMb: number;
  timeoutMs: number;
}

export const EXPORT_LIMITS = Symbol('EXPORT_LIMITS');

/** Plafond du tas JavaScript de l'enfant : un échec net avant la surveillance de la mémoire. */
const CHILD_HEAP_MB = 1024;
/**
 * Surveillance périodique du pic de mémoire de l'enfant : première mesure 25 ms après
 * son lancement, puis l'écart double (50, 100 ms) jusqu'à 200 ms, soit des mesures à
 * environ 25, 75, 175, 375 ms, puis toutes les 200 ms. Un pic survenu entre deux
 * mesures, ou après la dernière, est vu par le contrôle final (après réception
 * complète de la réponse).
 */
const WATCH_FIRST_DELAY_MS = 25;
const WATCH_INTERVAL_MS = 200;
/**
 * Après sa réponse, l'enfant n'a plus rien à faire : s'il n'est pas sorti dans ce délai
 * après le message de libération (libération perdue, enfant bloqué), il est arrêté.
 */
const RELEASE_GRACE_MS = 2000;

export type ChildOutcome =
  | {
      kind: 'done';
      file: Buffer | null;
      applied: string[];
      skipped: { id: string; reason: TextEditSkipReason }[];
    }
  /**
   * Mémoire dépassée : arrêté par la surveillance (`memory`), pic constaté à la fin
   * avant d'accepter le résultat (`peak`), plafond du tas (`heap`) ou arrêt externe,
   * en pratique le noyau (`killed`).
   */
  | { kind: 'too_large'; cause: 'memory' | 'peak' | 'heap' | 'killed' }
  /** Arrêté : délai dépassé. */
  | { kind: 'timeout' }
  /** Panne inattendue (lancement, échange avec l'enfant, sortie anormale). */
  | { kind: 'error'; problem: string };

/**
 * Exécute un export dans un processus enfant éphémère : si sa mémoire déborde, seul
 * l'enfant est arrêté (par la surveillance ci-dessous, le plafond du tas, ou le noyau
 * quand le conteneur a une limite mémoire) ; le service d'export survit et enregistre
 * l'échec. L'enfant n'hérite d'aucune variable d'environnement (ni secret, ni
 * NODE_OPTIONS qui pourrait changer ses limites).
 */
@Injectable()
export class ExportChildRunner {
  private readonly logger = new Logger(ExportChildRunner.name);
  private readonly child = childEntry();
  /** Pic de mémoire lisible (Linux, /proc) : surveillance périodique et contrôle final. */
  private readonly canWatchMemory = existsSync('/proc/self/status');
  /** Surveillance périodique (désactivable en test pour isoler le contrôle final). */
  private readonly periodicWatch = true;
  /** Délai de grâce après la libération (réglable en test). */
  private readonly releaseGraceMs = RELEASE_GRACE_MS;

  constructor(@Inject(EXPORT_LIMITS) private readonly limits: ExportLimits) {
    if (!this.canWatchMemory) {
      this.logger.warn(
        'Surveillance mémoire des exports indisponible sur ce système (pas de /proc) : seuls le plafond du tas, le délai et la limite de l’environnement s’appliquent',
      );
    }
  }

  /** Lancement de l'enfant (remplaçable en test pour simuler une panne du canal). */
  private spawnChild(): ChildProcess {
    return fork(this.child.path, [], {
      execArgv: [...this.child.execArgv, `--max-old-space-size=${CHILD_HEAP_MB}`],
      env: { NODE_ENV: process.env.NODE_ENV ?? 'production', NODE_OPTIONS: '' },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  }

  run(source: Buffer, edits: TextEdit[]): Promise<ChildOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let killedFor: 'memory' | 'timeout' | 'ipc' | null = null;
      let response: ChildResponse | null = null;

      const child = this.spawnChild();

      const kill = (cause: 'memory' | 'timeout' | 'ipc') => {
        // Enfant déjà sorti de lui-même : sa sortie décide (pas d'arrêt attribué à tort).
        if (killedFor || settled || child.exitCode !== null || child.signalCode !== null) return;
        killedFor = cause;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => kill('timeout'), this.limits.timeoutMs);
      const overLimit = (kb: number | null) => kb !== null && kb / 1024 > this.limits.memoryLimitMb;
      // Surveillance périodique du pic de mémoire (voir WATCH_FIRST_DELAY_MS).
      let watch: NodeJS.Timeout | null = null;
      const pid = child.pid;
      const check = (childPid: number, delay: number) => {
        if (settled || killedFor) return;
        if (overLimit(peakMemoryKb(childPid))) {
          kill('memory');
          return;
        }
        watch = setTimeout(() => check(childPid, Math.min(delay * 2, WATCH_INTERVAL_MS)), delay);
      };
      if (this.canWatchMemory && this.periodicWatch && pid !== undefined) {
        const first = pid;
        watch = setTimeout(() => check(first, WATCH_FIRST_DELAY_MS * 2), WATCH_FIRST_DELAY_MS);
      }

      let releaseTimer: NodeJS.Timeout | null = null;
      const finish = (outcome: ChildOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (releaseTimer) clearTimeout(releaseTimer);
        if (watch) clearTimeout(watch);
        resolve(outcome);
      };

      // Pic de mémoire de l'enfant lu après réception complète de sa réponse : il
      // couvre le calcul, la préparation, la sérialisation et l'envoi du fichier.
      let finalPeakKb: number | null = null;
      child.on('message', (message: ChildResponse) => {
        if (response) return;
        response = message;
        if (this.canWatchMemory && pid !== undefined) finalPeakKb = peakMemoryKb(pid);
        // L'enfant attend ce message de libération pour se terminer (lui-même : si le
        // parent fermait le canal, Node n'émettrait pas l'événement 'close').
        // Libération impossible : arrêt immédiat. Libération ignorée ou perdue : arrêt
        // au bout de RELEASE_GRACE_MS. La réponse, déjà reçue en entier, décide du
        // résultat (killedFor ne sert qu'en l'absence de réponse).
        releaseTimer = setTimeout(() => kill('ipc'), this.releaseGraceMs);
        if (!child.connected) {
          kill('ipc');
          return;
        }
        child.send({ kind: 'release' }, (error) => {
          if (error) kill('ipc');
        });
      });
      child.on('error', () => {
        // Lancement impossible (ou signal non délivré) : aucun enfant ne doit survivre.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        finish({ kind: 'error', problem: 'child_spawn' });
      });
      // 'close' (et non 'exit') : le dernier message de l'enfant est forcément reçu avant.
      child.on('close', (code, signal) => {
        if (response?.kind === 'done' && this.canWatchMemory && finalPeakKb === null) {
          // Pic complet illisible (enfant disparu avant la mesure) : rien ne permet
          // d'affirmer que la limite a été respectée, le résultat n'est pas accepté.
          finish({ kind: 'error', problem: 'child_peak_unavailable' });
        } else if (response?.kind === 'done' && overLimit(finalPeakKb)) {
          // Pic au-delà de la limite entre deux mesures (enfant rapide, ou pendant
          // l'envoi du fichier) : même règle que la surveillance, résultat refusé.
          finish({ kind: 'too_large', cause: 'peak' });
        } else if (response?.kind === 'done') {
          const file = response.file
            ? Buffer.from(response.file.buffer, response.file.byteOffset, response.file.byteLength)
            : null;
          finish({
            kind: 'done',
            file,
            applied: response.applied,
            skipped: response.skipped as { id: string; reason: TextEditSkipReason }[],
          });
        } else if (response?.kind === 'error') {
          finish(response);
        } else if (killedFor === 'timeout') {
          finish({ kind: 'timeout' });
        } else if (killedFor === 'memory') {
          finish({ kind: 'too_large', cause: 'memory' });
        } else if (killedFor === 'ipc') {
          finish({ kind: 'error', problem: 'child_ipc' });
        } else if (signal === 'SIGKILL') {
          // Arrêt sans demande de notre part : en pratique, le noyau (limite du conteneur).
          finish({ kind: 'too_large', cause: 'killed' });
        } else if (signal === 'SIGABRT' || code === 134) {
          // Plafond du tas JavaScript atteint (V8 interrompt le processus).
          finish({ kind: 'too_large', cause: 'heap' });
        } else {
          finish({ kind: 'error', problem: `child_exit_${code ?? signal ?? 'unknown'}` });
        }
      });

      const request: ChildRequest = { source, edits };
      child.send(request, (error) => {
        if (error) kill('ipc');
      });
    });
  }
}

/** Fichier du processus enfant : JavaScript compilé, ou TypeScript via tsx (tests, dev). */
function childEntry(): { path: string; execArgv: string[] } {
  const typescript = import.meta.url.endsWith('.ts');
  return {
    path: fileURLToPath(new URL(`./export-child.${typescript ? 'ts' : 'js'}`, import.meta.url)),
    execArgv: typescript ? ['--import', import.meta.resolve('tsx')] : [],
  };
}
