import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema.js';
import { configureGrammalecte, getGrammalecte, stopGrammalecte } from './grammalecte-client.js';

/**
 * Lance Grammalecte au démarrage du worker (une seule instance par worker, pour
 * tous les documents) et l'arrête à l'extinction. Déclaré uniquement dans le
 * module du worker : l'API ne lance jamais Python.
 *
 * Si Grammalecte ne démarre pas (Python absent…), le worker démarre quand même :
 * les analyses se font sans vérification grammaticale, et l'erreur est journalisée.
 */
@Injectable()
export class GrammarPreloadService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(GrammarPreloadService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get('GRAMMAR_ENGINE', { infer: true }) !== 'grammalecte') {
      this.logger.log('Vérification grammaticale désactivée (GRAMMAR_ENGINE=off)');
      return;
    }
    configureGrammalecte({ python: this.config.get('GRAMMALECTE_PYTHON', { infer: true }) });
    const client = getGrammalecte();
    try {
      await client.start();
      const stats = client.getStats();
      this.logger.log(
        { version: stats.version, loadMs: stats.loadMs, starts: stats.starts },
        'Grammalecte prêt',
      );
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Grammalecte indisponible : analyses sans vérification grammaticale',
      );
    }
  }

  onApplicationShutdown(): void {
    stopGrammalecte();
  }
}
