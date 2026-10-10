'use client';

import type { AnalysisDto, IssueNature } from '@wordfix/shared';
import { CATEGORY_LABELS, ISSUE_CATEGORIES } from '@wordfix/shared';
import { Info, Lightbulb, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Ring } from '@/components/ui/score-ring';
import { scoreScope, scoreSentence, skippedAiCheckText, WARNING_TEXTS } from '@/lib/copy';
import { formatNumber, formatPages } from '@/lib/format';
import { NATURE_ORDER, NATURES } from '@/lib/nature';
import { cn } from '@/lib/utils';

function advice(analysis: AnalysisDto): string {
  const { error, potential, verify } = analysis.natureCounts;
  if (analysis.issueCount === 0)
    return 'Aucun point relevé : relisez tout de même les passages importants.';
  if (error > 0) {
    return `Commencez par ${error === 1 ? 'l’erreur' : `les ${error} erreurs`} : ${error === 1 ? 'elle est sûre et rapide' : 'elles sont sûres et rapides'} à corriger.`;
  }
  if (potential > 0)
    return 'Examinez d’abord les points « à examiner » : ils touchent la cohérence du document.';
  if (verify > 0) return 'Il reste surtout des points à vérifier : vous seul pouvez trancher.';
  return 'Parcourez les suggestions : à vous de choisir celles qui améliorent votre texte.';
}

export function SummaryBand({
  analysis,
  activeNatures,
  onToggleNature,
}: {
  analysis: AnalysisDto;
  activeNatures: IssueNature[];
  onToggleNature: (nature: IssueNature) => void;
}) {
  const [showScore, setShowScore] = useState(false);
  // Analyse sans IA : le dire à côté du score, et en premier dans les avertissements.
  const aiDisabled = analysis.warnings.includes('AI_DISABLED');
  const warnings = [...analysis.warnings].sort(
    (a, b) => Number(b === 'AI_DISABLED') - Number(a === 'AI_DISABLED'),
  );
  const reviewed =
    analysis.issueCount === 0 ? 100 : (analysis.reviewedCount / analysis.issueCount) * 100;

  return (
    <section aria-label="Synthèse de l’analyse" className="grid gap-4 lg:grid-cols-[auto_1fr]">
      <div className="border-hairline bg-surface rounded-card flex items-center gap-5 border p-5 shadow-sm">
        <Ring
          value={analysis.score ?? 0}
          size={104}
          label={`${aiDisabled ? 'Score des vérifications automatiques, sans IA' : 'Score'} : ${analysis.score ?? 0} sur 100`}
        >
          <span>
            <span className="font-display text-ink block text-3xl font-bold">{analysis.score}</span>
            <span className="text-ink-subtle text-xs">sur 100</span>
          </span>
        </Ring>
        <div className="max-w-xs">
          {aiDisabled ? (
            <p className="mb-1 inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">
              Sans IA
            </p>
          ) : null}
          <p className="text-ink font-semibold">{scoreSentence(analysis.score ?? 0)}</p>
          <p className="text-ink-subtle mt-1 text-xs leading-relaxed">{scoreScope(aiDisabled)}</p>
          <button
            type="button"
            onClick={() => setShowScore((v) => !v)}
            aria-expanded={showScore}
            className="text-brand-deep mt-2 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4"
          >
            <Info className="size-3.5" aria-hidden />
            Comment est calculé ce score ?
          </button>
          {showScore && analysis.scoreDetail ? (
            <div className="text-ink-muted mt-2 text-xs">
              <p>
                100 moins une pénalité par catégorie, selon le nombre de problèmes pour 1 000 mots,
                leur nature et leur gravité. Les points « à vérifier » ne comptent pas.
              </p>
              <ul className="mt-1 grid grid-cols-2 gap-x-3">
                {ISSUE_CATEGORIES.map((c) => (
                  <li key={c}>
                    {CATEGORY_LABELS[c]} : −{analysis.scoreDetail?.penalties[c] ?? 0}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-hairline bg-surface rounded-card border p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="font-display text-ink min-w-0 text-xl font-semibold break-words">
            {analysis.documentName}
          </h1>
          <p className="text-ink-subtle text-sm">
            {formatPages(analysis.estimatedPages)} · {formatNumber(analysis.wordCount)} mots
          </p>
        </div>
        <div
          className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"
          role="group"
          aria-label="Filtrer par nature"
        >
          {NATURE_ORDER.map((key) => {
            const nature = NATURES[key];
            const Icon = nature.icon;
            const active = activeNatures.includes(key);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                onClick={() => onToggleNature(key)}
                title={nature.help}
                className={cn(
                  'rounded-control flex items-center gap-3 border px-3 py-2.5 text-left transition-colors',
                  active
                    ? cn(nature.border, nature.soft)
                    : 'border-hairline hover:border-hairline-strong',
                )}
              >
                <Icon className={cn('size-5 shrink-0', nature.text)} aria-hidden />
                <span>
                  <span className="font-display text-ink block text-xl leading-none font-bold">
                    {analysis.natureCounts[key]}
                  </span>
                  <span className="text-ink-subtle text-xs">{nature.plural}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-4">
          <div className="text-ink-subtle mb-1.5 flex justify-between text-xs">
            <span>Relecture</span>
            <span>
              {analysis.reviewedCount} / {analysis.issueCount} points traités
            </span>
          </div>
          <ProgressBar value={reviewed} label="Points traités" />
        </div>
        <p className="text-ink-muted mt-4 flex items-start gap-2 text-sm">
          <Lightbulb className="text-brand mt-0.5 size-4 shrink-0" aria-hidden />
          {advice(analysis)}
        </p>
      </div>

      {warnings.length > 0 ? (
        <ul className="space-y-2 lg:col-span-2">
          {warnings.map((warning) => (
            <li
              key={warning}
              className="rounded-control flex items-start gap-2 border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div>
                {WARNING_TEXTS[warning]}
                {warning === 'AI_CHECKS_SKIPPED' && analysis.skippedAiChecks.length > 0 ? (
                  <ul
                    className="mt-1.5 list-disc space-y-0.5 pl-4"
                    aria-label="Vérifications IA non effectuées"
                  >
                    {analysis.skippedAiChecks.map((item) => (
                      <li key={item.check}>{skippedAiCheckText(item)}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
