export const ANALYSIS_QUEUE = 'analysis';
export const MAINTENANCE_QUEUE = 'maintenance';
export const QUEUE_PREFIX = 'wordfix';

export interface AnalysisJobData {
  analysisId: string;
}

/** Nombre total d'essais d'un job d'analyse (reprise automatique après une panne). */
export const ANALYSIS_JOB_ATTEMPTS = 3;
