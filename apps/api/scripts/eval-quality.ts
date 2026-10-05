/**
 * Évaluation de la qualité de l'IA (stratégie de tests, section « Qualité de l'IA »).
 *
 * Envoie des documents dont les fautes sont connues à une instance WordFix en
 * marche (site + API + worker avec la vraie clé OpenAI), puis mesure :
 * - le rappel : part des fautes injectées retrouvées ;
 * - la précision des « erreurs » : part des erreurs signalées qui sont de vraies fautes ;
 * - les faux positifs sur un texte sans faute.
 *
 * Usage : pnpm dev (dans un autre terminal), puis
 *   pnpm --filter @wordfix/api eval:quality [http://localhost:3000]
 * Objectifs MVP : rappel ≥ 80 %, précision des erreurs ≥ 90 %.
 */
import type { AnalysisDto, IssueDto, IssueListDto } from '@wordfix/shared';
import { buildDocx } from '../test/fixtures/builders.js';
import { CLEAN_PARAGRAPHS, INJECTED_ERRORS } from '../test/fixtures/prose.js';

const base = process.argv[2] ?? 'http://localhost:3000';
let cookie = '';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie, origin: base },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0] ?? '';
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function analyze(
  name: string,
  buffer: Buffer,
): Promise<{ analysis: AnalysisDto; issues: IssueDto[] }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)]), name);
  const document = await call<{ id: string }>('/documents', { method: 'POST', body: form });
  const { analysisId } = await call<{ analysisId: string }>(`/documents/${document.id}/analyze`, {
    method: 'POST',
  });
  for (;;) {
    const analysis = await call<AnalysisDto>(`/analyses/${analysisId}`);
    if (analysis.status === 'COMPLETED') {
      const list = await call<IssueListDto>(`/analyses/${analysisId}/issues?status=all&limit=1000`);
      return { analysis, issues: list.items };
    }
    if (analysis.status === 'FAILED' || analysis.status === 'CANCELED') {
      throw new Error(`Analyse ${analysis.status} (${analysis.errorCode ?? ''})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const log = (line: string) => process.stdout.write(`${line}\n`);

// 1. Document avec fautes injectées, mêlées à du texte correct.
const nodes = CLEAN_PARAGRAPHS.flatMap((paragraph, index) => {
  const error = INJECTED_ERRORS[index];
  return error ? [{ p: paragraph }, { p: error.sentence }] : [{ p: paragraph }];
});
const started = Date.now();
const withErrors = await analyze(
  'evaluation-fautes.docx',
  await buildDocx([{ h: 1, text: 'Rapport' }, ...nodes]),
);

const found = INJECTED_ERRORS.filter((error) =>
  withErrors.issues.some(
    (issue) => issue.original.includes(error.wrong) || error.wrong.includes(issue.original),
  ),
);
const errors = withErrors.issues.filter((issue) => issue.nature === 'error');
const trueErrors = errors.filter((issue) =>
  INJECTED_ERRORS.some(
    (error) => issue.original.includes(error.wrong) || error.wrong.includes(issue.original),
  ),
);

// 2. Texte sans faute : tout ce qui est classé « erreur » est un faux positif.
const clean = await analyze(
  'evaluation-sans-faute.docx',
  await buildDocx(CLEAN_PARAGRAPHS.map((p) => ({ p }))),
);
const falseErrors = clean.issues.filter((issue) => issue.nature === 'error');

const pct = (a: number, b: number) => (b === 0 ? 'n/a' : `${Math.round((a / b) * 100)} %`);
log('');
log('Évaluation de la qualité');
log('------------------------');
log(
  `Rappel (fautes injectées retrouvées) : ${found.length}/${INJECTED_ERRORS.length} = ${pct(found.length, INJECTED_ERRORS.length)}`,
);
log(
  `Précision des « erreurs »            : ${trueErrors.length}/${errors.length} = ${pct(trueErrors.length, errors.length)}`,
);
log(`Faux « erreurs » sur texte sans faute : ${falseErrors.length}`);
log(
  `Fautes manquées : ${
    INJECTED_ERRORS.filter((e) => !found.includes(e))
      .map((e) => e.wrong)
      .join(', ') || 'aucune'
  }`,
);
for (const issue of falseErrors)
  log(`  faux positif : « ${issue.original} » → ${issue.suggestion ?? ''} (${issue.explanation})`);
log(`Score document fautif / sans faute  : ${withErrors.analysis.score} / ${clean.analysis.score}`);
log(`Durée totale                         : ${Math.round((Date.now() - started) / 1000)} s`);
