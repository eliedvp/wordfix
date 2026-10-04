/** Réponse de l'endpoint `GET /api/health`. */
export interface HealthResponse {
  status: 'ok';
  service: 'wordfix-api';
  version: string;
  uptimeSeconds: number;
}
