/**
 * Catalogue unique des erreurs renvoyées par l'API.
 *
 * Chaque code a un statut HTTP et un message en français compréhensible par un
 * utilisateur non technique. L'API répond toujours :
 *   { "error": { "code": "...", "message": "...", "requestId": "..." } }
 */

export const ERROR_CATALOG = {
  FILE_MISSING: {
    status: 400,
    message: 'Aucun fichier reçu. Sélectionnez un document Word (.docx).',
  },
  FILE_TOO_LARGE: {
    status: 413,
    message: 'Ce fichier dépasse 20 Mo, la taille maximale acceptée.',
  },
  UNSUPPORTED_FORMAT: {
    status: 415,
    message: "Ce fichier n'est pas un document Word (.docx).",
  },
  LEGACY_DOC_FORMAT: {
    status: 415,
    message: 'Ancien format .doc : ouvrez-le dans Word et enregistrez-le au format .docx.',
  },
  MACRO_DOCUMENT: {
    status: 415,
    message:
      'Les documents contenant des macros ne sont pas acceptés. Enregistrez une copie au format .docx sans macros.',
  },
  PASSWORD_PROTECTED: {
    status: 422,
    message: 'Ce document est protégé par un mot de passe. Retirez la protection puis réessayez.',
  },
  CORRUPTED_FILE: {
    status: 422,
    message: 'Ce fichier semble endommagé et ne peut pas être lu.',
  },
  EMPTY_DOCUMENT: {
    status: 422,
    message:
      'Ce document ne contient pas de texte à analyser (il contient peut-être uniquement des images).',
  },
  DOCUMENT_TOO_LONG: {
    status: 422,
    message: 'Ce document dépasse 60 000 mots, la limite actuelle.',
  },
  FILE_EXPIRED: {
    status: 410,
    message:
      "Le fichier d'origine a été supprimé (conservation de 24 h). Importez-le de nouveau pour lancer une analyse.",
  },
  ANALYSIS_IN_PROGRESS: {
    status: 409,
    message: 'Une analyse est déjà en cours pour ce document.',
  },
  ANALYSIS_NOT_CANCELABLE: {
    status: 409,
    message: 'Cette analyse est déjà terminée et ne peut plus être annulée.',
  },
  ANALYSIS_NOT_READY: {
    status: 409,
    message: "Les résultats ne sont pas encore disponibles : l'analyse est en cours.",
  },
  RATE_LIMITED: {
    status: 429,
    message: "Vous avez atteint la limite d'analyses. Réessayez un peu plus tard.",
  },
  TOO_MANY_REQUESTS: {
    status: 429,
    message: 'Trop de requêtes en peu de temps. Patientez quelques secondes.',
  },
  AI_BUDGET_EXHAUSTED: {
    status: 503,
    message: "Le service d'analyse a atteint sa limite quotidienne. Réessayez demain.",
  },
  AI_UNAVAILABLE: {
    status: 503,
    message:
      "Le service d'analyse est momentanément indisponible. Votre document est conservé : relancez dans quelques minutes.",
  },
  ANALYSIS_FAILED: {
    status: 500,
    message: "L'analyse n'a pas pu aboutir. Vous pouvez la relancer.",
  },
  VALIDATION_FAILED: { status: 400, message: 'La requête contient des valeurs invalides.' },
  FORBIDDEN_ORIGIN: { status: 403, message: 'Requête refusée.' },
  NOT_FOUND: { status: 404, message: "Cet élément n'existe pas ou n'est plus disponible." },
  INTERNAL_ERROR: {
    status: 500,
    message: 'Une erreur inattendue est survenue. Réessayez dans un instant.',
  },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
  };
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ERROR_CATALOG;
}
