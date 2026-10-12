'use client';

import { type AnalysisDto, type IssueDto, isReliableCorrection } from '@wordfix/shared';
import { CircleCheck } from 'lucide-react';
import { needsManualCheck } from './export-panel';
import {
  applyFilters,
  CATEGORY_FILTERS,
  type CategoryFilterKey,
  DEFAULT_FILTERS,
  isDone,
} from './filtering';
import { AnalysisWarnings } from './summary-band';

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * « Informations sur l'analyse » : avertissements de l'analyse, puis problèmes
 * détectés par catégorie et par type (chiffres tirés de la liste réelle des points),
 * avec un accès direct aux points concernés dans « Corriger ».
 */
export function AnalysisInfoPanel({
  analysis,
  issues,
  onShowCategory,
}: {
  analysis: AnalysisDto;
  issues: IssueDto[];
  onShowCategory: (category: CategoryFilterKey) => void;
}) {
  const reliable = issues.filter(isReliableCorrection).length;
  const manual = issues.filter(needsManualCheck).length;
  const done = issues.filter(isDone).length;
  const others = issues.length - reliable - manual - done;
  const categories = CATEGORY_FILTERS.filter((filter) => filter.key !== 'all').map((filter) => {
    const all = applyFilters(issues, { ...DEFAULT_FILTERS, view: 'all', category: filter.key });
    return { ...filter, total: all.length, open: all.filter((issue) => !isDone(issue)).length };
  });

  return (
    <div className="space-y-6">
      <section aria-labelledby="warnings-title">
        <h3 id="warnings-title" className="text-ink font-semibold">
          Avertissements
        </h3>
        {analysis.warnings.length > 0 ? (
          <AnalysisWarnings analysis={analysis} className="mt-2" />
        ) : (
          <p className="text-ink-subtle mt-1 flex items-center gap-2 text-sm">
            <CircleCheck className="text-brand size-4" aria-hidden />
            Aucun avertissement pour cette analyse.
          </p>
        )}
      </section>

      <section aria-labelledby="problems-title">
        <h3 id="problems-title" className="text-ink font-semibold">
          Problèmes détectés
        </h3>
        {issues.length === 0 ? (
          <p className="text-ink-subtle mt-1 text-sm">
            WordFix n’a relevé aucun point dans ce document.
          </p>
        ) : (
          <>
            <ul className="mt-2 grid gap-2 text-sm sm:grid-cols-2" aria-label="Par type">
              <Figure
                value={reliable}
                label={`${reliable > 1 ? 'corrections fiables, applicables' : 'correction fiable, applicable'} avec «\u00a0Tout corriger\u00a0»`}
              />
              <Figure
                value={manual}
                label={`${manual > 1 ? 'points à vérifier manuellement (jamais appliqués' : 'point à vérifier manuellement (jamais appliqué'} d’office)`}
              />
              <Figure
                value={others}
                label={`${others > 1 ? 'autres suggestions' : 'autre suggestion'} à accepter ou ignorer au choix`}
              />
              <Figure value={done} label={done > 1 ? 'points déjà traités' : 'point déjà traité'} />
            </ul>
            <table className="mt-3 w-full text-sm">
              <caption className="sr-only">Problèmes détectés par catégorie</caption>
              <thead>
                <tr className="text-ink-subtle border-hairline border-b text-left text-xs">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Catégorie
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Relevés
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    À traiter
                  </th>
                  <th scope="col" className="py-2 pl-4">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-hairline divide-y">
                {categories.map((category) => (
                  <tr key={category.key}>
                    <th scope="row" className="text-ink py-2 pr-4 text-left font-medium">
                      {category.label}
                    </th>
                    <td className="px-4 py-2 text-right tabular-nums">{category.total}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{category.open}</td>
                    <td className="py-2 pl-4 text-right">
                      {category.total > 0 ? (
                        <button
                          type="button"
                          onClick={() => onShowCategory(category.key)}
                          className="text-brand-deep font-medium underline underline-offset-4"
                          aria-label={`Voir les points : ${category.label}`}
                        >
                          Voir
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-ink-subtle mt-2 text-xs">
              {plural(issues.length, 'point relevé', 'points relevés')} au total. Les numéros de
              page indiqués pour chaque point sont estimés : WordFix ne recalcule pas la pagination
              de Word.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <li className="border-hairline rounded-control flex items-baseline gap-2 border px-3 py-2">
      <span className="font-display text-ink text-lg font-bold tabular-nums">{value}</span>
      <span className="text-ink-subtle">{label}</span>
    </li>
  );
}
