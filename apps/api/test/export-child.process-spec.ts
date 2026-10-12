import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDocx } from '../src/docx/parser/docx-parser.js';
import type { TextEdit } from '../src/docx/writer/text-edits.js';
import { ExportChildRunner } from '../src/exports/export-child-runner.js';
import { buildDocx } from './fixtures/builders.js';

/**
 * Superviseur du processus enfant d'export et protocole parent-enfant : vrais
 * processus enfants, sans API, base ni Redis. Exécutés sous Linux (CI « Qualité et
 * tests ») et sous Windows (CI « Processus d'export sous Windows »).
 *
 * Contrôles de la mémoire de l'enfant : seulement là où le pic est lisible (Linux,
 * /proc), comme dans le superviseur. Ailleurs, les tests qui en dépendent sont
 * signalés « ignorés », jamais comptés comme réussis.
 */
const MEMORY_CHECKS = existsSync('/proc/self/status');

const SENTENCES = [
  'Une phrase avec une fote dans le rapport.',
  'Le rapport contient une erreurr importante.',
  'Ce paragraphe reste strictement inchangé.',
];

async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Délai dépassé : ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('Document corrigé : superviseur du processus enfant', () => {
  /** Document et correction des tests, appliqués directement par le superviseur. */
  async function job() {
    const source = await buildDocx(SENTENCES.map((p) => ({ p })));
    const block = (await parseDocx(source)).blocks.find((b) => b.text.includes('fote'));
    if (!block) throw new Error('bloc introuvable');
    const start = block.text.indexOf('fote');
    const edits = [
      {
        id: 'e',
        blockId: block.id,
        start,
        end: start + 4,
        expectedBlockText: block.text,
        expectedOriginal: 'fote',
        replacement: 'faute',
      },
    ];
    return { source, edits };
  }

  it('export normal : résultat accepté, fichier corrigé complet', async () => {
    const { source, edits } = await job();
    const outcome = await new ExportChildRunner({ memoryLimitMb: 1280, timeoutMs: 120_000 }).run(
      source,
      edits,
    );
    expect(outcome).toMatchObject({ kind: 'done', applied: ['e'], skipped: [] });
    if (outcome.kind !== 'done' || !outcome.file) throw new Error('fichier attendu');
    const text = (await parseDocx(outcome.file)).blocks.map((b) => b.text).join('\n');
    expect(text).toContain('une faute dans le rapport');
  }, 60_000);

  it.runIf(MEMORY_CHECKS)(
    'mémoire dépassée : détectée par la surveillance ou au contrôle final, jamais acceptée',
    async () => {
      const { source, edits } = await job();
      // Limite inférieure à la mémoire de démarrage de tout processus Node.js.
      const outcome = await new ExportChildRunner({ memoryLimitMb: 1, timeoutMs: 120_000 }).run(
        source,
        edits,
      );
      expect(outcome.kind).toBe('too_large');
      expect(['memory', 'peak']).toContain(outcome.kind === 'too_large' ? outcome.cause : null);
    },
    60_000,
  );

  it.runIf(MEMORY_CHECKS)(
    'mémoire dépassée entre deux mesures (enfant rapide) : refusée au contrôle final du pic',
    async () => {
      const { source, edits } = await job();
      const runner = new ExportChildRunner({ memoryLimitMb: 40, timeoutMs: 120_000 });
      // Sans aucune mesure périodique : seul le contrôle du pic à la fin peut agir, ce qui
      // reproduit un enfant terminé avant la première mesure (machine rapide).
      Object.defineProperty(runner, 'periodicWatch', { value: false });
      expect(await runner.run(source, edits)).toEqual({ kind: 'too_large', cause: 'peak' });
    },
    60_000,
  );

  /**
   * Enfant de test renvoyant un fichier de 150 Mo. Mesuré : pic d'environ 233 Mo avant
   * l'envoi, 383 Mo après la sérialisation et l'envoi. Surveillance périodique
   * désactivée : seul le contrôle final, après réception complète, peut voir ce pic.
   */
  function largeResultRunner(memoryLimitMb: number) {
    const runner = new ExportChildRunner({ memoryLimitMb, timeoutMs: 120_000 });
    Object.defineProperty(runner, 'periodicWatch', { value: false });
    Object.defineProperty(runner, 'child', {
      value: {
        path: fileURLToPath(new URL('./fixtures/protocol-child.ts', import.meta.url)),
        execArgv: ['--import', import.meta.resolve('tsx')],
      },
    });
    const edits = Array.from({ length: 150 }, () => ({}) as TextEdit);
    return { run: () => runner.run(Buffer.from('x'), edits) };
  }

  it.runIf(MEMORY_CHECKS)(
    'pic atteint pendant l’envoi du fichier (après toute mesure de l’enfant) : résultat refusé',
    async () => {
      // 310 Mo : au-dessus du pic avant l'envoi (~233), au-dessous du pic réel (~383).
      expect(await largeResultRunner(310).run()).toEqual({ kind: 'too_large', cause: 'peak' });
    },
    60_000,
  );

  it('même résultat sous une limite suffisante : accepté (pas de refus à tort)', async () => {
    const outcome = await largeResultRunner(600).run();
    expect(outcome.kind).toBe('done');
    expect(outcome.kind === 'done' ? outcome.file?.length : 0).toBe(150 * 1024 * 1024);
  }, 60_000);

  it('sans lecture du pic (Windows, macOS) : aucun contrôle mémoire par WordFix — limite connue', async () => {
    // Reproduit, sur tout système, le fonctionnement sans /proc : seuls le plafond du tas,
    // le délai et la limite de l'environnement protègent alors. Ce test fixe cette
    // limite connue : il échouera si le comportement change sans mise à jour des docs.
    const { source, edits } = await job();
    const runner = new ExportChildRunner({ memoryLimitMb: 1, timeoutMs: 120_000 });
    Object.defineProperty(runner, 'canWatchMemory', { value: false });
    expect(await runner.run(source, edits)).toMatchObject({ kind: 'done', applied: ['e'] });
  }, 60_000);

  it('délai dépassé : distingué d’un dépassement mémoire', async () => {
    const { source, edits } = await job();
    expect(
      await new ExportChildRunner({ memoryLimitMb: 4096, timeoutMs: 1 }).run(source, edits),
    ).toEqual({ kind: 'timeout' });
  }, 60_000);
});

describe('Document corrigé : protocole parent-enfant (fin garantie de l’enfant)', () => {
  const PROTOCOL_CHILD = fileURLToPath(new URL('./fixtures/protocol-child.ts', import.meta.url));
  const DYING_SERVICE = fileURLToPath(
    new URL('./fixtures/dying-export-service.ts', import.meta.url),
  );

  /**
   * Processus encore vivant. Linux : un processus terminé mais pas encore récupéré
   * (« zombie ») ne compte pas. Ailleurs : test d'existence par le signal 0.
   */
  function isAlive(pid: number): boolean {
    if (existsSync('/proc/self/stat')) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
      } catch {
        return false;
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM : le processus existe mais appartient à un autre utilisateur.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  it('la vérification de fin de processus détecte bien un processus vivant', () => {
    // Garde-fou : sans elle, « pas vivant » pourrait être répondu faute de pouvoir lire.
    expect(isAlive(process.pid)).toBe(true);
  });

  /** Superviseur branché sur l'enfant de test, dans le comportement demandé. */
  function protocolRun(
    mode: 'silent' | 'stubborn' | 'normal',
    timeoutMs: number,
    releaseGraceMs?: number,
  ) {
    const runner = new ExportChildRunner({ memoryLimitMb: 1280, timeoutMs });
    if (releaseGraceMs !== undefined) {
      Object.defineProperty(runner, 'releaseGraceMs', { value: releaseGraceMs });
    }
    Object.defineProperty(runner, 'child', {
      value: { path: PROTOCOL_CHILD, execArgv: ['--import', import.meta.resolve('tsx')] },
    });
    const pidFile = join(mkdtempSync(join(tmpdir(), 'wordfix-child-')), 'pid');
    const edits = [{ ...(mode === 'normal' ? {} : { mode }), pidFile } as unknown as TextEdit];
    return {
      runner,
      run: () => runner.run(Buffer.from('x'), edits),
      pid: () => Number(readFileSync(pidFile, 'utf8')),
    };
  }

  async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
    const start = Date.now();
    const value = await work();
    return { value, ms: Date.now() - start };
  }

  it('enfant qui ne répond jamais : arrêté au délai, résultat « délai dépassé »', async () => {
    const child = protocolRun('silent', 1500);
    const { value, ms } = await timed(child.run);
    expect(value).toEqual({ kind: 'timeout' });
    expect(ms).toBeLessThan(10_000);
    expect(isAlive(child.pid())).toBe(false);
  }, 30_000);

  it('réponse normale : l’enfant se termine dès sa libération, bien avant le délai', async () => {
    const child = protocolRun('normal', 120_000);
    const { value, ms } = await timed(child.run);
    expect(value).toMatchObject({ kind: 'done', applied: ['e'] });
    expect(ms).toBeLessThan(10_000);
    expect(isAlive(child.pid())).toBe(false);
  }, 30_000);

  it('libération ignorée : enfant arrêté après le délai de grâce, résultat reçu conservé', async () => {
    const child = protocolRun('stubborn', 120_000);
    const { value, ms } = await timed(child.run);
    expect(value).toMatchObject({ kind: 'done', applied: ['e'] });
    // Délai de grâce de 2 s, et non le délai global de 120 s.
    expect(ms).toBeGreaterThanOrEqual(1900);
    expect(ms).toBeLessThan(15_000);
    expect(isAlive(child.pid())).toBe(false);
  }, 30_000);

  it('libération impossible à envoyer : enfant arrêté aussitôt, résultat reçu conservé', async () => {
    // Délai de grâce de 60 s : seul l'arrêt immédiat permet de finir avant 20 s, quelle
    // que soit la durée de démarrage de l'enfant.
    const child = protocolRun('stubborn', 120_000, 60_000);
    // Le canal refuse le message de libération (et lui seul).
    const runner = child.runner as unknown as { spawnChild: () => ChildProcess };
    const spawnChild = runner.spawnChild.bind(runner);
    Object.defineProperty(runner, 'spawnChild', {
      value: () => {
        const spawned = spawnChild();
        const send = spawned.send.bind(spawned) as (...args: unknown[]) => boolean;
        spawned.send = (...args: unknown[]) => {
          const [message, callback] = args as [{ kind?: string }, (e: Error | null) => void];
          if (message?.kind === 'release') {
            queueMicrotask(() => callback(new Error('canal indisponible')));
            return false;
          }
          return send(...args);
        };
        return spawned;
      },
    });
    const { value, ms } = await timed(child.run);
    expect(value).toMatchObject({ kind: 'done', applied: ['e'] });
    expect(ms).toBeLessThan(20_000);
    expect(isAlive(child.pid())).toBe(false);
  }, 30_000);

  it('délai expiré après la réponse : résultat reçu conservé, enfant arrêté', async () => {
    // Délai global de 10 s, délai de grâce de 60 s : c'est le délai global qui arrête
    // l'enfant, longtemps après sa réponse (démarrage mesuré : ~1 s, ~1,5 s sous charge).
    const child = protocolRun('stubborn', 10_000, 60_000);
    const { value, ms } = await timed(child.run);
    expect(value).toMatchObject({ kind: 'done', applied: ['e'] });
    expect(ms).toBeGreaterThanOrEqual(9_900);
    expect(ms).toBeLessThan(25_000);
    expect(isAlive(child.pid())).toBe(false);
  }, 40_000);

  it.each(['before', 'after'] as const)(
    'service d’export arrêté brutalement (%s la réponse) : le vrai enfant ne lui survit pas',
    async (phase) => {
      const service = spawn(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), DYING_SERVICE, phase],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let output = '';
      service.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      await new Promise((done) => service.on('close', done));
      const pid = Number(output.trim());
      expect(pid).toBeGreaterThan(0);
      await waitFor(
        () => Promise.resolve(isAlive(pid)),
        (alive) => !alive,
        10_000,
      );
    },
    30_000,
  );
});
