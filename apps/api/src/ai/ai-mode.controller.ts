import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import type { AiModeDto } from '@wordfix/shared';
import type { Env } from '../config/env.schema.js';

/**
 * Mode IA réellement configuré, pour que le site affiche ce qui est fait du texte
 * (page Confidentialité, accueil). Public et sans secret : ni clé, ni nom de modèle,
 * ni budget. Le serveur du site l'appelle à chaque affichage depuis la même adresse
 * locale : pas de limiteur, comme /api/health.
 */
@SkipThrottle()
@Controller('ai-mode')
export class AiModeController {
  constructor(private readonly config: ConfigService<Env, true>) {}

  @Get()
  get(): AiModeDto {
    return { mode: this.config.get('AI_PROVIDER', { infer: true }) };
  }
}
