import { LANGUAGE_ENGINE_CONFIG, type GrammarConfig } from '../config.js';
import type { GrammarFindings, LanguageInput } from '../types.js';
import type { GrammalecteError } from './grammalecte-client.js';

/** Ce dont la vérification d'un document a besoin (le client Grammalecte, ou un double de test). */
export interface GrammarChecker {
  check(paragraphs: readonly string[]): Promise<(GrammalecteError[] | null)[]>;
}

/**
 * Vérifie la grammaire de tout un document : les paragraphes rédigés sont
 * regroupés en lots de plusieurs dizaines de milliers de caractères (jamais
 * phrase par phrase), envoyés l'un après l'autre au processus Grammalecte.
 * Un document de 60 000 mots représente une dizaine de lots.
 *
 * Renvoie les erreurs brutes par paragraphe ; leur filtrage et leur
 * transformation en remarques WordFix sont faits par le GrammarAnalyzer.
 */
export async function checkDocumentGrammar(
  checker: GrammarChecker,
  input: LanguageInput,
  config: GrammarConfig = LANGUAGE_ENGINE_CONFIG.grammar,
): Promise<GrammarFindings> {
  const kinds = new Set(config.blockKinds);
  const batches: { ids: string[]; texts: string[] }[] = [];
  let current: { ids: string[]; texts: string[] } = { ids: [], texts: [] };
  let currentLength = 0;

  for (const block of input.blocks) {
    if (!kinds.has(block.kind)) continue;
    if (block.text.trim().length === 0 || block.text.length > config.maxParagraphLength) continue;
    if (currentLength > 0 && currentLength + block.text.length > config.batchLength) {
      batches.push(current);
      current = { ids: [], texts: [] };
      currentLength = 0;
    }
    current.ids.push(block.id);
    current.texts.push(block.text);
    currentLength += block.text.length;
  }
  if (current.ids.length > 0) batches.push(current);

  const findings = new Map<string, GrammalecteError[]>();
  for (const batch of batches) {
    const results = await checker.check(batch.texts);
    batch.ids.forEach((id, index) => {
      const errors = results[index];
      if (errors && errors.length > 0) findings.set(id, errors);
    });
  }
  return findings;
}
