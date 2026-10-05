import type { IssueNature } from '@wordfix/shared';
import { NATURES } from '@/lib/nature';
import { cn } from '@/lib/utils';

type Segment = string | { text: string; nature: IssueNature; note: string };

/**
 * Exemple de relecture : un extrait de rapport annoté comme le fait WordFix.
 * C'est une illustration (explicitement présentée comme telle), pas un résultat.
 */
const SPECIMEN: Segment[] = [
  'Durant mon stage de ',
  { text: '3 mois', nature: 'potential', note: 'Page 21 : « six mois ». Laquelle est exacte ?' },
  ', j’ai participé à la migration des ',
  { text: 'serveurs informatique', nature: 'error', note: 'Accord : « serveurs informatiques ».' },
  '. ',
  {
    text: 'Cette solution permet de faire plusieurs choses qui sont nécessaires pour que le système puisse fonctionner.',
    nature: 'suggestion',
    note: 'Plus direct : « Cette solution assure le bon fonctionnement du système. »',
  },
  ' ',
  {
    text: 'Ensuite, le budget.',
    nature: 'verify',
    note: 'Passage abrupt : une transition serait-elle utile ?',
  },
];

export function AnnotatedSpecimen() {
  const notes = SPECIMEN.filter((segment) => typeof segment !== 'string');
  return (
    <figure className="border-hairline bg-surface rounded-card relative border p-6 shadow-sm sm:p-8">
      <figcaption className="text-ink-subtle mb-4 text-sm">
        Exemple de relecture d’un rapport de stage
      </figcaption>
      <p className="text-ink font-serif text-[17px] leading-8">
        {SPECIMEN.map((segment, index) =>
          typeof segment === 'string' ? (
            <span key={index}>{segment}</span>
          ) : (
            <mark
              key={index}
              className={cn(
                'rounded-sm border-b-2 bg-transparent px-0.5 text-inherit',
                NATURES[segment.nature].border,
                NATURES[segment.nature].soft,
              )}
            >
              {segment.text}
            </mark>
          ),
        )}
      </p>
      <ul className="border-hairline mt-6 space-y-3 border-t pt-5">
        {notes.map((segment) => {
          const nature = NATURES[segment.nature];
          const Icon = nature.icon;
          return (
            <li key={segment.text} className="flex gap-3 text-sm">
              <Icon className={cn('mt-0.5 size-4 shrink-0', nature.text)} aria-hidden />
              <span>
                <span className={cn('font-semibold', nature.text)}>{nature.label}.</span>{' '}
                <span className="text-ink-muted">{segment.note}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
