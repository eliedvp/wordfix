import type { Confidence, IssueCategory, IssueSeverity, IssueSource } from '@wordfix/shared';
import type { AmbiguityInfo } from './language/ambiguity/types.js';

/**
 * Problème candidat, avant les contrôles du backend (ancrage, nature, doublons).
 * Produit par les règles ou par une étape IA.
 */
export interface CandidateIssue {
  category: IssueCategory;
  subtype: string;
  blockId: string;
  /** Extrait exact signalé ; null quand la remarque porte sur tout le bloc. */
  original: string | null;
  suggestion: string | null;
  explanation: string;
  severity: IssueSeverity;
  confidence: Confidence;
  source: IssueSource;
  relatedBlockIds: string[];
  /** Position déjà connue (règles déterministes). */
  range?: { start: number; end: number };
  /** Extraits exacts dans les blocs liés (contradictions vérifiées). */
  relatedExcerpts?: Record<string, string>;
  /** Verdict de l'étape de vérification, pour les contradictions. */
  verdict?: 'contradictory' | 'uncertain';
  /**
   * Cas ambigu (règles de langue) : corrections possibles et repli sans décision
   * de l'IA. La remarque elle-même est alors la forme « sans IA » du cas.
   */
  ambiguity?: AmbiguityInfo;
}
