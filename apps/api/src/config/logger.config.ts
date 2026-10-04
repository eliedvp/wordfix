import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { Env } from './env.schema.js';

/**
 * Logs JSON structurés (pino).
 *
 * Règle de confidentialité : aucun cookie, en-tête d'autorisation ni contenu de
 * document ne doit apparaître dans les logs. Les champs sensibles connus sont
 * masqués ici ; les modules métier ne journalisent jamais le texte analysé.
 */
export function buildLoggerParams(env: Env): Params {
  const isDev = env.NODE_ENV === 'development';

  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      genReqId: (req: IncomingMessage) => {
        const header = req.headers['x-request-id'];
        return typeof header === 'string' && /^[\w-]{8,64}$/.test(header) ? header : randomUUID();
      },
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'res.headers["set-cookie"]',
          '*.apiKey',
          '*.password',
          '*.token',
        ],
        censor: '[masqué]',
      },
      customProps: () => ({ service: 'wordfix-api' }),
      autoLogging: {
        // Le healthcheck est appelé souvent : inutile de remplir les logs.
        ignore: (req: IncomingMessage) => req.url === '/api/health',
      },
      transport: isDev
        ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' } }
        : undefined,
    },
  };
}
