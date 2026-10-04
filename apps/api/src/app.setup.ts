import { type INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppError } from './common/errors/app-error.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import type { Env } from './config/env.schema.js';

/**
 * Configuration HTTP commune à l'application réelle et aux tests d'intégration,
 * pour que les tests vérifient exactement le comportement de production.
 */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  // Ne pas annoncer la technologie du serveur.
  express.disable('x-powered-by');
  // Adresse IP réelle derrière Next.js / le reverse proxy (quotas, limiteur).
  express.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  // En-têtes de sécurité HTTP (l'API ne sert que du JSON).
  app.use(helmet());
  // Données privées : aucune réponse de l'API ne doit être mise en cache.
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Toutes les routes sont servies sous /api, comme les réécritures Next.js (D4).
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: () => new AppError('VALIDATION_FAILED'),
    }),
  );
  app.enableShutdownHooks();
}
