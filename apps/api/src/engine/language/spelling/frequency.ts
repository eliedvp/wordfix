/**
 * Fréquence d'usage des mots, pour départager plus tard des corrections aussi
 * proches l'une que l'autre (« peris » → « permis » plutôt que « péris »).
 *
 * Aucune source de fréquence n'est installée pour l'instant : le dictionnaire
 * Grammalecte n'en fournit pas, et une liste de fréquences demande une source
 * dont la licence et la provenance sont vérifiées. L'interface est prête ; la
 * valeur par défaut ne change rien au classement.
 */
export interface WordFrequency {
  /** Fréquence relative entre 0 et 1, ou null si inconnue. */
  of(word: string): number | null;
}

export const NO_FREQUENCY: WordFrequency = { of: () => null };
