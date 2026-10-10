import { AiError, type AiProvider, type StructuredResult } from '../ai-provider.js';

/**
 * Fournisseur du mode sans IA (AI_PROVIDER=none). Il n'ouvre aucune connexion et ne
 * charge aucun SDK : l'analyse ne planifie aucun appel IA dans ce mode. S'il était
 * appelé quand même (bug), il refuse au lieu de joindre un fournisseur payant.
 */
export class DisabledAiProvider implements AiProvider {
  readonly name = 'none';

  generateStructured<T>(): Promise<StructuredResult<T>> {
    return Promise.reject(
      new AiError('config', 'IA désactivée (AI_PROVIDER=none) : aucun appel IA autorisé'),
    );
  }
}
