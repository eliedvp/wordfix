import type { Block, BlockKind, DocumentModel, TextRange } from '@wordfix/shared';
import type { CandidateIssue } from '../types.js';
import type { LanguageEngineConfig, LanguageRuleId } from './config.js';
import type { GrammalecteError } from './grammar/grammalecte-client.js';

/**
 * Erreurs grammaticales brutes par paragraphe (identifiant du bloc → erreurs),
 * calculées avant l'analyse par Grammalecte (processus séparé, asynchrone) :
 * le moteur reste synchrone et déterministe pour une même entrée.
 */
export type GrammarFindings = ReadonlyMap<string, readonly GrammalecteError[]>;

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
  /** Informations calculées une fois pour tout le document. */
  document: DocumentContext;
}

/** Contexte partagé par tous les paragraphes d'un même document, pendant une analyse. */
export interface DocumentContext {
  /** Nombre de mots du document (plafonds proportionnels à la longueur). */
  wordCount: number;
  /** Nombre d'occurrences de chaque mot (en minuscules) dans le document. */
  wordCounts: ReadonlyMap<string, number>;
  /** Compteurs propres à cette analyse (budgets des analyseurs), remis à zéro à chaque document. */
  counters: Map<string, number>;
  /** Erreurs Grammalecte du document, si la vérification grammaticale a eu lieu. */
  grammar: GrammarFindings | null;
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

/**
 * Entrée du moteur : le document structuré produit par l'extraction actuelle,
 * avec, si disponibles, les erreurs grammaticales déjà calculées.
 */
export type LanguageInput = Pick<DocumentModel, 'blocks' | 'meta'> & {
  grammar?: GrammarFindings | null;
};
