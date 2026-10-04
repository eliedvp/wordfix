import { fileURLToPath } from 'node:url';

/**
 * Chemin du fichier `.env` unique, à la racine du monorepo.
 *
 * Calculé à partir de l'emplacement de ce fichier (src/config ou dist/config),
 * pour fonctionner quel que soit le dossier depuis lequel l'API est lancée.
 * Les variables déjà présentes dans l'environnement restent prioritaires.
 */
export const ROOT_ENV_FILE = fileURLToPath(new URL('../../../../.env', import.meta.url));
