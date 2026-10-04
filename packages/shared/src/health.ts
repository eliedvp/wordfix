export type DependencyState = 'up' | 'down';

/** Réponse de l'endpoint `GET /api/health`. */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: 'wordfix-api';
  version: string;
  uptimeSeconds: number;
  dependencies: {
    database: DependencyState;
    redis: DependencyState;
  };
}
