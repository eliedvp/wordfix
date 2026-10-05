/**
 * Contrat des réponses de l'API, partagé par le backend (qui les produit) et le
 * frontend (qui les consomme). Les dates sont des chaînes ISO 8601.
 */
import type { ErrorCode } from './errors.js';
import type {
  AnalysisStatus,
  Confidence,
  IssueCategory,
  IssueNature,
  IssueSeverity,
  IssueSource,
  IssueStatus,
} from './taxonomy.js';

export type NatureCounts = Record<IssueNature, number>;
export type CategoryCounts = Record<IssueCategory, number>;

export interface AnalysisSummaryDto {
  id: string;
  status: AnalysisStatus;
  progress: number;
  score: number | null;
  createdAt: string;
  completedAt: string | null;
  errorCode: ErrorCode | null;
  /** Nombre total de problèmes et nombre déjà traités par l'utilisateur. */
  issueCount: number;
  reviewedCount: number;
}

export interface DocumentDto {
  id: string;
  originalName: string;
  sizeBytes: number;
  wordCount: number;
  estimatedPages: number;
  createdAt: string;
  /** Le fichier d'origine est encore stocké (nécessaire pour lancer une analyse). */
  fileAvailable: boolean;
  fileExpiresAt: string;
  contentExpiresAt: string;
  latestAnalysis: AnalysisSummaryDto | null;
}

export type AnalysisWarning =
  | 'PARTIAL_ANALYSIS'
  | 'HEADINGS_INFERRED'
  | 'NON_FRENCH_DOCUMENT'
  | 'PARSER_FALLBACK'
  | 'ELEMENTS_SKIPPED'
  | 'ISSUES_CAPPED';

export type AnalysisStepKey = 'extract' | 'local' | 'context' | 'global' | 'finalize';
export type AnalysisStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface AnalysisStepDto {
  key: AnalysisStepKey;
  state: AnalysisStepState;
  /** Nombre de problèmes déjà enregistrés pour cette étape. */
  issueCount: number;
}

export interface ScoreDetail {
  score: number;
  wordCount: number;
  penalties: Record<IssueCategory, number>;
}

export interface AnalysisDto {
  id: string;
  documentId: string;
  documentName: string;
  status: AnalysisStatus;
  progress: number;
  chunksTotal: number;
  chunksDone: number;
  steps: AnalysisStepDto[];
  score: number | null;
  scoreDetail: ScoreDetail | null;
  warnings: AnalysisWarning[];
  errorCode: ErrorCode | null;
  wordCount: number;
  estimatedPages: number;
  natureCounts: NatureCounts;
  categoryCounts: CategoryCounts;
  issueCount: number;
  reviewedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Estimation du temps restant, uniquement quand elle est fiable. */
  etaSeconds: number | null;
}

export interface IssueLocationDto {
  blockId: string;
  sectionPath: string;
  paragraphInSection: number | null;
  estimatedPage: number | null;
  charStart: number;
  charEnd: number;
  /** Description lisible, ex. « Tableau 2, ligne 3 » ou « Note de bas de page ». */
  label: string | null;
}

export interface IssueDto {
  id: string;
  category: IssueCategory;
  subtype: string;
  nature: IssueNature;
  severity: IssueSeverity;
  confidence: Confidence;
  source: IssueSource;
  location: IssueLocationDto;
  related: IssueLocationDto[];
  original: string;
  suggestion: string | null;
  explanation: string;
  status: IssueStatus;
  userText: string | null;
  docOrder: number;
}

export interface BlockContextDto {
  id: string;
  kind: string;
  text: string;
  sectionPath: string;
}

export interface IssueListDto {
  items: IssueDto[];
  total: number;
  /** Texte des paragraphes concernés, pour afficher chaque problème dans son contexte. */
  blocks: Record<string, BlockContextDto>;
}
