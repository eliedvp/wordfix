/**
 * Variables d'environnement des tests d'intégration.
 * La base de test est distincte de la base de développement et entièrement
 * recréée à chaque lancement : ne jamais pointer TEST_DATABASE_URL vers une
 * base contenant des données utiles.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://wordfix:wordfix_dev_password@127.0.0.1:5432/wordfix_test?schema=public';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
