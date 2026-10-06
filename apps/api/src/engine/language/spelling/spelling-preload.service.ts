import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { dictionaryLoadStats, loadSpellingDictionaries } from './dictionaries.js';

/**
 * Précharge les dictionnaires au démarrage du worker, pour que la
 * première analyse n'attende pas son chargement. Déclaré uniquement dans le
 * module du worker : l’API ne les charge jamais.
 */
@Injectable()
export class SpellingPreloadService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SpellingPreloadService.name);

  async onApplicationBootstrap(): Promise<void> {
    await loadSpellingDictionaries();
    const stats = dictionaryLoadStats();
    this.logger.log(
      {
        loadMs: stats.loadMs,
        rssBeforeMb: stats.rssBeforeMb,
        rssAfterMb: stats.rssAfterMb,
        loads: stats.loads,
        englishWords: stats.englishWords,
        frequencyWords: stats.frequencyWords,
      },
      'Dictionnaires orthographiques chargés',
    );
  }
}
