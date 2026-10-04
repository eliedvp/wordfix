import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AppError } from '../common/errors/app-error.js';
import type { Env } from '../config/env.schema.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Protection CSRF : toute requête qui modifie des données doit venir du site
 * lui-même. En complément du cookie SameSite=Lax, on refuse une origine
 * différente de WEB_ORIGIN et toute requête déclarée « cross-site » par le
 * navigateur. Les clients sans navigateur n'envoient pas de cookie de session
 * d'un utilisateur : ils ne peuvent agir qu'en leur propre nom.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  private readonly allowed: string;

  constructor(config: ConfigService<Env, true>) {
    this.allowed = new URL(config.get('WEB_ORIGIN', { infer: true })).origin;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    const origin = req.headers.origin;
    if (origin && origin !== this.allowed) throw new AppError('FORBIDDEN_ORIGIN');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('FORBIDDEN_ORIGIN');
    return true;
  }
}
