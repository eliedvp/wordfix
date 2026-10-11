/**
 * Processus enfant de test, même protocole que src/exports/export-child.ts, avec des
 * comportements choisis par la première « correction » reçue :
 * - par défaut : renvoie un « fichier » de N Mo (N = nombre de corrections). Sa
 *   sérialisation et son envoi ajoutent environ N Mo au pic de mémoire, APRÈS toute
 *   mesure que l'enfant ferait sur lui-même avant l'envoi (`peakKb`) ;
 * - `silent` : ne répond jamais (enfant bloqué) ;
 * - `stubborn` : répond, puis ignore la libération et la fermeture du canal.
 * `pidFile` : l'enfant y écrit son numéro de processus (vérification de sa fin).
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Mode {
  mode?: 'silent' | 'stubborn';
  pidFile?: string;
}

/** Pic de mémoire mesuré par l'enfant lui-même (Linux), à titre indicatif ; null ailleurs. */
const peakKb = (): number | null => {
  try {
    return Number(/VmHWM:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]);
  } catch {
    return null;
  }
};

// Filet de sécurité du test : même un enfant « obstiné » ne survit pas à une exécution
// de tests interrompue (le superviseur, lui, l'arrête bien avant).
setTimeout(() => process.exit(0), 60_000);

let replied = false;
const onDisconnect = () => process.exit(replied ? 0 : 1);
process.once('disconnect', onDisconnect);
process.once('message', (message: { edits: Mode[] }) => {
  const options = message.edits[0] ?? {};
  if (options.pidFile) writeFileSync(options.pidFile, String(process.pid));
  if (options.mode === 'silent') {
    setInterval(() => undefined, 1000);
    return;
  }
  const size = options.mode === 'stubborn' ? 1 : message.edits.length;
  const file = Buffer.alloc(size * 1024 * 1024, 1);
  replied = true;
  process.send?.({ kind: 'done', file, applied: ['e'], skipped: [], peakKb: peakKb() });
  if (options.mode === 'stubborn') {
    process.off('disconnect', onDisconnect);
    process.on('disconnect', () => undefined);
    process.on('message', () => undefined);
    setInterval(() => undefined, 1000);
    return;
  }
  process.once('message', () => process.exit(0)); // libération par le parent
});
