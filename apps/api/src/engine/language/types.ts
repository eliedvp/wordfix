import type { Block, BlockKind, DocumentModel, TextRange } from '@wordfix/shared';
import type { CandidateIssue } from '../types.js';
import type { LanguageEngineConfig, LanguageRuleId } from './config.js';

/**
 * Problème détecté par un analyseur de langue. C'est le type commun du moteur
 * (CandidateIssue) avec une position toujours connue et la règle d'origine :
 * il suit ensuite exactement le même chemin que les problèmes de l'IA
 * (ancrage, nature décidée par le backend, déduplication, stockage).
 */
export interface LanguageIssue extends CandidateIssue {
  rule: LanguageRuleId;
  range: TextRange;
}

/** Ce que le moteur fournit à chaque analyseur pour un paragraphe. */
export interface AnalyzerContext {
  config: LanguageEngineConfig;
  /** Zones à ne pas analyser : URL, adresses e-mail, chemins, noms de fichiers. */
  protectedRanges: readonly TextRange[];
  /** Vrai si le document contient des équations, absentes du texte extrait. */
  hasDroppedInlineContent: boolean;
}

/**
 * Un analyseur indépendant : il reçoit un paragraphe et renvoie ses problèmes.
 * Il ne connaît ni la base, ni la file, ni l'IA ; il ne fait aucun appel réseau.
 */
export interface LanguageAnalyzer {
  readonly id: string;
  /** Types de paragraphes que l'analyseur accepte. */
  blockKinds(config: LanguageEngineConfig): readonly BlockKind[];
  analyze(block: Block, context: AnalyzerContext): LanguageIssue[];
}

/** Entrée du moteur : le document structuré produit par l'extraction actuelle. */
export type LanguageInput = Pick<DocumentModel, 'blocks' | 'meta'>;
