import { createRequire } from 'node:module';
import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@wordfix/shared';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

/**
 * Vérification de disponibilité de l'API.
 *
 * À l'étape 1, elle confirme seulement que le processus répond. Les états de
 * PostgreSQL (étape 5) et de Redis (étape 8) y seront ajoutés.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      service: 'wordfix-api',
      version,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
