import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { LANGUAGE_ENGINE_CONFIG } from '../config.js';

/**
 * Client de Grammalecte (correcteur grammatical français, GPL-3.0).
 *
 * Grammalecte est écrit en Python : il tourne dans un processus enfant distinct
 * (`vendor/grammalecte/bridge.py`), lancé UNE SEULE FOIS par worker et réutilisé
 * pour tous les documents. Le worker lui envoie des lots de paragraphes en JSON
 * sur l'entrée standard et lit les erreurs sur la sortie standard. Aucun appel
 * réseau ; aucun code GPL n'est chargé dans le processus Node.js (voir
 * docs/language-engine.md, « Licence de Grammalecte »).
 *
 * Robustesse : une requête à la fois (file d'attente), délai maximal par lot ;
 * en cas d'échec ou de délai dépassé, le processus est arrêté et relancé à la
 * demande suivante. Le texte analysé n'est jamais journalisé.
 */

/** Erreur brute renvoyée par le pont (positions en unités UTF-16). */
export interface GrammalecteError {
  start: number;
  end: number;
  ruleId: string;
  /** Option Grammalecte de la règle (gn, conj, conf…), « notype » si aucune. */
  type: string;
  message: string;
  suggestions: string[];
}

export interface GrammalecteOptions {
  /** Interpréteur Python 3 (≥ 3.9). */
  python: string;
  /** Options Grammalecte activées (règles de grammaire) ; toutes les autres sont désactivées. */
  enabledOptions: readonly string[];
  /** Délai maximal de démarrage (chargement des règles). */
  startTimeoutMs: number;
  /** Délai maximal pour un lot de paragraphes. */
  requestTimeoutMs: number;
}

export interface GrammalecteStats {
  /** Lancements du processus Python (1 en fonctionnement normal). */
  starts: number;
  /** Arrêts dus à une erreur ou à un délai dépassé. */
  failures: number;
  /** Durée du dernier chargement des règles, mesurée par le pont. */
  loadMs: number | null;
  version: string | null;
  requests: number;
}

export const DEFAULT_GRAMMALECTE_OPTIONS: GrammalecteOptions = {
  python: process.platform === 'win32' ? 'python' : 'python3',
  enabledOptions: Object.keys(LANGUAGE_ENGINE_CONFIG.grammar.types),
  startTimeoutMs: 30_000,
  requestTimeoutMs: 60_000,
};

const VENDOR_FILES = { bridge: 'bridge.py', archive: 'grammalecte-2.3.0.zip' };

/** Dossier `vendor/grammalecte` du paquet API (depuis src/ comme depuis dist/). */
export function grammalecteVendorDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'vendor', 'grammalecte');
    if (existsSync(join(candidate, VENDOR_FILES.bridge))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('Grammalecte introuvable : dossier vendor/grammalecte absent.');
}

/**
 * Variables d'environnement transmises au processus Python : le strict
 * nécessaire. Les secrets du worker (clé OpenAI, base, Redis, stockage) ne lui
 * sont jamais transmis.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

interface Pending {
  id: number;
  resolve: (results: (GrammalecteError[] | null)[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class GrammalecteClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private stopped = false;
  private readonly stats: GrammalecteStats = {
    starts: 0,
    failures: 0,
    loadMs: null,
    version: null,
    requests: 0,
  };

  constructor(private readonly options: GrammalecteOptions = DEFAULT_GRAMMALECTE_OPTIONS) {}

  /** Lance le processus si nécessaire ; les appels simultanés partagent le même lancement. */
  start(): Promise<void> {
    this.stopped = false;
    if (this.child) return Promise.resolve();
    this.starting ??= this.spawnBridge().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Analyse un lot de paragraphes. Les lots sont traités l'un après l'autre :
   * un seul processus, aucune instance supplémentaire.
   */
  check(paragraphs: readonly string[]): Promise<(GrammalecteError[] | null)[]> {
    const run = this.queue.then(() => this.send(paragraphs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  getStats(): Readonly<GrammalecteStats> {
    return { ...this.stats };
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Arrête le processus (fin du worker). */
  stop(): void {
    this.stopped = true;
    this.kill(new Error('Grammalecte arrêté.'));
  }

  private async send(paragraphs: readonly string[]): Promise<(GrammalecteError[] | null)[]> {
    if (paragraphs.length === 0) return [];
    if (this.stopped) throw new Error('Grammalecte arrêté.');
    await this.start();
    const child = this.child;
    if (!child) throw new Error('Grammalecte indisponible.');
    const id = this.nextId++;
    this.stats.requests++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stats.failures++;
        this.kill(new Error(`Grammalecte : délai de ${this.options.requestTimeoutMs} ms dépassé.`));
      }, this.options.requestTimeoutMs);
      this.pending = { id, resolve, reject, timer };
      child.stdin.write(`${JSON.stringify({ id, paragraphs })}\n`);
    });
  }

  private spawnBridge(): Promise<void> {
    const dir = grammalecteVendorDir();
    const child = spawn(
      this.options.python,
      [
        '-I',
        join(dir, VENDOR_FILES.bridge),
        join(dir, VENDOR_FILES.archive),
        this.options.enabledOptions.join(','),
      ],
      { cwd: dir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.stats.starts++;

    return new Promise<void>((resolve, reject) => {
      let ready = false;
      let stderr = '';
      const fail = (error: Error) => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        this.stats.failures++;
        child.kill('SIGKILL');
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error('Grammalecte : démarrage trop long.')),
        this.options.startTimeoutMs,
      );

      child.on('error', (error) =>
        fail(new Error(`Grammalecte : lancement impossible (${error.message}).`)),
      );
      // Écriture vers un processus arrêté : l'erreur est gérée par 'exit', pas d'exception.
      child.stdin.on('error', () => undefined);
      // Seules les dernières lignes d'erreur Python sont gardées (jamais de texte de document).
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000);
      });
      child.on('exit', (code) => {
        fail(new Error(`Grammalecte : arrêt au démarrage (code ${code}). ${lastLine(stderr)}`));
        if (this.child === child) {
          this.child = null;
          this.rejectPending(new Error(`Grammalecte : processus arrêté (code ${code}).`));
        }
      });

      createInterface({ input: child.stdout }).on('line', (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!ready) {
          if (isReady(message)) {
            ready = true;
            clearTimeout(timer);
            this.stats.loadMs = message.loadMs;
            this.stats.version = message.version;
            this.child = child;
            resolve();
          }
          return;
        }
        this.onResponse(message);
      });
    });
  }

  private onResponse(message: unknown): void {
    const pending = this.pending;
    if (!pending || !isObject(message) || message.id !== pending.id) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (Array.isArray(message.results)) {
      pending.resolve(message.results.map(parseErrors));
    } else {
      pending.reject(new Error(`Grammalecte : requête en échec (${String(message.error)}).`));
    }
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private kill(error: Error): void {
    const child = this.child;
    this.child = null;
    this.rejectPending(error);
    if (child) {
      child.stdin.end();
      child.kill('SIGKILL');
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isReady(value: unknown): value is { loadMs: number; version: string } {
  return isObject(value) && value.type === 'ready';
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? '';
}

/** Valide la réponse du pont : une erreur mal formée est ignorée. */
function parseErrors(value: unknown): GrammalecteError[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item): GrammalecteError[] => {
    if (!isObject(item)) return [];
    const { start, end, ruleId, type, message, suggestions } = item;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
    return [
      {
        start: start as number,
        end: end as number,
        ruleId: typeof ruleId === 'string' ? ruleId : '',
        type: typeof type === 'string' ? type : '',
        message: typeof message === 'string' ? message : '',
        suggestions: Array.isArray(suggestions)
          ? suggestions.filter((s): s is string => typeof s === 'string')
          : [],
      },
    ];
  });
}

// --- Instance unique du worker ---------------------------------------------------

let shared: GrammalecteClient | null = null;
let sharedOptions: GrammalecteOptions = DEFAULT_GRAMMALECTE_OPTIONS;

/** Réglages de l'instance unique (à appeler avant le premier usage). */
export function configureGrammalecte(options: Partial<GrammalecteOptions>): void {
  sharedOptions = { ...sharedOptions, ...options };
}

/** Le client unique du processus : créé au premier appel, jamais dupliqué. */
export function getGrammalecte(): GrammalecteClient {
  shared ??= new GrammalecteClient(sharedOptions);
  return shared;
}

export function stopGrammalecte(): void {
  shared?.stop();
}
