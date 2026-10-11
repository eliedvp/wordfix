/**
 * Contrôle du rapport des tests de processus (`pnpm test:process`) : un test non
 * exécuté ne doit jamais passer pour réussi.
 * - Aucun test en échec.
 * - Les tests du protocole parent-enfant et du superviseur qui ne dépendent pas de
 *   /proc doivent tous avoir été réellement exécutés, sur tout système.
 * - Les tests ignorés sont listés, et ne peuvent l'être que là où /proc est absent.
 * Usage : tsx scripts/check-process-report.ts <rapport.json>
 */
import { existsSync, readFileSync } from 'node:fs';

interface Assertion {
  fullName: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending' | 'todo' | 'disabled';
}
interface Report {
  testResults: { assertionResults: Assertion[] }[];
}

const path = process.argv[2];
if (!path) throw new Error('Rapport JSON attendu en argument.');
const report = JSON.parse(readFileSync(path, 'utf8')) as Report;
const tests = report.testResults.flatMap((file) => file.assertionResults);
const hasProc = existsSync('/proc/self/status');

const failed = tests.filter((t) => t.status === 'failed');
const passed = tests.filter((t) => t.status === 'passed');
const notRun = tests.filter((t) => t.status !== 'passed' && t.status !== 'failed');
/** Tests dépendant de la lecture du pic mémoire (/proc) : seuls autorisés à être ignorés. */
const memoryDependent = (t: Assertion) =>
  /mémoire dépassée|pic atteint pendant l’envoi/.test(t.fullName);
const wronglySkipped = notRun.filter((t) => hasProc || !memoryDependent(t));

const line = (t: Assertion) => `  - ${t.fullName}`;
const log = (text: string) => process.stdout.write(`${text}\n`);
log(`Système : ${process.platform} ; /proc ${hasProc ? 'disponible' : 'absent'}`);
log(`Réellement exécutés et réussis : ${passed.length}`);
log(`Ignorés : ${notRun.length}${notRun.length ? '\n' + notRun.map(line).join('\n') : ''}`);
if (failed.length) log(`En échec : ${failed.length}\n${failed.map(line).join('\n')}`);
if (wronglySkipped.length) {
  log(`Ignorés alors qu'ils doivent s'exécuter ici :\n${wronglySkipped.map(line).join('\n')}`);
}
if (tests.length === 0 || failed.length || wronglySkipped.length) process.exit(1);
