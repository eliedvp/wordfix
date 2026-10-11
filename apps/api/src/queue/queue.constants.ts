export const ANALYSIS_QUEUE = 'analysis';
export const MAINTENANCE_QUEUE = 'maintenance';
/** Documents corrigés : consommée par le service d'export uniquement, une tâche à la fois. */
export const EXPORT_QUEUE = 'export';
export const QUEUE_PREFIX = 'wordfix';

export interface AnalysisJobData {
  analysisId: string;
}

/** Nombre total d'essais d'un job d'analyse (reprise automatique après une panne). */
export const ANALYSIS_JOB_ATTEMPTS = 3;

export interface ExportJobData {
  exportId: string;
}

/**
 * Essais d'un job d'export : un second seulement pour une panne passagère (stockage,
 * base). Les échecs définitifs (document trop lourd, corrections inapplicables) sont
 * enregistrés par le service sans nouvel essai.
 */
export const EXPORT_JOB_ATTEMPTS = 2;
