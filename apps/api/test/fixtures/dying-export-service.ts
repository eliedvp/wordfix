/**
 * Faux service d'export (test) : lance le VRAI processus enfant d'export, écrit son
 * numéro de processus sur la sortie standard, puis s'arrête brutalement (SIGKILL),
 * avant d'envoyer la demande (`before`) ou après avoir reçu la réponse sans libérer
 * l'enfant (`after`). L'enfant ne doit pas lui survivre.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const phase = process.argv[2] === 'after' ? 'after' : 'before';
const child = fork(
  fileURLToPath(new URL('../../src/exports/export-child.ts', import.meta.url)),
  [],
  {
    execArgv: ['--import', import.meta.resolve('tsx')],
    env: { NODE_ENV: 'test', NODE_OPTIONS: '' },
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  },
);
process.stdout.write(`${child.pid}\n`, () => {
  if (phase === 'before') {
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  // Aucune correction : l'enfant répond aussitôt, puis attend sa libération.
  child.once('message', () => process.kill(process.pid, 'SIGKILL'));
  child.send({ source: Buffer.from('x'), edits: [] });
});
