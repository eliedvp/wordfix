/**
 * Écrit le corpus QA (13 types de documents) dans apps/api/fixtures/corpus/,
 * pour des tests manuels dans le navigateur ou avec la vraie API OpenAI.
 * Usage : pnpm --filter @wordfix/api fixtures:generate
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CORPUS } from '../test/fixtures/corpus.js';

const dir = fileURLToPath(new URL('../fixtures/corpus/', import.meta.url));
mkdirSync(dir, { recursive: true });

for (const item of CORPUS) {
  const buffer = await item.build();
  writeFileSync(`${dir}${item.filename}`, buffer);
  // eslint-disable-next-line no-console -- script en ligne de commande
  console.log(
    `${item.filename.padEnd(32)} ${item.title} → attendu : ${item.uploadError ?? 'accepté'}`,
  );
}
