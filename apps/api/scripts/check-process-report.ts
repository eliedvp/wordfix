/**
 * Contrôle du rapport des tests de processus (`pnpm test:process`) : un test non
 * exécuté ne doit jamais passer pour réussi.
 * - Aucun test en échec.
 * - Les tests du protocole parent-enfant et du superviseur qui ne dépendent pas de
 *   /proc doivent tous avoir été réellement exécutés, sur tout système.
 * - Les tests ignorés sont listés, et ne peuvent l'être que là où /proc est absent.
 * Décompte : exécutés (= réussis + échoués), réussis, échoués, ignorés (non exécutés).
 * En CI (GitHub Actions), il est aussi écrit dans le résumé du job et en annotation,
 * lisibles même sans accès au journal.
 * Usage : tsx scripts/check-process-report.ts <rapport.json>
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

interface Assertion {
  fullName: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending' | 'todo' | 'disabled';
}
interface Report {
  testResults: { assertionResults: Assertion[] }[];
}

const log = (text: string) => process.stdout.write(`${text}\n`);
/** Commande de workflow GitHub (annotation) ; sans effet hors de GitHub Actions. */
const annotate = (level: 'notice' | 'error', title: string, message: string) => {
  if (process.env.GITHUB_ACTIONS === 'true') {
    log(`::${level} title=${title}::${message.replace(/%/g, '%25').replace(/\n/g, '%0A')}`);
  }
};
const summary = (markdown: string) => {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
};

const system = `${process.platform} ; /proc ${existsSync('/proc/self/status') ? 'disponible' : 'absent'}`;
const path = process.argv[2];
if (!path || !existsSync(path)) {
  const message = `Rapport introuvable (${path ?? 'aucun chemin'}) : les tests n'ont pas produit de résultats.`;
  log(message);
  annotate('error', `Tests de processus (${process.platform})`, message);
  summary(`## Tests de processus d'export (${system})\n\n**${message}**`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(path, 'utf8')) as Report;
const tests = report.testResults.flatMap((file) => file.assertionResults);
const hasProc = existsSync('/proc/self/status');

const passed = tests.filter((t) => t.status === 'passed');
const failed = tests.filter((t) => t.status === 'failed');
const executed = passed.length + failed.length;
const notRun = tests.filter((t) => t.status !== 'passed' && t.status !== 'failed');
/** Tests dépendant de la lecture du pic mémoire (/proc) : seuls autorisés à être ignorés. */
const memoryDependent = (t: Assertion) =>
  /mémoire dépassée|pic atteint pendant l’envoi/.test(t.fullName);
const wronglySkipped = notRun.filter((t) => hasProc || !memoryDependent(t));
const ok = tests.length > 0 && failed.length === 0 && wronglySkipped.length === 0;

const line = (t: Assertion) => `  - ${t.fullName}`;
log(`Système : ${system}`);
log(`Tests : ${tests.length} ; exécutés : ${executed} ; réussis : ${passed.length} ;`);
log(`échoués : ${failed.length} ; ignorés (non exécutés) : ${notRun.length}`);
if (notRun.length) log(`Ignorés :\n${notRun.map(line).join('\n')}`);
if (failed.length) log(`En échec :\n${failed.map(line).join('\n')}`);
if (wronglySkipped.length) {
  log(`Ignorés alors qu'ils doivent s'exécuter ici :\n${wronglySkipped.map(line).join('\n')}`);
}

const counts = `Exécutés ${executed} · réussis ${passed.length} · échoués ${failed.length} · ignorés ${notRun.length} (sur ${tests.length})`;
annotate(ok ? 'notice' : 'error', `Tests de processus (${process.platform})`, counts);

const list = (title: string, items: Assertion[]) =>
  items.length ? `\n**${title}**\n\n${items.map((t) => `- ${t.fullName}`).join('\n')}\n` : '';
summary(
  [
    `## Tests de processus d'export (${system})`,
    '',
    '| Exécutés | Réussis | Échoués | Ignorés (non exécutés) | Total |',
    '|---:|---:|---:|---:|---:|',
    `| ${executed} | ${passed.length} | ${failed.length} | ${notRun.length} | ${tests.length} |`,
    '',
    `Contrôle du rapport : **${ok ? 'réussi' : 'échoué'}**. Un test ignoré n'est jamais compté comme réussi.`,
    list('Ignorés', notRun),
    list('En échec', failed),
    list("Ignorés alors qu'ils doivent s'exécuter ici", wronglySkipped),
  ].join('\n'),
);

if (!ok) process.exit(1);
