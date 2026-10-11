import {
  ERROR_CATALOG,
  type ErrorCode,
  type ExportDto,
  type ExportSkipReason,
  type IssueDto,
} from '@wordfix/shared';

/**
 * Document corrigé : règles partagées par l'interface. Seuls les points acceptés
 * (avec une proposition) et les points modifiés (avec le texte de l'utilisateur)
 * sont appliqués — la même règle que l'API. Les points ignorés, vérifiés ou non
 * traités ne le sont jamais.
 */
export function exportableIssues(issues: readonly IssueDto[]): IssueDto[] {
  return issues.filter(
    (issue) =>
      (issue.status === 'accepted' && issue.suggestion !== null) ||
      (issue.status === 'edited' && issue.userText !== null),
  );
}

/** Texte qui remplace le passage dans le document corrigé. */
export function replacementOf(issue: IssueDto): string | null {
  if (issue.status === 'edited') return issue.userText;
  if (issue.status === 'accepted') return issue.suggestion;
  return null;
}

/**
 * Empreinte des corrections choisies : si elle change après la génération, le
 * document corrigé ne reflète plus les choix affichés.
 */
export function decisionsSignature(issues: readonly IssueDto[]): string {
  return exportableIssues(issues)
    .map((issue) => `${issue.id}\u0000${replacementOf(issue) ?? ''}`)
    .sort()
    .join('\u0001');
}

export function isActiveExport(dto: ExportDto | undefined): boolean {
  return dto?.status === 'QUEUED' || dto?.status === 'RUNNING';
}

/** Pourquoi une correction choisie n'a pas été appliquée au fichier Word. */
export const SKIP_REASON_TEXTS: Record<ExportSkipReason, string> = {
  block_not_found: 'Le passage n’a pas été retrouvé dans le fichier Word.',
  block_changed: 'Le paragraphe du fichier ne correspond plus au texte analysé.',
  original_mismatch: 'Le texte à corriger ne correspond plus à celui du fichier.',
  invalid_range: 'L’emplacement de la correction n’est pas valide.',
  unsupported_block: 'Ce type de contenu ne peut pas être modifié automatiquement.',
  invalid_replacement:
    'Le texte de remplacement ne peut pas être inséré tel quel (retour à la ligne ou caractère spécial).',
  overlap: 'Cette correction chevauche une autre correction du même passage.',
  not_plain_text:
    'Le passage ne contient pas que du texte simple (tabulation, saut de ligne, symbole…).',
  field: 'Le passage se trouve dans un champ Word (table des matières, date, renvoi…).',
  content_control: 'Le passage se trouve dans un contrôle de contenu (formulaire Word).',
  tracked_change: 'Le passage contient des modifications suivies non acceptées.',
  format_boundary:
    'La mise en forme change dans ce passage (gras, italique…) : la correction pourrait l’altérer.',
  non_adjacent: 'Le passage est découpé de façon complexe dans le fichier Word.',
  anchor_mismatch: 'L’emplacement du passage dans le fichier n’a pas pu être confirmé.',
  repeated_header_footer:
    'Le passage est dans un en-tête ou un pied de page répété dans plusieurs sections.',
};

/** Message d'un export en échec (catalogue partagé), ou message générique. */
export function exportFailureText(code: ErrorCode | null): string {
  return code ? ERROR_CATALOG[code].message : ERROR_CATALOG.EXPORT_FAILED.message;
}

/** Un nouvel essai avec les mêmes choix a une chance d'aboutir (panne, délai). */
export function isRetryableFailure(code: ErrorCode | null): boolean {
  return code === 'EXPORT_FAILED' || code === 'EXPORT_TIMEOUT' || code === null;
}

/** Dernier export demandé pour une analyse, gardé pour la durée de l'onglet. */
export interface StoredExport {
  id: string;
  signature: string;
}

const storageKey = (analysisId: string) => `wordfix.export.${analysisId}`;

export function readStoredExport(analysisId: string): StoredExport | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(analysisId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredExport>;
    return typeof value.id === 'string' && typeof value.signature === 'string'
      ? { id: value.id, signature: value.signature }
      : null;
  } catch {
    return null;
  }
}

export function writeStoredExport(analysisId: string, value: StoredExport | null): void {
  try {
    if (value) window.sessionStorage.setItem(storageKey(analysisId), JSON.stringify(value));
    else window.sessionStorage.removeItem(storageKey(analysisId));
  } catch {
    // Stockage indisponible (navigation privée stricte) : l'export reste suivi en mémoire.
  }
}

/** Proposer un fichier reçu à l'enregistrement, sous le nom donné par le serveur. */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
