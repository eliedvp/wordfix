import { type INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppError } from './common/errors/app-error.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';

/**
 * Configuration HTTP commune à l'application réelle et aux tests d'intégration,
 * pour que les tests vérifient exactement le comportement de production.
 */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  // Ne pas annoncer la technologie du serveur.
  express.disable('x-powered-by');
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
