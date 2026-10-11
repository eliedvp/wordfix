import { type ChildProcess, fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TextEdit, TextEditSkipReason } from '../docx/writer/text-edits.js';
import type { ChildRequest, ChildResponse } from './export-child.js';

/** Limites d'un export (configuration EXPORT_MEMORY_LIMIT_MB et EXPORT_TIMEOUT_MS). */
export interface ExportLimits {
  memoryLimitMb: number;
  timeoutMs: number;
}

export const EXPORT_LIMITS = Symbol('EXPORT_LIMITS');

/** Plafond du tas JavaScript de l'enfant : un échec net avant la surveillance de la mémoire. */
const CHILD_HEAP_MB = 1024;
const WATCH_INTERVAL_MS = 200;

export type ChildOutcome =
  | {
      kind: 'done';
      file: Buffer | null;
      applied: string[];
      skipped: { id: string; reason: TextEditSkipReason }[];
    }
  /** Arrêté pour la mémoire : surveillance, plafond du tas, ou arrêt externe (noyau). */
  | { kind: 'too_large'; cause: 'memory' | 'heap' | 'killed' }
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
  private readonly canWatchMemory = existsSync('/proc/self/status');

  constructor(@Inject(EXPORT_LIMITS) private readonly limits: ExportLimits) {
    if (!this.canWatchMemory) {
      this.logger.warn(
        'Surveillance mémoire des exports indisponible sur ce système (pas de /proc) : seuls le plafond du tas et le délai s’appliquent',
      );
    }
  }

  run(source: Buffer, edits: TextEdit[]): Promise<ChildOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let killedFor: 'memory' | 'timeout' | 'ipc' | null = null;
      let response: ChildResponse | null = null;

      const child: ChildProcess = fork(this.child.path, [], {
        execArgv: [...this.child.execArgv, `--max-old-space-size=${CHILD_HEAP_MB}`],
        env: { NODE_ENV: process.env.NODE_ENV ?? 'production', NODE_OPTIONS: '' },
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });

      const kill = (cause: 'memory' | 'timeout' | 'ipc') => {
        // Enfant déjà sorti de lui-même : sa sortie décide (pas d'arrêt attribué à tort).
        if (killedFor || settled || child.exitCode !== null || child.signalCode !== null) return;
        killedFor = cause;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => kill('timeout'), this.limits.timeoutMs);
      const watch = this.canWatchMemory
        ? setInterval(() => {
            const rssMb = residentMemoryMb(child.pid);
            if (rssMb !== null && rssMb > this.limits.memoryLimitMb) kill('memory');
          }, WATCH_INTERVAL_MS)
        : null;

      const finish = (outcome: ChildOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (watch) clearInterval(watch);
        resolve(outcome);
      };

      child.on('message', (message: ChildResponse) => {
        response = message;
      });
      child.on('error', () => {
        // Lancement impossible (ou signal non délivré) : aucun enfant ne doit survivre.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        finish({ kind: 'error', problem: 'child_spawn' });
      });
      // 'close' (et non 'exit') : le dernier message de l'enfant est forcément reçu avant.
      child.on('close', (code, signal) => {
        if (response?.kind === 'done') {
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

/** Mémoire résidente d'un processus, en Mo (Linux, /proc), ou null si indisponible. */
function residentMemoryMb(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = /VmRSS:\s+(\d+)\s+kB/.exec(status)?.[1];
    return kb ? Number(kb) / 1024 : null;
  } catch {
    return null;
  }
}
