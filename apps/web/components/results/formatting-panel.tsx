'use client';

import {
  type AiCheckKey,
  type AnalysisDto,
  type DocumentStructureDto,
  type ExportOptions,
  type IssueDto,
  type IssueSubtype,
} from '@wordfix/shared';
import {
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleSlash,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { FORMATTING_LABELS } from './export-panel';

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Plafonds des règles (`engine/rules/rules.ts`) : au-delà, d'autres écarts peuvent exister. */
const RULE_CAPS = { heading_numbering: 10, toc_mismatch: 5 } as const;

type Row = { label: string; detail: string; status: Status };

const atLeast = (found: number, cap: number, one: string, many: string) =>
  found >= cap ? `au moins ${cap} ${many}` : plural(found, one, many);

/**
 * Contrôles par règles (sans IA), en distinguant la PRÉSENCE de l'élément (résumé de
 * structure renvoyé par l'API) de sa CONFORMITÉ (points relevés). Sans résumé (API
 * antérieure, contenu expiré) : « Non déterminé », jamais « réussi ».
 */
function ruleRows(
  analysis: AnalysisDto,
  structure: DocumentStructureDto | null | undefined,
  count: (subtypes: IssueSubtype[]) => number,
): Row[] {
  const fallback = analysis.warnings.includes('PARSER_FALLBACK');
  const numbering = count(['heading_numbering']);
  const toc = count(['toc_mismatch']);
  const unknown: Status = { tone: 'unknown', text: 'Non déterminé' };
  const simplified: Status = { tone: 'not', text: 'Non vérifié : lecture simplifiée' };
  const SIMPLIFIED =
    'Le document a été lu en mode simplifié : ces éléments n’ont pas pu être examinés de façon fiable.';

  // Numérotation saisie dans les titres.
  let numberingRow: Row;
  const numberingLabel = 'Numérotation des titres';
  if (numbering > 0) {
    numberingRow = {
      label: numberingLabel,
      detail: structure
        ? `${plural(structure.numberedHeadings, 'titre numéroté', 'titres numérotés')} dans le texte, ${structure.numberedHeadings > 1 ? 'contrôlés' : 'contrôlé'}. La numérotation automatique de Word n’est pas lue.`
        : 'Numéros saisis dans le texte des titres. La numérotation automatique de Word n’est pas lue.',
      status: {
        tone: 'partial',
        text: `Contrôlé : ${atLeast(numbering, RULE_CAPS.heading_numbering, 'écart relevé', 'écarts relevés')}`,
      },
    };
  } else if (fallback) {
    numberingRow = { label: numberingLabel, detail: SIMPLIFIED, status: simplified };
  } else if (!structure) {
    numberingRow = {
      label: numberingLabel,
      detail:
        'Aucun écart relevé, mais la présence de titres numérotés n’est pas connue pour cette analyse.',
      status: unknown,
    };
  } else if (!(structure.comparedNumberedHeadings > 0)) {
    // Aucun numéro comparé à un précédent du même niveau : rien n'a été contrôlé.
    numberingRow = {
      label: numberingLabel,
      detail:
        structure.numberedHeadings === 0
          ? `Aucun titre numéroté dans le texte (${plural(structure.headings, 'titre détecté', 'titres détectés')}). La numérotation automatique de Word n’est pas lue.`
          : structure.numberedHeadings === 1
            ? 'Un seul titre numéroté dans le texte : il n’y a pas de suite de numéros à contrôler.'
            : 'Aucun titre numéroté ne suit un autre titre du même niveau : il n’y a pas de suite de numéros à contrôler.',
      status: { tone: 'na', text: 'Non applicable' },
    };
  } else {
    numberingRow = {
      label: numberingLabel,
      detail: `${plural(structure.comparedNumberedHeadings, 'numéro de titre comparé', 'numéros de titre comparés')} au précédent du même niveau (le premier numéro de chaque niveau n’est pas contrôlé). La numérotation automatique de Word n’est pas lue.`,
      status: { tone: 'done', text: 'Contrôlé : aucun écart' },
    };
  }

  // Sommaire Word et titres.
  let tocRow: Row;
  const tocLabel = 'Sommaire et titres';
  const PAGES = 'Les numéros de page du sommaire ne sont pas vérifiés.';
  if (toc > 0) {
    tocRow = {
      label: tocLabel,
      detail: `${structure ? `Sommaire Word détecté (${plural(structure.comparableTocEntries, 'entrée comparée', 'entrées comparées')} aux titres, texte seulement). ` : ''}${PAGES}`,
      status: {
        tone: 'partial',
        text: `Contrôlé : ${atLeast(toc, RULE_CAPS.toc_mismatch, 'entrée sans titre correspondant', 'entrées sans titre correspondant')}`,
      },
    };
  } else if (fallback) {
    tocRow = { label: tocLabel, detail: SIMPLIFIED, status: simplified };
  } else if (!structure) {
    tocRow = {
      label: tocLabel,
      detail:
        'Aucun écart relevé, mais la présence d’un sommaire n’est pas connue pour cette analyse.',
      status: unknown,
    };
  } else if (structure.tocEntries === 0) {
    tocRow = {
      label: tocLabel,
      detail:
        'Aucun sommaire Word détecté. Un sommaire tapé à la main, sans les styles de sommaire de Word, n’est pas reconnu.',
      status: { tone: 'na', text: 'Non applicable' },
    };
  } else if (structure.headings === 0 || structure.comparableTocEntries === 0) {
    tocRow = {
      label: tocLabel,
      detail:
        structure.headings === 0
          ? `Sommaire Word détecté (${plural(structure.tocEntries, 'entrée', 'entrées')}), mais aucun titre dans le document auquel le comparer.`
          : 'Sommaire Word détecté, mais aucune entrée ne peut être comparée aux titres.',
      status: { tone: 'not', text: 'Non vérifié' },
    };
  } else {
    tocRow = {
      label: tocLabel,
      detail: `Sommaire Word détecté : ${plural(structure.comparableTocEntries, 'entrée comparée', 'entrées comparées')} aux titres (texte seulement). ${PAGES}`,
      status: { tone: 'done', text: 'Contrôlé : chaque entrée comparée correspond à un titre' },
    };
  }

  // Titres reconnus par Word (styles « Titre » ou niveaux hiérarchiques).
  let stylesRow: Row;
  const stylesLabel = 'Titres mis en forme avec les styles « Titre »';
  if (fallback) {
    stylesRow = { label: stylesLabel, detail: SIMPLIFIED, status: simplified };
  } else if (structure && structure.headings === 0) {
    stylesRow = {
      label: stylesLabel,
      detail: 'Aucun titre détecté dans le document.',
      status: { tone: 'na', text: 'Non applicable' },
    };
  } else if (
    (structure && structure.inferredHeadings > 0) ||
    analysis.warnings.includes('HEADINGS_INFERRED')
  ) {
    stylesRow = {
      label: stylesLabel,
      detail: `${structure ? `${plural(structure.inferredHeadings, 'titre déduit', 'titres déduits')} de leur apparence, sans style « Titre »` : 'Certains titres sont déduits de leur apparence, sans style « Titre »'} : Word ne peut pas les reprendre dans le sommaire ni la navigation.`,
      status: { tone: 'partial', text: 'À revoir' },
    };
  } else if (!structure) {
    stylesRow = {
      label: stylesLabel,
      detail:
        'Aucun titre déduit de son apparence, mais la présence de titres n’est pas connue pour cette analyse.',
      status: unknown,
    };
  } else {
    stylesRow = {
      label: stylesLabel,
      detail: `${structure.headings > 1 ? `Les ${structure.headings} titres sont reconnus` : 'Le titre est reconnu'} par Word (style « Titre » ou niveau hiérarchique).`,
      status: { tone: 'done', text: 'Contrôlé' },
    };
  }

  // Pagination : jamais recalculée par WordFix.
  const paginationRow: Row = {
    label: 'Pagination',
    detail:
      structure?.pageMethod === 'rendered_break'
        ? 'Numéros de page estimés à partir des sauts de page enregistrés par Word lors du dernier enregistrement : ils peuvent différer de l’affichage actuel. WordFix ne recalcule pas la pagination.'
        : structure?.pageMethod === 'word_count'
          ? 'Numéros de page estimés à partir du nombre de mots. WordFix ne recalcule pas la pagination.'
          : 'Numéros de page estimés. WordFix ne recalcule pas la pagination.',
    status: { tone: 'not', text: 'Non vérifiée' },
  };

  return [numberingRow, tocRow, stylesRow, paginationRow];
}

/** Contrôles de structure confiés à l'IA, selon la passe qui les produit. */
const AI_CHECKS: { check: AiCheckKey; label: string; subtypes: IssueSubtype[] }[] = [
  {
    check: 'context',
    label: 'Transitions, paragraphes incomplets, formulation des titres',
    subtypes: ['weak_transition', 'incomplete_paragraph', 'heading_wording'],
  },
  {
    check: 'global',
    label: 'Sections manquantes ou déséquilibrées',
    subtypes: ['possibly_missing_section', 'unbalanced_section'],
  },
];

/** Ce que WordFix ne peut pas vérifier : il faudrait Word et une pagination recalculée. */
const WORD_ONLY = [
  'Numéros de page du sommaire et pagination (dans Word : clic droit sur le sommaire, «\u00a0Mettre à jour les champs\u00a0»).',
  'Numérotation automatique des titres et des listes, telle que Word l’affiche.',
  'Renvois, légendes numérotées (figures, tableaux) et autres champs.',
  'Sauts de page et rendu à l’impression.',
];

type Status = { tone: 'done' | 'partial' | 'not' | 'unknown' | 'na'; text: string };

/** État réel d'un contrôle IA : jamais présenté comme fait s'il ne l'a pas été. */
function aiStatus(analysis: AnalysisDto, check: AiCheckKey): Status {
  if (analysis.warnings.includes('AI_DISABLED')) {
    return { tone: 'not', text: 'Non vérifié : analyse sans IA' };
  }
  const skipped = analysis.skippedAiChecks.find((item) => item.check === check);
  if (skipped && skipped.skipped >= skipped.total) {
    return { tone: 'not', text: 'Non vérifié : IA indisponible pendant l’analyse' };
  }
  if (skipped && skipped.skipped > 0) {
    return {
      tone: 'partial',
      text: `Contrôlé en partie (${skipped.total - skipped.skipped} sur ${skipped.total})`,
    };
  }
  return { tone: 'done', text: 'Contrôlé par l’IA' };
}

/**
 * « Mise en forme » : options appliquées au document téléchargé (typographie
 * française, harmonisation de la présentation ; aucun mot modifié) et vérification
 * de la structure du rapport, en distinguant les contrôles réellement faits, ceux qui
 * ne l'ont pas été et ceux qui nécessitent Word.
 */
export function FormattingPanel({
  analysis,
  issues,
  options,
  onChange,
  onShowStructure,
  structure: documentStructure,
}: {
  analysis: AnalysisDto;
  issues: IssueDto[];
  /** Présence des éléments de structure (API) ; absente ou `null` : inconnue. */
  structure?: DocumentStructureDto | null;
  options: ExportOptions;
  onChange: (options: ExportOptions) => void;
  /** Affiche les points de structure (panneau « Corriger », filtré). */
  onShowStructure: () => void;
}) {
  const structure = issues.filter((issue) => issue.category === 'structure');
  const count = (subtypes: IssueSubtype[]) =>
    structure.filter((issue) => subtypes.includes(issue.subtype as IssueSubtype)).length;

  return (
    <div className="space-y-6">
      <section aria-labelledby="formatting-options-title">
        <h3 id="formatting-options-title" className="text-ink font-semibold">
          Appliquée au document téléchargé
        </h3>
        <p className="text-ink-subtle mt-0.5 text-sm">
          Facultatif. Seuls les espaces et l’alignement changent : aucun mot n’est modifié (vérifié
          avant de produire le fichier).
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Option
            checked={options.typography}
            onChange={(typography) => onChange({ ...options, typography })}
            label={FORMATTING_LABELS.typography}
            help="Espaces insécables avant ; : ! ? et dans les guillemets « », espaces doubles supprimées. Adresses web, e-mails et code laissés tels quels."
          />
          <Option
            checked={options.layout}
            onChange={(layout) => onChange({ ...options, layout })}
            label={FORMATTING_LABELS.layout}
            help="Texte courant justifié, interligne 1,15 et 6 pt après chaque paragraphe. Titres, listes, tableaux et paragraphes centrés inchangés."
          />
        </div>
      </section>

      <section aria-labelledby="structure-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="structure-title" className="text-ink font-semibold">
            Vérification de la structure du rapport
          </h3>
          {structure.length > 0 ? (
            <button
              type="button"
              onClick={onShowStructure}
              className="text-brand-deep text-sm font-medium underline underline-offset-4"
            >
              {structure.length > 1
                ? `Voir les ${structure.length} points de structure`
                : 'Voir le point de structure'}
            </button>
          ) : null}
        </div>
        <ul className="border-hairline divide-hairline rounded-control mt-3 divide-y border text-sm">
          {ruleRows(analysis, documentStructure, count).map((row) => (
            <CheckRow key={row.label} label={row.label} detail={row.detail} status={row.status} />
          ))}
          {AI_CHECKS.map((item) => {
            const status = aiStatus(analysis, item.check);
            const found = count(item.subtypes);
            return (
              <CheckRow
                key={item.check}
                label={item.label}
                detail={
                  status.tone === 'not'
                    ? 'Ce contrôle demande une relecture par IA, qui n’a pas été faite pour ce document.'
                    : `${plural(found, 'point relevé', 'points relevés')} (hypothèses à confirmer par vous).`
                }
                status={status}
              />
            );
          })}
        </ul>
        <div className="border-hairline bg-canvas rounded-control mt-3 border px-4 py-3 text-sm">
          <p className="text-ink flex items-center gap-2 font-medium">
            <CircleMinus className="text-ink-subtle size-4 shrink-0" aria-hidden />
            Non vérifiable par WordFix : à contrôler dans Word
          </p>
          <ul className="text-ink-subtle mt-1.5 list-disc space-y-0.5 pl-10">
            {WORD_ONLY.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

const STATUS_STYLES: Record<Status['tone'], { icon: ReactNode; className: string }> = {
  done: {
    icon: <CircleCheck className="size-4 shrink-0" aria-hidden />,
    className: 'text-brand-deep',
  },
  partial: {
    icon: <TriangleAlert className="size-4 shrink-0" aria-hidden />,
    className: 'text-amber-800',
  },
  not: {
    icon: <CircleDashed className="size-4 shrink-0" aria-hidden />,
    className: 'text-ink-subtle',
  },
  unknown: {
    icon: <CircleHelp className="size-4 shrink-0" aria-hidden />,
    className: 'text-ink-subtle',
  },
  na: {
    icon: <CircleSlash className="size-4 shrink-0" aria-hidden />,
    className: 'text-ink-subtle',
  },
};

function CheckRow({ label, detail, status }: { label: string; detail: string; status: Status }) {
  const style = STATUS_STYLES[status.tone];
  return (
    <li className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-ink font-medium">{label}</p>
        <p className="text-ink-subtle text-xs">{detail}</p>
      </div>
      <p className={cn('flex shrink-0 items-center gap-1.5 text-xs font-medium', style.className)}>
        {style.icon}
        {status.text}
      </p>
    </li>
  );
}

function Option({
  checked,
  onChange,
  label,
  help,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  help: string;
}) {
  return (
    <label className="rounded-control has-[:checked]:border-brand has-[:checked]:bg-brand-soft/60 border-hairline hover:border-hairline-strong flex cursor-pointer items-start gap-3 border p-3 text-sm transition-colors">
      <input
        type="checkbox"
        className="accent-brand mt-0.5 size-4 shrink-0"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="text-ink font-medium">{label}</span>
        <span className="text-ink-subtle mt-0.5 block text-xs">{help}</span>
      </span>
    </label>
  );
}
