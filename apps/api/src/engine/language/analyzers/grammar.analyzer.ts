import type { Block } from '@wordfix/shared';
import { mapGrammarErrors } from '../grammar/mapping.js';
import type { AnalyzerContext, LanguageAnalyzer, LanguageIssue } from '../types.js';

/**
 * Grammaire française : accords, conjugaison, confusions (a/à…), modes verbaux.
 *
 * Le moteur grammatical est Grammalecte, exécuté dans un processus séparé
 * (voir grammar/grammalecte-client.ts). Comme il est asynchrone, ses erreurs
 * sont calculées pour tout le document avant l'analyse (grammar/check-document.ts)
 * et transmises dans le contexte : cet analyseur se contente de les filtrer et de
 * les convertir (grammar/mapping.ts). Sans vérification grammaticale (moteur
 * désactivé ou indisponible), il ne renvoie rien.
 */
export class GrammarAnalyzer implements LanguageAnalyzer {
  readonly id = 'grammar';

  blockKinds(config: AnalyzerContext['config']) {
    return config.grammar.blockKinds;
  }

  analyze(block: Block, context: AnalyzerContext): LanguageIssue[] {
    const errors = context.document.grammar?.get(block.id);
    if (!errors || errors.length === 0) return [];
    return mapGrammarErrors(block, errors, context);
  }
}
